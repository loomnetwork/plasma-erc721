package client

import (
	"fmt"
	"log"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pkg/errors"

	"github.com/loomnetwork/go-loom/client/plasma_cash"
	"github.com/loomnetwork/go-loom/client/plasma_cash/eth"
)

type Client struct {
	childChain         plasma_cash.ChainServiceClient
	RootChain          plasma_cash.RootChainClient
	TokenContract      plasma_cash.TokenContract
	childBlockInterval int64
	blocks             map[string]plasma_cash.Block
	plasmaEthClient    eth.EthPlasmaClient
}

const ChildBlockInterval = 1000

// Token Functions

// Register a new player and grant 5 cards, for demo purposes
func (c *Client) Register() {
	c.TokenContract.Register()
}

// Deposit happens by a use calling the erc721 token contract
func (c *Client) Deposit(tokenID *big.Int) common.Hash {
	txHash, err := c.TokenContract.Deposit(tokenID)
	if err != nil {
		panic(err)
	}
	return txHash
}

// DebugForwardDepositEvents forwards deposit event data from the Plasma Cash contract on Ethereum
// to the DAppChain. The parameters should used to specify the Ethereum block range from which
// event data should be retrieved. In practice this will be done by the Plasma Cash Oracle, this
// function is only for testing.
//
func (c *Client) DebugForwardDepositEvents(startBlockNum, endBlockNum uint64) {
	//To prevent us to having to run the oracle, we are going to run the oracle manually here
	//Normally this would run as a seperate process, in future tests we can spin it up independantly
	deposits, err := c.plasmaEthClient.FetchDeposits(startBlockNum, endBlockNum)
	if err != nil {
		panic(errors.Wrap(err, "failed to fetch Plasma deposits from Ethereum"))
	}

	for _, deposit := range deposits {
		fmt.Printf("Forwarded deposit event data for slot %v\n", deposit.Slot)
		if err := c.childChain.Deposit(deposit); err != nil {
			panic(err)
		}
	}
}

// Plasma Functions

func Transaction(slot uint64, prevTxBlkNum *big.Int, denomination *big.Int, address string) plasma_cash.Tx {
	return &plasma_cash.LoomTx{
		Slot:         slot,
		PrevBlock:    prevTxBlkNum,
		Denomination: denomination,
		Owner:        common.HexToAddress(address), //TODO: 0x?
	}
}

func (c *Client) StartExit(slot uint64, prevTxBlkNum *big.Int, txBlkNum *big.Int) ([]byte, error) {
	// As a user, you declare that you want to exit a coin at slot `slot`
	//at the state which happened at block `txBlkNum` and you also need to
	// reference a previous block

	// TODO The actual proof information should be passed to a user from its
	// previous owners, this is a hacky way of getting the info from the
	// operator which sould be changed in the future after the exiting
	// process is more standardized
	account, err := c.TokenContract.Account()
	if err != nil {
		return nil, err
	}

	blkModInterval := new(big.Int)
	blkModInterval = blkModInterval.Mod(txBlkNum, big.NewInt(c.childBlockInterval))
	if blkModInterval.Cmp(big.NewInt(0)) != 0 {
		// In case the sender is exiting a Deposit transaction, they should
		// just create a signed transaction to themselves. There is no need
		// for a merkle proof.
		fmt.Printf("exiting deposit transaction\n")

		// prev_block = 0 , denomination = 1
		exitingTx := Transaction(slot, big.NewInt(0), big.NewInt(1), account.Address)
		exitingTxSig, err := exitingTx.Sign(account.PrivateKey)
		if err != nil {
			return nil, err
		}

		txHash, err := c.RootChain.StartExit(
			slot,
			nil, exitingTx,
			nil, nil, //proofs?
			exitingTxSig,
			big.NewInt(0), txBlkNum)
		if err != nil {
			return nil, err
		}
		return txHash, nil
	}

	// Otherwise, they should get the raw tx info from the block
	// And the merkle proof and submit these
	exitingTx, exitingTxProof, err := c.getTxAndProof(txBlkNum, slot)
	if err != nil {
		return nil, err
	}
	prevTx, prevTxProof, err := c.getTxAndProof(prevTxBlkNum, slot)
	if err != nil {
		return nil, err
	}
	sig := exitingTx.Sig()

	return c.RootChain.StartExit(
		slot,
		prevTx, exitingTx,
		prevTxProof, exitingTxProof,
		sig,
		prevTxBlkNum, txBlkNum)
}

