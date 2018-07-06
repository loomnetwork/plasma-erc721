package main

import (
	"client"
	"context"
	"fmt"
	"log"

	"github.com/ethereum/go-ethereum/common"
)

func main() {

	client.InitClients("http://localhost:8545")
	client.InitTokenClient("http://localhost:8545")
	ganache, err := client.ConnectToGanache("http://localhost:8545")
	exitIfError(err)

	svc, err := client.NewLoomChildChainService("http://localhost:46658/rpc", "http://localhost:46658/query")
	exitIfError(err)

	dan := client.NewClient(svc, client.GetRootChain("dan"), client.GetTokenContract("dan"))
	mallory := client.NewClient(svc, client.GetRootChain("mallory"), client.GetTokenContract("mallory"))
	authority := client.NewClient(svc, client.GetRootChain("authority"),
		client.GetTokenContract("authority"))

	// Give Mallory 5 tokens
	mallory.TokenContract.Register()
	slots := []uint64{}

	danTokensStart, err := dan.TokenContract.BalanceOf()
	exitIfError(err)
	log.Printf("Dan has %v tokens", danTokensStart)
	if danTokensStart != 0 {
		log.Fatal("START: Dan has incorrect number of tokens")
	}
	malloryTokensStart, err := mallory.TokenContract.BalanceOf()
	exitIfError(err)
	log.Printf("Mallory has %v tokens", malloryTokensStart)
	if malloryTokensStart != 5 {
		log.Fatal(fmt.Sprintf("START: Mallory has incorrect number of tokens -%d", malloryTokensStart))
	}
	currentBlock, err := authority.GetBlockNumber()
	exitIfError(err)
	log.Printf("current block: %v", currentBlock)

	startBlockHeader, err := ganache.HeaderByNumber(context.TODO(), nil)
	exitIfError(err)

	// Mallory deposits one of her coins to the plasma contract
	txHash := mallory.Deposit(6)

	depEvent, err := mallory.RootChain.DepositEventData(txHash)
	exitIfError(err)
	depositSlot1 := depEvent.Slot
	slots = append(slots, depEvent.Slot)

	txHash = mallory.Deposit(7)
	depEvent, err = mallory.RootChain.DepositEventData(txHash)
	exitIfError(err)
	slots = append(slots, depEvent.Slot)

	malloryTokensPostDeposit, err := mallory.TokenContract.BalanceOf()
	exitIfError(err)
	log.Printf("Mallory has %v tokens", malloryTokensPostDeposit)
	if malloryTokensPostDeposit != 3 {
		log.Fatal("POST-DEPOSIT: Mallory has incorrect number of tokens")
	}

	authority.DebugForwardDepositEvents(startBlockHeader.Number.Uint64(), startBlockHeader.Number.Uint64()+100)

	err = authority.SubmitBlock()
	exitIfError(err)
	currentBlock, err = authority.GetBlockNumber()
	exitIfError(err)
	log.Printf("plasma block 1: %v\n", currentBlock)

	err = authority.SubmitBlock()
	exitIfError(err)
	currentBlock, err = authority.GetBlockNumber()
	exitIfError(err)
	log.Printf("plasma block 2: %v\n", currentBlock)

	// Mallory sends her coin to Dan
	// Coin 6 was the first deposit of
	coin, err := mallory.RootChain.PlasmaCoin(depositSlot1)
	exitIfError(err)

	mallory.DebugCoinMetaData(slots)

	danAccount, err := dan.TokenContract.Account()
	exitIfError(err)
	log.Printf("account\n")

	err = mallory.SendTransaction(depositSlot1, coin.DepositBlockNum, 1, danAccount.Address) //mallory_to_dan
	exitIfError(err)

	err = authority.SubmitBlock()
	exitIfError(err)
	plasmaBlock3, err := authority.GetBlockNumber()
	exitIfError(err)
	log.Printf("plasma block 3: %v\n", plasmaBlock3)

	// Mallory attempts to exit spent coin (the one sent to Dan)
	log.Printf("Mallory trying an exit %d on block number %d\n", depositSlot1, coin.DepositBlockNum)
	mallory.StartExit(depositSlot1, 0, coin.DepositBlockNum)

	// Dan's transaction depositSlot1 included in plasmaBlock3. He challenges!
	dan.ChallengeAfter(depositSlot1, plasmaBlock3)
	log.Printf("ChallengeAfter\n")
	dan.StartExit(depositSlot1, coin.DepositBlockNum, plasmaBlock3)
	log.Printf("StartExit\n")

	// After 8 days pass,
	_, err = ganache.IncreaseTime(context.TODO(), 8*24*3600)
	exitIfError(err)

	authority.FinalizeExits()
	log.Printf("FinalizeExits\n")

	dan.Withdraw(depositSlot1)
	log.Printf("withdraw\n")

	danBalanceBefore, err := ganache.BalanceAt(context.TODO(), common.HexToAddress(danAccount.Address), nil)
	exitIfError(err)
	err = dan.WithdrawBonds()
	exitIfError(err)
	danBalanceAfter, err := ganache.BalanceAt(context.TODO(), common.HexToAddress(danAccount.Address), nil)
	exitIfError(err)

	if !(danBalanceBefore.Cmp(danBalanceAfter) < 0) {
		log.Fatal("END: Dan did not withdraw his bonds")
	}

	malloryTokensEnd, err := mallory.TokenContract.BalanceOf()
	exitIfError(err)
	log.Printf("Mallory has %v tokens", malloryTokensEnd)
	if malloryTokensEnd != 3 {
		log.Fatal("END: Mallory has incorrect number of tokens")
	}

	danTokensEnd, err := dan.TokenContract.BalanceOf()
	exitIfError(err)
	log.Printf("Dan has %v tokens", danTokensEnd)
	if danTokensEnd != 1 {
		log.Fatal("END: Dan has incorrect number of tokens")
	}

	log.Printf("Plasma Cash `challengeAfter` success :)")

}

// not idiomatic go, but it cleans up this sample
func exitIfError(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
