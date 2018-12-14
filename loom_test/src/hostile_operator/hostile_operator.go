package hostile_operator

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strconv"

	"github.com/ethereum/go-ethereum/crypto/sha3"
	"github.com/ethereum/go-ethereum/rlp"
	loom "github.com/loomnetwork/go-loom"
	pctypes "github.com/loomnetwork/go-loom/builtin/types/plasma_cash"
	"github.com/loomnetwork/go-loom/common"
	"github.com/loomnetwork/go-loom/common/evmcompat"
	"github.com/loomnetwork/go-loom/plugin"
	contract "github.com/loomnetwork/go-loom/plugin/contractpb"
	"github.com/loomnetwork/go-loom/types"
	"github.com/loomnetwork/go-loom/util"
	"github.com/loomnetwork/mamamerkle"
	"github.com/pkg/errors"
)

type (
	InitRequest                  = pctypes.PlasmaCashInitRequest
	SubmitBlockToMainnetRequest  = pctypes.SubmitBlockToMainnetRequest
	SubmitBlockToMainnetResponse = pctypes.SubmitBlockToMainnetResponse
	Coin                         = pctypes.PlasmaCashCoin
	CoinState                    = pctypes.PlasmaCashCoinState
	GetBlockRequest              = pctypes.GetBlockRequest
	GetBlockResponse             = pctypes.GetBlockResponse
	PlasmaTxRequest              = pctypes.PlasmaTxRequest
	PlasmaTxResponse             = pctypes.PlasmaTxResponse
	DepositRequest               = pctypes.DepositRequest
	PlasmaTx                     = pctypes.PlasmaTx
	GetCurrentBlockResponse      = pctypes.GetCurrentBlockResponse
	GetCurrentBlockRequest       = pctypes.GetCurrentBlockRequest
	PlasmaBookKeeping            = pctypes.PlasmaBookKeeping
	PlasmaBlock                  = pctypes.PlasmaBlock
	PendingTxs                   = pctypes.PendingTxs
	Account                      = pctypes.PlasmaCashAccount
	GetPlasmaTxRequest           = pctypes.GetPlasmaTxRequest
	GetPlasmaTxResponse          = pctypes.GetPlasmaTxResponse
	GetUserSlotsRequest          = pctypes.GetUserSlotsRequest
	GetUserSlotsResponse         = pctypes.GetUserSlotsResponse

	CoinResetRequest    = pctypes.PlasmaCashCoinResetRequest
	ExitCoinRequest     = pctypes.PlasmaCashExitCoinRequest
	WithdrawCoinRequest = pctypes.PlasmaCashWithdrawCoinRequest

	GetPendingTxsRequest = pctypes.GetPendingTxsRequest

	RequestBatchTally = pctypes.PlasmaCashRequestBatchTally

	GetRequestBatchTallyRequest = pctypes.PlasmaCashGetRequestBatchTallyRequest
)

// HostileOperator is a DAppChain Go Contract that handles Plasma Cash txs in a way that allows
// entities to double spend Plasma coins. This is useful to verify that clients can challenge
// invalid transfers of coins. A real Plasma Cash operator would never allow such coin transfers to
// go through in the first place.
type HostileOperator struct {
}

const (
	CoinState_DEPOSITED  = pctypes.PlasmaCashCoinState_DEPOSITED
	CoinState_EXITING    = pctypes.PlasmaCashCoinState_EXITING
	CoinState_CHALLENGED = pctypes.PlasmaCashCoinState_CHALLENGED
	CoinState_EXITED     = pctypes.PlasmaCashCoinState_EXITED
)

var (
	blockHeightKey    = []byte("pcash_height")
	pendingTXsKey     = []byte("pcash_pending")
	accountKeyPrefix  = []byte("account")
	plasmaMerkleTopic = "pcash_mainnet_merkle"
)

func requestBatchTallyKey() []byte {
	return []byte("request_batch_tally")
}

func coinKey(slot uint64) []byte {
	var buf bytes.Buffer
	binary.Write(&buf, binary.BigEndian, slot)
	return util.PrefixKey([]byte("coin"), buf.Bytes())
}

func accountKey(addr loom.Address) []byte {
	return util.PrefixKey(accountKeyPrefix, addr.Bytes())
}

func blockKey(height common.BigUInt) []byte {
	return util.PrefixKey([]byte("pcash_block_"), []byte(height.String()))
}

func (c *HostileOperator) Meta() (plugin.Meta, error) {
	return plugin.Meta{
		Name:    "hostileoperator",
		Version: "1.0.0",
	}, nil
}

