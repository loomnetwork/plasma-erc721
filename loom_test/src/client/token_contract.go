package client

import (
	"crypto/ecdsa"
	"ethcontract"
	"log"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/loomnetwork/go-loom/client/plasma_cash"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/ethereum/go-ethereum/ethclient"
)

type TContract struct {
	Name          string
	tokenContract *ethcontract.Cards
	callerKey     *ecdsa.PrivateKey
	callerAddr    common.Address
	transactOpts  *bind.TransactOpts
}

func (d *TContract) Deposit(tokenID *big.Int) (common.Hash, error) {
	tx, err := d.tokenContract.DepositToPlasma(d.transactOpts, tokenID)
	if err != nil {
		return common.Hash{}, err
	}
	return tx.Hash(), err
}

func (d *TContract) Register() error {
	_, err := d.tokenContract.Register(d.transactOpts)
	return err
}

func (d *TContract) BalanceOf() (*big.Int, error) {
	bal, err := d.tokenContract.BalanceOf(nil, d.callerAddr)
	if err != nil {
		return big.NewInt(0), err
	}
	return bal, nil
}

func (d *TContract) Account() (*plasma_cash.Account, error) {
	return &plasma_cash.Account{
		Address:    d.callerAddr.String(),
		PrivateKey: d.callerKey,
	}, nil
}

var connToken *ethclient.Client

func InitTokenClient(connStr string) {
	var err error
	connToken, err = ethclient.Dial(connStr)
	if err != nil {
		log.Fatalf("Failed to connect to the Ethereum client: %v", err)
	}
}

func NewTokenContract(callerName string, callerKey *ecdsa.PrivateKey, boundContract *ethcontract.Cards) plasma_cash.TokenContract {
	auth := bind.NewKeyedTransactor(callerKey)
	// If gas price isn't set explicitely then go-ethereum will attempt to query the suggested gas
	// price, unfortunatley ganache-cli v6.1.2 seems to encode the gas price in a format go-ethereum
	// can't decode correctly, so this error is returned whenver you attempt to call a contract:
	// failed to suggest gas price: json: cannot unmarshal hex number with leading zero digits into Go value of type *hexutil.Big
	//
	// Earlier versions of ganache-cli don't seem to exhibit this issue, but they're broken in other
	// ways (logs aren't hex-encoded correctly).
	auth.GasPrice = big.NewInt(20000)
	auth.GasLimit = uint64(3141592)
	return &TContract{
		Name:          callerName,
		tokenContract: boundContract,
		callerKey:     callerKey,
		callerAddr:    crypto.PubkeyToAddress(callerKey.PublicKey),
		transactOpts:  auth,
	}
}