func (c *Client) ChallengeBefore(slot uint64, prevTxBlkNum *big.Int, txBlkNum *big.Int) ([]byte, error) {
	account, err := c.TokenContract.Account()
	if err != nil {
		return nil, err
	}

	blkModInterval := new(big.Int)
	blkModInterval = blkModInterval.Mod(txBlkNum, big.NewInt(c.childBlockInterval))
	if blkModInterval.Cmp(big.NewInt(0)) != 0 {
		// If the client is challenging an exit with a deposit they can create a signed transaction themselves.
		// There is no need for a merkle proof.
		exitingTx := Transaction(slot, big.NewInt(0), big.NewInt(1), account.Address)
		exitingTxSig, err := exitingTx.Sign(account.PrivateKey)
		if err != nil {
			return nil, err
		}

		txHash, err := c.RootChain.ChallengeBefore(
			slot,
			nil, exitingTx,
			nil, nil,
			exitingTxSig,
			big.NewInt(0), txBlkNum)
		if err != nil {
			return nil, err
		}
		return txHash, nil
	}

	// Otherwise, they should get the raw tx info from the block
	// And the merkle proof and submit these
	exitingTx, exitingTxProof, err := c.getTxAndProof(txBlkNum, slot)
	if err != nil {
		return nil, err
	}

	prevTx, prevTxProof, err := c.getTxAndProof(prevTxBlkNum, slot)
	if err != nil {
		return nil, err
	}

	exitingTxSig, err := exitingTx.Sign(account.PrivateKey)
	if err != nil {
		return nil, err
	}

	txHash, err := c.RootChain.ChallengeBefore(
		slot,
		prevTx, exitingTx,
		prevTxProof, exitingTxProof,
		exitingTxSig,
		prevTxBlkNum, txBlkNum)
	return txHash, err

}

// RespondChallengeBefore - Respond to an exit with invalid history challenge by proving that
// you were given the coin under question
func (c *Client) RespondChallengeBefore(slot uint64, respondingBlockNumber *big.Int, challengingTxHash [32]byte) ([]byte, error) {
	respondingTx, proof, err := c.getTxAndProof(respondingBlockNumber,
		slot)
	if err != nil {
		return nil, err
	}

	txHash, err := c.RootChain.RespondChallengeBefore(slot,
		challengingTxHash,
		respondingBlockNumber,
		respondingTx,
		proof,
		respondingTx.Sig())
	return txHash, err
}

// ChallengeBetween - `Double Spend Challenge`: Challenge a double spend of a coin
// with a spend between the exit's blocks
func (c *Client) ChallengeBetween(slot uint64, challengingBlockNumber *big.Int) ([]byte, error) {
	challengingTx, proof, err := c.getTxAndProof(challengingBlockNumber, slot)
	if err != nil {
		return nil, err
	}

	txHash, err := c.RootChain.ChallengeBetween(
		slot,
		challengingBlockNumber,
		challengingTx,
		proof,
		challengingTx.Sig(),
	)
	return txHash, err
}

// ChallengeAfter - `Exit Spent Coin Challenge`: Challenge an exit with a spend
// after the exit's blocks
func (c *Client) ChallengeAfter(slot uint64, challengingBlockNumber *big.Int) ([]byte, error) { //
	fmt.Printf("Challenege after getting block-%d - slot %d\n", challengingBlockNumber, slot)
	challengingTx, proof, err := c.getTxAndProof(challengingBlockNumber,
		slot)
	if err != nil {
		return nil, err
	}

	txHash, err := c.RootChain.ChallengeAfter(
		slot, challengingBlockNumber,
		challengingTx,
		proof,
		challengingTx.Sig())
	return txHash, err
}