func (c *HostileOperator) GetRequestBatchTally(ctx contract.StaticContext, req *GetRequestBatchTallyRequest) (*RequestBatchTally, error) {
	tally := &RequestBatchTally{}

	if err := ctx.Get(requestBatchTallyKey(), tally); err != nil {
		if err == contract.ErrNotFound {
			return tally, nil
		}
		return nil, errors.Wrapf(err, "error while getting request batch tally")
	}

	return tally, nil
}

func (c *HostileOperator) Init(ctx contract.Context, req *InitRequest) error {
	ctx.Set(blockHeightKey, &PlasmaBookKeeping{CurrentHeight: &types.BigUInt{
		Value: *loom.NewBigUIntFromInt(0),
	}})

	return nil
}

func round(num, near int64) int64 {
	if num == 0 {
		return near
	}
	if num%near == 0 { //we always want next value
		return num + near
	}
	return ((num + (near - 1)) / near) * near
}

func (c *HostileOperator) GetPendingTxs(ctx contract.StaticContext, req *GetPendingTxsRequest) (*PendingTxs, error) {
	pending := &PendingTxs{}

	if err := ctx.Get(pendingTXsKey, pending); err != nil {
		if err != contract.ErrNotFound {
			return nil, err
		}
		return pending, nil
	}

	return pending, nil
}

func (c *HostileOperator) ProcessRequestBatch(ctx contract.Context, req *pctypes.PlasmaCashRequestBatch) error {

	// No requests to process
	if len(req.Requests) == 0 {
		return nil
	}

	requestBatchTally := pctypes.PlasmaCashRequestBatchTally{}
	if err := ctx.Get(requestBatchTallyKey(), &requestBatchTally); err != nil {
		if err != contract.ErrNotFound {
			return errors.Wrapf(err, "unable to retrieve event batch tally")
		}
	}

	// We have already consumed all the events being offered.
	lastRequest := req.Requests[len(req.Requests)-1]
	if isRequestAlreadySeen(lastRequest.Meta, &requestBatchTally) {
		return nil
	}

	var err error

loop:
	for _, request := range req.Requests {
		switch data := request.Data.(type) {
		case *pctypes.PlasmaCashRequest_Deposit:
			if isRequestAlreadySeen(request.Meta, &requestBatchTally) {
				break
			}

			err = c.depositRequest(ctx, data.Deposit)
			if err != nil {
				break loop
			}

			requestBatchTally.LastSeenBlockNumber = request.Meta.BlockNumber
			requestBatchTally.LastSeenTxIndex = request.Meta.TxIndex
			requestBatchTally.LastSeenLogIndex = request.Meta.LogIndex

		case *pctypes.PlasmaCashRequest_CoinReset:
			if isRequestAlreadySeen(request.Meta, &requestBatchTally) {
				break
			}

			err = c.coinReset(ctx, data.CoinReset)
			if err != nil {
				break loop
			}

			requestBatchTally.LastSeenBlockNumber = request.Meta.BlockNumber
			requestBatchTally.LastSeenTxIndex = request.Meta.TxIndex
			requestBatchTally.LastSeenLogIndex = request.Meta.LogIndex

		case *pctypes.PlasmaCashRequest_StartedExit:
			if isRequestAlreadySeen(request.Meta, &requestBatchTally) {
				break
			}

			err = c.exitCoin(ctx, data.StartedExit)
			if err != nil {
				break loop
			}

			requestBatchTally.LastSeenBlockNumber = request.Meta.BlockNumber
			requestBatchTally.LastSeenTxIndex = request.Meta.TxIndex
			requestBatchTally.LastSeenLogIndex = request.Meta.LogIndex

		case *pctypes.PlasmaCashRequest_Withdraw:
			if isRequestAlreadySeen(request.Meta, &requestBatchTally) {
				break
			}

			err = c.withdrawCoin(ctx, data.Withdraw)
			if err != nil {
				break loop
			}

			requestBatchTally.LastSeenBlockNumber = request.Meta.BlockNumber
			requestBatchTally.LastSeenTxIndex = request.Meta.TxIndex
			requestBatchTally.LastSeenLogIndex = request.Meta.LogIndex
		}
	}

	if err != nil {
		return errors.Wrapf(err, "unable to consume one or more requests")
	}

	if err = ctx.Set(requestBatchTallyKey(), &requestBatchTally); err != nil {
		return errors.Wrapf(err, "unable to save request batch tally")
	}

	return err
}

