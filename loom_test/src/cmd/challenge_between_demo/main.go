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

	alice := client.NewClient(svc, client.GetRootChain("alice"), client.GetTokenContract("alice"))
	bob := client.NewClient(svc, client.GetRootChain("bob"), client.GetTokenContract("bob"))
	eve := client.NewClient(svc, client.GetRootChain("eve"), client.GetTokenContract("eve"))
	authority := client.NewClient(svc, client.GetRootChain("authority"),
		client.GetTokenContract("authority"))
	aliceAccount, err := alice.TokenContract.Account()
	exitIfError(err)
	bobAccount, err := bob.TokenContract.Account()
	exitIfError(err)

	bobTokensStart, err := bob.TokenContract.BalanceOf()
	exitIfError(err)

	// Give Eve 5 tokens
	eve.Register()

	startBlockHeader, err := ganache.HeaderByNumber(context.TODO(), nil)
	exitIfError(err)

	// Eve deposits a coin
	txHash := eve.Deposit(11)
	deposit1, err := eve.RootChain.DepositEventData(txHash)
	exitIfError(err)

	authority.DebugForwardDepositEvents(startBlockHeader.Number.Uint64(), startBlockHeader.Number.Uint64()+100)

	// Eve sends her plasma coin to Bob
	coin, err := eve.PlasmaCoin(deposit1.Slot)
	exitIfError(err)
	err = eve.SendTransaction(deposit1.Slot, coin.DepositBlockNum, 1, bobAccount.Address)
	exitIfError(err)

	err = authority.SubmitBlock()
	exitIfError(err)
	eveToBobBlockNum, err := authority.GetBlockNumber()
	exitIfError(err)

	// TODO: bob.WatchExits(deposit1.Slot)

	// Eve sends this same plasma coin to Alice
	err = eve.SendTransaction(deposit1.Slot, coin.DepositBlockNum, 1, aliceAccount.Address)
	exitIfError(err)

	err = authority.SubmitBlock()
	exitIfError(err)
	eveToAliceBlock, err := authority.GetBlockNumber()
	exitIfError(err)

	fmt.Printf("Challenge Between - Alice attempts to exit slot %v prevBlock %v exitBlock %v\n",
		deposit1.Slot, coin.DepositBlockNum, eveToAliceBlock)
	// Alice attempts to exit here double-spent coin
	_, err = alice.StartExit(deposit1.Slot, coin.DepositBlockNum, eveToAliceBlock)
	exitIfError(err)

	fmt.Printf("Bob is challenging slot %v at block %v\n", deposit1.Slot, eveToBobBlockNum)
	// Alice's exit should be auto-challenged by Bob's client, but watching/auto-challenge hasn't
	// been implemented yet, so challenge the exit manually for now...
	_, err = bob.ChallengeBetween(deposit1.Slot, eveToBobBlockNum)
	exitIfError(err)

	fmt.Printf("Bob attempts to exit slot %v prevBlock %v exitBlock %v\n",
		deposit1.Slot, coin.DepositBlockNum, eveToBobBlockNum)
	_, err = bob.StartExit(deposit1.Slot, coin.DepositBlockNum, eveToBobBlockNum)
	exitIfError(err)

	// TODO: bob.StopWatchingExits(deposit1.Slot)

	_, err = ganache.IncreaseTime(context.TODO(), 8*24*3600)
	exitIfError(err)

	fmt.Println("Finalizing exits")
	exitIfError(authority.FinalizeExits())

	fmt.Printf("Bob attempts to withdraw slot %v\n", deposit1.Slot)
	err = bob.Withdraw(deposit1.Slot)
	exitIfError(err)

	bobBalanceBefore, err := ganache.BalanceAt(context.TODO(), common.HexToAddress(bobAccount.Address), nil)
	exitIfError(err)
	fmt.Println("Bob attempts to withdraw bonds")
	err = bob.WithdrawBonds()
	exitIfError(err)
	bobBalanceAfter, err := ganache.BalanceAt(context.TODO(), common.HexToAddress(bobAccount.Address), nil)
	exitIfError(err)

	if !(bobBalanceBefore.Cmp(bobBalanceAfter) < 0) {
		log.Fatal("END: Bob did not withdraw his bonds")
	}

	bobTokensEnd, err := bob.TokenContract.BalanceOf()
	exitIfError(err)

	fmt.Printf("Bob has %d tokens", bobTokensEnd)
	if !(bobTokensEnd == bobTokensStart+1) {
		log.Fatal("END: Bob has incorrect number of tokens")
	}

	fmt.Printf("Plasma Cash 'challengeBetween' success :)\n")

}

// not idiomatic go, but it cleans up this sample
func exitIfError(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
