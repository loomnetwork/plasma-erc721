package client

import (
	"bytes"
	"fmt"
	"strconv"
	"sync"
	"time"

	"sync/atomic"

	"github.com/gogo/protobuf/jsonpb"
	"github.com/gogo/protobuf/proto"
	"github.com/gorilla/websocket"
	"github.com/loomnetwork/go-loom"
	ptypes "github.com/loomnetwork/go-loom/builtin/types/plasma_cash"
	loom_client "github.com/loomnetwork/go-loom/client"
	lptypes "github.com/loomnetwork/go-loom/plugin/types"
	"github.com/phonkee/go-pubsub"
	"github.com/pkg/errors"
)

const (
	SubmitBlockConfirmedEventTopic = "pcash:submitblockconfirmed"
	ExitConfirmedEventTopic        = "pcash:exitconfirmed"
	WithdrawConfirmedEventTopic    = "pcash:withdrawconfirmed"
	ResetConfirmedEventTopic       = "pcash:resetconfirmed"
	DepositConfirmedEventTopic     = "pcash:depositconfirmed"

	DefaultPingInterval         = 10 * time.Second
	DefaultPingDeadlineDuration = 10 * time.Second
)

func isInSet(set []string, element string) bool {
	found := false
	for _, member := range set {
		if member == element {
			found = true
			break
		}
	}

	return found

}

type quitChCircularBuffer struct {
	storage        []chan struct{}
	fetchIndex     int
	addIndex       int
	filledElements int

	mutex sync.Mutex
}

func newQuitChCircularBuffer(numberOfChannels int) *quitChCircularBuffer {
	storage := make([]chan struct{}, numberOfChannels)

	return &quitChCircularBuffer{
		storage:        storage,
		fetchIndex:     0,
		addIndex:       0,
		filledElements: 0,
		mutex:          sync.Mutex{},
	}
}

func (q *quitChCircularBuffer) DeQueue() (chan struct{}, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	if q.filledElements == 0 {
		return nil, fmt.Errorf("nothing to fetch")
	}

	if q.fetchIndex == len(q.storage) {
		q.fetchIndex = 0
	}

	quitChan := q.storage[q.fetchIndex]
	q.fetchIndex++
	q.filledElements--

	return quitChan, nil
}

func (q *quitChCircularBuffer) Peek() (chan struct{}, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	if q.filledElements == 0 {
		return nil, fmt.Errorf("nothing to fetch")
	}

	if q.addIndex == len(q.storage) {
		q.addIndex = 0
	}

	quitChan := q.storage[q.addIndex]
	return quitChan, nil
}

func (q *quitChCircularBuffer) Elements() int {
	return q.filledElements
}

func (q *quitChCircularBuffer) Queue(quitCh chan struct{}) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	if q.filledElements == len(q.storage) {
		return fmt.Errorf("overflow")
	}

	if q.addIndex == len(q.storage) {
		q.addIndex = 0
	}

	q.storage[q.addIndex] = quitCh
	q.addIndex++
	q.filledElements++

	return nil
}

type DAppEventSubscription struct {
	subscriber pubsub.Subscriber
	closeFn    func()
}

func (es *DAppEventSubscription) Close() {
	es.subscriber.Close()
	es.closeFn()
}

type DAppChainEventClient struct {
	ws                 *websocket.Conn
	nextMsgID          uint64
	chainEventQuitCh   chan struct{}
	chainEventSubCount int
	chainEventHub      pubsub.Hub

	Address loom.Address

	// To prevent infinite growth of go routines in case user
	// does not actively consume events or they can pile up
	// in case program is long running

	// Maximum allowed active go routines
	maxActiveGoRoutines uint64

	// Currently active go routines
	activeGoRoutinesCounter uint64

	// Go routines per batch, all of which shares same quit channel
	goRoutinesPerBatch uint64

	// Number of go routines spawned
	goRoutinesSpawnedInBatch uint64

	// Circular buffer storing quit channel for all past batches upto maxActiveGoRoutines divided by goRoutinesPerBatch
	goRoutinesQuitChannels *quitChCircularBuffer

	// mutex to lock a go routine modifying management variables
	goRoutineMgmtMutex sync.Mutex
}

func NewDAppChainEventClient(contractAddr loom.Address, eventsURI string) (*DAppChainEventClient, error) {
	var ws *websocket.Conn

	if eventsURI == "" {
		return nil, fmt.Errorf("event uri cannot be empty")
	}

	ws, _, err := websocket.DefaultDialer.Dial(eventsURI, nil)
	if err != nil {
		return nil, err
	}

	return &DAppChainEventClient{
		ws:      ws,
		Address: contractAddr,

		// TODO: Take these params as arguments and validate them
		maxActiveGoRoutines:    100,
		goRoutinesPerBatch:     10,
		goRoutinesQuitChannels: newQuitChCircularBuffer(10),
		goRoutineMgmtMutex:     sync.Mutex{},
	}, nil
}

