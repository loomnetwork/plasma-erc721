# Plasma Cash - ERC721/ERC20/ETH Supported

## Installation and Loom SDK integration

To see the integrations run against the Loom SDK you must download the loom SDK, refer to https://loomx.io/developers/docs/en/basic-install-osx.html. 

Under the `loom_test` directory there are all the samples in Go, that directly interact with Loom SDK. If you have cloned the repo and go dependencies are not found, in `loom_test` try:

```
export GOPATH=$GOPATH:`pwd`
```

## Demo Flow

1. Alice registers and is given coins 1-5 from the token contract
2. Alice deposits `Coin 1`, `Coin 2`, `Coin 3` in the plasma chain
3. 3 Deposit Blocks have been generated in the child chain, each one having 1 UTXO at slots 0,1,2 respectively
4. Alice sends Coin 1 to Bob, adding the transaction to the current block.
5. Operator calls submitBlock, checkpointing the block merkle root which includes the transaction that gives ownership to Charlie - At this point, both the child chain and the root chain, have checkpointed Alice's transaction at block number 1000.
6. Bob transfers the previous UTXO to Charlie and the operator submits that block as well
7. Charlie tries to exit Coin 1, Alice & Bob do not challenge
8. After the challenge period passes, Charlie is able to withdraw his coin

## Loom integration  tests

```
cd server
npm install
npm run test
cd ..

cd loom_test
make clean
make deps
make demos
make contracts
make test
cd ..

LOOM_BIN=<ABSOLUTE_PATH_TO_LOOM> ./loom_integration_test.sh
```

## License info 

Please note different directories have different licenses. Please see license file in each folder respectively

All derivative works of this code must include this copyright header on every file
```
// Copyright Loom Network 2018 - All rights reserved, Dual licensed on GPLV3
// Learn more about Loom DappChains at https://loomx.io
// All derivative works of this code must include this copyright header on every file
```

* server directory -> GPLv3 [License](plasma_cash/License.md)
* loom_test directory  -> Loom Public License [License](loom_test/License.md)
