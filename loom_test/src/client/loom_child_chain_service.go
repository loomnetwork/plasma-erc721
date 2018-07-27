package client

import (
	"encoding/base64"
	"io/ioutil"

	"github.com/loomnetwork/go-loom/auth"
	"github.com/loomnetwork/go-loom/client"
	"github.com/loomnetwork/go-loom/client/plasma_cash"
)

// NewLoomChildChainService creates a new client for interacting with the Plasma Cash contract
// running on the DAppChain at the given URLs. If the hostile parameter is set to true then the
// client will interact with a "hostile" version of the Plasma Cash contract that doesn't verify
// coin transfers like the real Plasma Cash contract does.
func NewLoomChildChainService(hostile bool, writeuri, readuri string) (plasma_cash.ChainServiceClient, error) {
	privFile := "test.key" // hard coded for integration tests

	privKeyB64, err := ioutil.ReadFile(privFile)
	if err != nil {
		return nil, err
	}

	privKey, err := base64.StdEncoding.DecodeString(string(privKeyB64))
	if err != nil {
		return nil, err
	}

	signer := auth.NewEd25519Signer(privKey)

	contractName := "plasmacash"
	if hostile {
		contractName = "hostileoperator"
	}
	return client.NewPlasmaCashClient(contractName, signer, "default", writeuri, readuri)
}