func (c *HostileOperator) SubmitBlockToMainnet(ctx contract.Context, req *SubmitBlockToMainnetRequest) (*SubmitBlockToMainnetResponse, error) {
	pbk := &PlasmaBookKeeping{}
	ctx.Get(blockHeightKey, pbk)

	// round to nearest 1000
	roundedInt := round(pbk.CurrentHeight.Value.Int64(), 1000)
	pbk.CurrentHeight.Value = *loom.NewBigUIntFromInt(roundedInt)

	pending := &PendingTxs{}
	ctx.Get(pendingTXsKey, pending)

	leaves := make(map[uint64][]byte)
	if len(pending.Transactions) == 0 {
		ctx.Logger().Warn("No pending transaction, returning")
		return &SubmitBlockToMainnetResponse{}, nil
	} else {
		ctx.Logger().Warn("Pending transactions, raising blockheight")
		ctx.Set(blockHeightKey, pbk)
	}

	for _, v := range pending.Transactions {
		if v.PreviousBlock == nil || v.PreviousBlock.Value.Int64() == int64(0) {
			hash, err := soliditySha3(v.Slot)
			if err != nil {
				return nil, err
			}
			v.MerkleHash = hash
		} else {
			hash, err := rlpEncodeWithSha3(v)
			if err != nil {
				return nil, err
			}
			v.MerkleHash = hash
		}

		leaves[v.Slot] = v.MerkleHash
	}

	smt, err := mamamerkle.NewSparseMerkleTree(64, leaves)
	if err != nil {
		return nil, err
	}

	for _, v := range pending.Transactions {
		v.Proof = smt.CreateMerkleProof(v.Slot)
	}

	merkleHash := smt.Root()

	pb := &PlasmaBlock{
		MerkleHash:   merkleHash,
		Transactions: pending.Transactions,
		Uid:          pbk.CurrentHeight,
	}
	err = ctx.Set(blockKey(pbk.CurrentHeight.Value), pb)
	if err != nil {
		return nil, err
	}

	ctx.EmitTopics(merkleHash, plasmaMerkleTopic)

	// Clear out old pending transactions
	err = ctx.Set(pendingTXsKey, &PendingTxs{})
	if err != nil {
		return nil, err
	}

	return &SubmitBlockToMainnetResponse{MerkleHash: merkleHash}, nil
}

func (c *HostileOperator) PlasmaTxRequest(ctx contract.Context, req *PlasmaTxRequest) error {
	pending := &PendingTxs{}
	ctx.Get(pendingTXsKey, pending)
	for _, v := range pending.Transactions {
		if v.Slot == req.Plasmatx.Slot {
			return fmt.Errorf("Error appending plasma transaction with existing slot -%d", v.Slot)
		}
	}
	pending.Transactions = append(pending.Transactions, req.Plasmatx)

	return ctx.Set(pendingTXsKey, pending)
}

func (c *HostileOperator) depositRequest(ctx contract.Context, req *DepositRequest) error {
	fmt.Printf("Inside DepositRequestDepositRequest- %v\n", req)

	pbk := &PlasmaBookKeeping{}
	ctx.Get(blockHeightKey, pbk)

	pending := &PendingTxs{}
	ctx.Get(pendingTXsKey, pending)

	// create a new deposit block for the deposit event
	tx := &PlasmaTx{
		Slot:         req.Slot,
		Denomination: req.Denomination,
		NewOwner:     req.From,
		Proof:        make([]byte, 8),
	}

	pb := &PlasmaBlock{
		Transactions: []*PlasmaTx{tx},
		Uid:          req.DepositBlock,
	}

	err := ctx.Set(blockKey(req.DepositBlock.Value), pb)
	if err != nil {
		return err
	}

	defaultErrMsg := "[PlasmaCash] failed to process deposit"
	// Update the sender's local Plasma account to reflect the deposit
	ownerAddr := loom.UnmarshalAddressPB(req.From)
	ctx.Logger().Debug(fmt.Sprintf("Deposit %v from %v", req.Slot, ownerAddr))
	account, err := loadAccount(ctx, ownerAddr)
	if err != nil {
		return errors.Wrap(err, defaultErrMsg)
	}
	err = saveCoin(ctx, &Coin{
		Slot:     req.Slot,
		State:    CoinState_DEPOSITED,
		Token:    req.Denomination,
		Contract: req.Contract,
	})
	if err != nil {
		return errors.Wrap(err, defaultErrMsg)
	}
	account.Slots = append(account.Slots, req.Slot)
	if err = saveAccount(ctx, account); err != nil {
		return errors.Wrap(err, defaultErrMsg)
	}

	if req.DepositBlock.Value.Cmp(&pbk.CurrentHeight.Value) > 0 {
		pbk.CurrentHeight.Value = req.DepositBlock.Value
		return ctx.Set(blockHeightKey, pbk)
	}
	return nil
}

func saveCoin(ctx contract.Context, coin *Coin) error {
	if err := ctx.Set(coinKey(coin.Slot), coin); err != nil {
		return errors.Wrapf(err, "failed to save coin %v", coin.Slot)
	}
	return nil
}

func saveAccount(ctx contract.Context, acct *Account) error {
	owner := loom.UnmarshalAddressPB(acct.Owner)
	return ctx.Set(accountKey(owner), acct)
}