func (d *DAppChainEventClient) WatchTopic(topic string, sink chan<- *lptypes.EventData) (*DAppEventSubscription, error) {
	if d.ws == nil {
		return nil, errors.New("websocket events unavailable")
	}

	if err := d.subChainEvents(); err != nil {
		return nil, err
	}

	sub := d.chainEventHub.Subscribe("event")
	sub.Do(func(msg pubsub.Message) {
		ev := lptypes.EventData{}
		if err := proto.Unmarshal(msg.Body(), &ev); err != nil {
			return
		}

		if ev.Topics == nil || !isInSet(ev.Topics, topic) {
			return
		}

		contractAddr := loom.UnmarshalAddressPB(ev.Address)
		if contractAddr.Compare(d.Address) != 0 {
			return
		}

		var quitChan chan struct{}

		d.goRoutineMgmtMutex.Lock()
		defer d.goRoutineMgmtMutex.Unlock()

		// if it is multiple of go routines per batch, it means we need to create new
		// quit channel for next batch
		if d.goRoutinesSpawnedInBatch%d.goRoutinesPerBatch == 0 {
			d.goRoutinesSpawnedInBatch = 0
			quitChan = make(chan struct{})
			if err := d.goRoutinesQuitChannels.Queue(quitChan); err != nil {
				// All batches are full.
				olderQuitChan, err := d.goRoutinesQuitChannels.DeQueue()
				if err != nil {
					fmt.Println("unexpected error while removing quitChan from circular buffer")
					return
				}
				close(olderQuitChan)
				return
			}
			// Else if we are middle in the batch, just read quit channel for that batch.
		} else {
			var err error
			quitChan, err = d.goRoutinesQuitChannels.Peek()
			if err != nil {
				fmt.Println("unexpected error while peeking quitChan from circular buffer")
				return
			}
		}

		d.goRoutinesSpawnedInBatch++
		d.activeGoRoutinesCounter++

		go func(q chan struct{}) {
			select {
			case sink <- &ev:
				break
			case <-q:
				break
			}
			atomic.AddUint64(&d.activeGoRoutinesCounter, ^uint64(0))
		}(quitChan)

	})

	return &DAppEventSubscription{
		subscriber: sub,
		closeFn:    d.unsubChainEvents,
	}, nil
}

func (d *DAppChainEventClient) subChainEvents() error {
	d.chainEventSubCount++
	if d.chainEventSubCount > 1 {
		return nil // already subscribed
	}

	err := d.ws.WriteJSON(&loom_client.RPCRequest{
		Version: "2.0",
		Method:  "subevents",
		ID:      strconv.FormatUint(d.nextMsgID, 10),
	})
	d.nextMsgID++

	if err != nil {
		return errors.Wrap(err, "failed to subscribe to DAppChain events")
	}

	resp := loom_client.RPCResponse{}
	if err = d.ws.ReadJSON(&resp); err != nil {
		return errors.Wrap(err, "failed to subscribe to DAppChain events")
	}
	if resp.Error != nil {
		return errors.Wrap(resp.Error, "failed to subscribe to DAppChain events")
	}

	d.chainEventHub = pubsub.New()
	d.chainEventQuitCh = make(chan struct{})

	go pumpChainEvents(d.ws, d.chainEventHub, DefaultPingInterval, DefaultPingDeadlineDuration, d.chainEventQuitCh)

	return nil
}

func (d *DAppChainEventClient) unsubChainEvents() {
	d.chainEventSubCount--
	if d.chainEventSubCount > 0 {
		return // still have subscribers
	}

	close(d.chainEventQuitCh)

	d.ws.WriteJSON(&loom_client.RPCRequest{
		Version: "2.0",
		Method:  "unsubevents",
		ID:      strconv.FormatUint(d.nextMsgID, 10),
	})
	d.nextMsgID++
}

func pumpChainEvents(ws *websocket.Conn, hub pubsub.Hub, interval time.Duration, timeout time.Duration, quit <-chan struct{}) {
	pingTimer := time.NewTimer(interval)
	for {
		select {
		case <-pingTimer.C:
			if err := ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(timeout)); err != nil {
				fmt.Printf("error in sending a ping, will retry in next iteration")
			}
			break
		case <-quit:
			return
		default:
			resp := loom_client.RPCResponse{}
			if err := ws.ReadJSON(&resp); err != nil {
				panic(err)
			}
			if resp.Error != nil {
				panic(resp.Error)
			}
			unmarshaller := jsonpb.Unmarshaler{}
			reader := bytes.NewBuffer(resp.Result)
			eventData := lptypes.EventData{}
			if err := unmarshaller.Unmarshal(reader, &eventData); err != nil {
				panic(err)
			}
			bytes, err := proto.Marshal(&eventData)
			if err != nil {
				panic(err)
			}
			hub.Publish(pubsub.NewMessage("event", bytes))
		}
	}
}

