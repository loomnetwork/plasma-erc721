package main

import (
	"client"
	"context"
	"fmt"
	"log"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

func main() {
	client.InitClients("http://localhost:8545")
	client.InitTokenClient("http://localhost:8545")
	ganache, err := client.ConnectToGanache("http://localhost:8545")
	exitIfError(err)

	svc, err := client.NewLoomChildChainService(true, "http://localhost:46658/rpc", "http://localhost:46658/query")
	exitIfError(err)

	dan := client.NewClient(svc, client.GetRootChain("dan"), client.GetTokenContract("dan"))
	trudy := client.NewClient(svc, client.GetRootChain("trudy"), client.GetTokenContract("trudy"))
	authority := client.NewClient(svc, client.GetRootChain("authority"),
		client.GetTokenContract("authority"))
	danAccount, err := dan.TokenContract.Account()
	exitIfError(err)

	curBlockNum, err := authority.GetBlockNumber()
	fmt.Printf("Current Plasma Block %v\n", curBlockNum)

	// Give Trudy 5 tokens
	trudy.TokenContract.Register()

	startBlockHeader, err := ganache.HeaderByNumber(context.TODO(), nil)
	exitIfError(err)

	// Trudy deposits a coin
	txHash := trudy.Deposit(big.NewInt(21))
	depEvent, err := trudy.RootChain.DepositEventData(txHash)
	exitIfError(err)
	depositSlot1 := depEvent.Slot

	// Forward the deposit to the DAppChain (this will be done by an Oracle in practice)
	authority.DebugForwardDepositEvents(startBlockHeader.Number.Uint64(), startBlockHeader.Number.Uint64()+100)

	danTokenStart, err := dan.TokenContract.BalanceOf()
	exitIfError(err)

	coin, err := trudy.RootChain.PlasmaCoin(depositSlot1)
	exitIfError(err)

	exitIfError(authority.SubmitBlock())

	// TODO: Trudy should start watching for exits of depositSlot1

	// Trudy sends her coin to Dan
	exitIfError(trudy.SendTransaction(depositSlot1, coin.DepositBlockNum, big.NewInt(1), danAccount.Address))
	exitIfError(authority.SubmitBlock())
	trudyToDanBlockNum, err := authority.GetBlockNumber()
	exitIfError(err)

	// TODO: Trudy should stop watching for exits of depositSlot1

	coin, err = dan.RootChain.PlasmaCoin(depositSlot1)
	exitIfError(err)
	fmt.Println("Dan attempts to exit...")
	_, err = dan.StartExit(depositSlot1, big.NewInt(0), coin.DepositBlockNum)
	exitIfError(err)
	exitIfError(authority.SubmitBlock())

	// TODO: Dan should start watching for exits of depositSlot1
	// TODO: Dan should start watching for challenges of depositSlot1

	time.Sleep(4 * time.Second)
	fmt.Println("Trudy attempts to challenge Dan's exit...")
	challengeTxHash, err := trudy.ChallengeBefore(depositSlot1, big.NewInt(0), coin.DepositBlockNum)
	exitIfError(err)

	challengedExitEvent, err := trudy.RootChain.ChallengedExitEventData(common.BytesToHash(challengeTxHash))
	exitIfError(err)
	challengingTxHash := challengedExitEvent.TxHash

	// TODO: Response should be automatic as long as the client is watching for challenges
	fmt.Println("Dan responds to the invalid challenge...")
	_, err = dan.RespondChallengeBefore(depositSlot1, trudyToDanBlockNum, challengingTxHash)
	exitIfError(err)

	// Jump forward in time by 8 days
	_, err = ganache.IncreaseTime(context.TODO(), 8*24*3600)
	exitIfError(err)

	fmt.Println("Finalizing exits...")
	exitIfError(authority.FinalizeExits())

	fmt.Println("Dan withdraws his coin...")
	exitIfError(dan.Withdraw(depositSlot1))

	danBalanceBefore, err := ganache.BalanceAt(context.TODO(), common.HexToAddress(danAccount.Address), nil)
	exitIfError(err)
	fmt.Println("Dan withdraws his bond...")
	exitIfError(dan.WithdrawBonds())
	danBalanceAfter, err := ganache.BalanceAt(context.TODO(), common.HexToAddress(danAccount.Address), nil)
	exitIfError(err)

	if !(danBalanceBefore.Cmp(danBalanceAfter) < 0) {
		log.Fatal("END: Dan did not withdraw his bonds")
	}

	danTokensEnd, err := dan.TokenContract.BalanceOf()
	exitIfError(err)
	log.Printf("Dan has %v tokens", danTokensEnd)
	if danTokensEnd.Cmp(danTokenStart.Add(danTokenStart, big.NewInt(1))) != 0 {
		log.Fatal("END: Dan has incorrect number of tokens")
	}

	log.Printf("Plasma Cash `Respond Challenge Before` success :)")
}

// not idiomatic go, but it cleans up this sample
func exitIfError(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