func (c *HostileOperator) GetCurrentBlockRequest(ctx contract.StaticContext, req *GetCurrentBlockRequest) (*GetCurrentBlockResponse, error) {
	pbk := &PlasmaBookKeeping{}
	ctx.Get(blockHeightKey, pbk)
	return &GetCurrentBlockResponse{BlockHeight: pbk.CurrentHeight}, nil
}

func (c *HostileOperator) GetBlockRequest(ctx contract.StaticContext, req *GetBlockRequest) (*GetBlockResponse, error) {
	pb := &PlasmaBlock{}

	err := ctx.Get(blockKey(req.BlockHeight.Value), pb)
	if err != nil {
		return nil, err
	}

	return &GetBlockResponse{Block: pb}, nil
}

func (c *HostileOperator) GetUserSlotsRequest(ctx contract.StaticContext, req *GetUserSlotsRequest) (*GetUserSlotsResponse, error) {
	if req.From == nil {
		return nil, fmt.Errorf("invalid account parameter")
	}
	reqAcct, err := loadAccount(ctx, loom.UnmarshalAddressPB(req.From))
	if err != nil {
		return nil, err
	}
	res := &GetUserSlotsResponse{}
	res.Slots = reqAcct.Slots

	return res, nil
}

// Dummy method
func (c *HostileOperator) coinReset(ctc contract.Context, req *CoinResetRequest) error {
	return nil
}

func (c *HostileOperator) exitCoin(ctc contract.Context, req *ExitCoinRequest) error {
	return nil
}

func (c *HostileOperator) withdrawCoin(ctx contract.Context, req *WithdrawCoinRequest) error {
	return nil
}

func (c *HostileOperator) GetPlasmaTxRequest(ctx contract.StaticContext, req *GetPlasmaTxRequest) (*GetPlasmaTxResponse, error) {
	pb := &PlasmaBlock{}

	if req.BlockHeight == nil {
		return nil, fmt.Errorf("invalid BlockHeight")
	}

	err := ctx.Get(blockKey(req.BlockHeight.Value), pb)
	if err != nil {
		return nil, err
	}

	leaves := make(map[uint64][]byte)
	tx := &PlasmaTx{}
	for _, v := range pb.Transactions {
		// Merklize tx set
		leaves[v.Slot] = v.MerkleHash
		// Save the tx matched
		if v.Slot == req.Slot {
			tx = v
		}
	}

	// Create SMT
	smt, err := mamamerkle.NewSparseMerkleTree(64, leaves)
	if err != nil {
		return nil, err
	}

	tx.Proof = smt.CreateMerkleProof(req.Slot)

	res := &GetPlasmaTxResponse{
		Plasmatx: tx,
	}

	return res, nil
}

func loadAccount(ctx contract.StaticContext, owner loom.Address) (*Account, error) {
	acct := &Account{
		Owner: owner.MarshalPB(),
	}
	err := ctx.Get(accountKey(owner), acct)
	if err != nil && err != contract.ErrNotFound {
		return nil, err
	}

	return acct, nil
}

func soliditySha3(data uint64) ([]byte, error) {
	pairs := []*evmcompat.Pair{&evmcompat.Pair{"uint64", strconv.FormatUint(data, 10)}}
	hash, err := evmcompat.SoliditySHA3(pairs)
	if err != nil {
		return []byte{}, err
	}
	return hash, err
}

func rlpEncodeWithSha3(pb *PlasmaTx) ([]byte, error) {
	hash, err := rlpEncode(pb)
	if err != nil {
		return []byte{}, err
	}
	d := sha3.NewKeccak256()
	d.Write(hash)
	return d.Sum(nil), nil
}

func rlpEncode(pb *PlasmaTx) ([]byte, error) {
	return rlp.EncodeToBytes([]interface{}{
		uint64(pb.Slot),
		pb.PreviousBlock.Value.Bytes(),
		uint32(pb.Denomination.Value.Int64()),
		pb.GetNewOwner().Local,
	})
}

func isRequestAlreadySeen(meta *pctypes.PlasmaCashEventMeta, currentTally *pctypes.PlasmaCashRequestBatchTally) bool {
	if meta.BlockNumber != currentTally.LastSeenBlockNumber {
		return meta.BlockNumber <= currentTally.LastSeenBlockNumber
	}

	if meta.TxIndex != currentTally.LastSeenTxIndex {
		return meta.TxIndex <= currentTally.LastSeenTxIndex
	}

	if meta.LogIndex != currentTally.LastSeenLogIndex {
		return meta.LogIndex <= currentTally.LastSeenLogIndex
	}

	return true
}

var Contract plugin.Contract = contract.MakePluginContract(&HostileOperator{})