type PlasmaEventSubscription struct {
	quitChan chan<- struct{}
}

func (p *PlasmaEventSubscription) Close() {
	close(p.quitChan)
}

type PlasmaCashEventClient struct {
	eventClient DAppChainEventClient
}

func NewPlasmaCashEventClient(contractAddr loom.Address, eventsURI string) (*PlasmaCashEventClient, error) {
	dappchainClient, err := NewDAppChainEventClient(contractAddr, eventsURI)
	if err != nil {
		return nil, errors.Wrapf(err, "error while getting new instance of dappchain event client")
	}

	return &PlasmaCashEventClient{eventClient: *dappchainClient}, nil
}

func (d *PlasmaCashEventClient) WatchWithdrawConfirmedEvent(
	sink chan<- *ptypes.PlasmaCashWithdrawConfirmedEvent) (*PlasmaEventSubscription, error) {

	eventSink := make(chan *lptypes.EventData)
	quitChan := make(chan struct{})

	eventSub, err := d.eventClient.WatchTopic(WithdrawConfirmedEventTopic, eventSink)
	if err != nil {
		return nil, err
	}

	go func(quitChan chan struct{}, eventSub *DAppEventSubscription) {
		for {
			select {
			case <-quitChan:
				eventSub.Close()
				return
			case event := <-eventSink:
				payload := ptypes.PlasmaCashWithdrawConfirmedEvent{}
				if err := proto.Unmarshal(event.EncodedBody, &payload); err != nil {
					return
				}
				sink <- &payload
			}
		}
	}(quitChan, eventSub)

	return &PlasmaEventSubscription{quitChan: quitChan}, err
}

func (d *PlasmaCashEventClient) WatchExitConfirmedEvent(
	sink chan<- *ptypes.PlasmaCashExitConfirmedEvent) (*PlasmaEventSubscription, error) {

	eventSink := make(chan *lptypes.EventData)
	quitChan := make(chan struct{})

	eventSub, err := d.eventClient.WatchTopic(ExitConfirmedEventTopic, eventSink)
	if err != nil {
		return nil, err
	}

	go func(quitChan chan struct{}, eventSub *DAppEventSubscription) {
		for {
			select {
			case <-quitChan:
				eventSub.Close()
				return
			case event := <-eventSink:
				payload := ptypes.PlasmaCashExitConfirmedEvent{}
				if err := proto.Unmarshal(event.EncodedBody, &payload); err != nil {
					return
				}
				sink <- &payload
			}
		}
	}(quitChan, eventSub)

	return &PlasmaEventSubscription{quitChan: quitChan}, err
}

func (d *PlasmaCashEventClient) WatchDepositConfirmedEvent(
	sink chan<- *ptypes.PlasmaCashDepositConfirmedEvent) (*PlasmaEventSubscription, error) {

	eventSink := make(chan *lptypes.EventData)
	quitChan := make(chan struct{})

	eventSub, err := d.eventClient.WatchTopic(DepositConfirmedEventTopic, eventSink)
	if err != nil {
		return nil, err
	}

	go func(quitChan chan struct{}, eventSub *DAppEventSubscription) {
		for {
			select {
			case <-quitChan:
				eventSub.Close()
				return
			case event := <-eventSink:
				payload := ptypes.PlasmaCashDepositConfirmedEvent{}
				if err := proto.Unmarshal(event.EncodedBody, &payload); err != nil {
					return
				}
				sink <- &payload
			}
		}
	}(quitChan, eventSub)

	return &PlasmaEventSubscription{quitChan: quitChan}, err
}

func (d *PlasmaCashEventClient) WatchSubmitBlockConfirmedEvent(
	sink chan<- *ptypes.PlasmaCashSubmitBlockConfirmedEvent) (*PlasmaEventSubscription, error) {

	eventSink := make(chan *lptypes.EventData)
	quitChan := make(chan struct{})

	eventSub, err := d.eventClient.WatchTopic(SubmitBlockConfirmedEventTopic, eventSink)
	if err != nil {
		return nil, err
	}

	go func(quitChan chan struct{}, eventSub *DAppEventSubscription) {
		for {
			select {
			case <-quitChan:
				eventSub.Close()
				return
			case event := <-eventSink:
				payload := ptypes.PlasmaCashSubmitBlockConfirmedEvent{}
				if err := proto.Unmarshal(event.EncodedBody, &payload); err != nil {
					return
				}
				sink <- &payload
			}
		}
	}(quitChan, eventSub)

	return &PlasmaEventSubscription{quitChan: quitChan}, err
}