func (c *Client) FinalizeExits() error {
	return c.RootChain.FinalizeExits()
}

func (c *Client) Withdraw(slot uint64) error {
	return c.RootChain.Withdraw(slot)
}

func (c *Client) WithdrawBonds() error {
	return c.RootChain.WithdrawBonds()
}

func (c *Client) PlasmaCoin(slot uint64) (*plasma_cash.PlasmaCoin, error) {
	return c.RootChain.PlasmaCoin(slot)
}

func (c *Client) DebugCoinMetaData(slots []uint64) {
	c.RootChain.DebugCoinMetaData(slots)
}

// Child Chain Functions

func (c *Client) SubmitBlock() error {
	if err := c.childChain.SubmitBlock(); err != nil {
		return err
	}

	blockNum, err := c.childChain.BlockNumber()
	if err != nil {
		return err
	}

	block, err := c.childChain.Block(blockNum)
	if err != nil {
		return err
	}

	var root [32]byte
	copy(root[:], block.MerkleHash())
	return c.RootChain.SubmitBlock(blockNum, root)
}

func (c *Client) SendTransaction(slot uint64, prevBlock *big.Int, denomination *big.Int, newOwner string) error {
	ethAddress := common.HexToAddress(newOwner)

	tx := &plasma_cash.LoomTx{
		Slot:         slot,
		Denomination: denomination,
		Owner:        ethAddress,
		PrevBlock:    prevBlock,
	}

	account, err := c.TokenContract.Account()
	if err != nil {
		return err
	}

	sig, err := tx.Sign(account.PrivateKey)
	if err != nil {
		return err
	}

	return c.childChain.SendTransaction(slot, prevBlock, denomination, newOwner, account.Address, sig)
}

func (c *Client) getTxAndProof(blkHeight *big.Int, slot uint64) (plasma_cash.Tx, []byte, error) {
	block, err := c.childChain.Block(blkHeight)
	if err != nil {
		return nil, nil, err
	}

	tx, err := block.TxFromSlot(slot)
	if err != nil {
		return nil, nil, err
	}

	// server should handle this
	/*
		if blkHeight%ChildBlockInterval != 0 {
			proof := []byte{00000000}
		} else {

		}
	*/

	return tx, tx.Proof(), nil
}

func (c *Client) WatchExits(slot uint64) error {
	panic("TODO")
}

func (c *Client) StopWatchingExits(slot uint64) error {
	panic("TODO")
}

func (c *Client) GetBlockNumber() (*big.Int, error) {
	return c.childChain.BlockNumber()
}

func (c *Client) GetBlock(blkHeight *big.Int) (plasma_cash.Block, error) {
	return c.childChain.Block(blkHeight)
}

func NewClient(childChainServer plasma_cash.ChainServiceClient, rootChain plasma_cash.RootChainClient, tokenContract plasma_cash.TokenContract) *Client {
	ethPrivKeyHexStr := GetTestAccountHexKey("authority")
	ethPrivKey, err := crypto.HexToECDSA(strings.TrimPrefix(ethPrivKeyHexStr, "0x"))
	if err != nil {
		log.Fatalf("failed to load private key: %v", err)
	}
	ethCfg := eth.EthPlasmaClientConfig{
		EthereumURI:      "http://localhost:8545",
		PlasmaHexAddress: GetContractHexAddress("root_chain"),
		PrivateKey:       ethPrivKey,
		OverrideGas:      true,
	}

	pbc := eth.NewEthPlasmaClient(ethCfg)
	err = pbc.Init()
	if err != nil {
		panic(err) //todo return
	}

	return &Client{childChain: childChainServer, childBlockInterval: 1000, RootChain: rootChain, TokenContract: tokenContract, plasmaEthClient: pbc}
}
