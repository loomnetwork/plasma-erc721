# Plasma Cash - ERC721/ERC20/ETH Supported

## Architecture

Client connects to the Child Chain Service, the Root Chain Plasma Contract and the Root Chain Token Contract

Send tx:
Client -> Child Chain Service sendtx -> Child Chain server listens to that request and calls child chain sendtransaction, tx gets added to the block

Child Chain ALWAYS listens for events on the RootChain contract and acts on them accordingly

## Installation

Requires Python 3.6 installed.
If any tests did not succeed, please submit an issue.

1. In plasma_cash folder follow the [README.md](plasma_cash/README.md)


```
cd plasma_cash
mkvirtualenv erc721plasma --python=/usr/bin/python3.6
pip install -r requirements.txt
```

On OSX + Homebrew (may need this)
```
source /usr/local/bin/virtualenvwrapper.sh
```

Or if run into issues regarding the `openssl` like:
```
'openssl/aes.h' file not found
```
Should export some path to `openssl` libraries as following:
```
export LDFLAGS="-L/usr/local/opt/openssl/lib"
export CPPFLAGS="-I/usr/local/opt/openssl/include"
```

> Note: Also on OSX it may require `brew upgrade openssl`

2. In server folder follow the [README.md](server/README.md)

```
cd server
npm install
npm run test
```

## Demos

To run demo, execute the integration test script:
```
./integration_test.sh
```

Under `demos/` there are various scenarios which can occur. You should have initialized both the smart contracts from the `server/` directory, and launched a Plasma Chain instance, as described in the corresponding READMEs.

### Demo 1
1. Alice registers and is given coins 1-5
2. Alice deposits `Coin 1`, `Coin 2`, `Coin 3` in the plasma chain
3. 3 Deposit Blocks have been generated in the child chain, each one having 1 UTXO at slots 0,1,2 repsectively
4. Alice sends a Coin 1 to Bob, adding a transaction to the current block.
5. Operator calls submitBlock, checkpointing the block merkle root which includes the transaction that gives ownership to charlie. At this point, both the child chain and the root chain, have checkpointed alice's transaction at block number 1000.
6. Bob transfers the previous UTXO to Charlie and the operator submits that block as well
5. Charlie tries to exit coin 1, Alice & Bob do not challenge
6. After challenge period passes, charlie should be able to withdraw his coin

## Loom SDK integration

To see the integrations run against the Loom SDK instead of the prototype server. To download the loom SDK, refer to https://loomx.io/developers/docs/en/basic-install-osx.html. Under the `loom_test` directory there is all the samples in Go, that directly interact with Loom SDK. If you have cloned the repo and go dependencies are not found, in `loom_test` try:

```
export GOPATH=$GOPATH:`pwd`
```

### Loom integration  tests

```
cd server
npm install
cd .. 

cd loom_test
make clean
make deps
make demos
make contracts
make test
cd ..

cd loom_js_test
yarn
yarn build
yarn copy-contracts
cd ..

LOOM_BIN=<ABSOLUTE_PATH_TO_LOOM> ./loom_integration_test.sh
```

## For Developers

### Signing locally
http://web3py.readthedocs.io/en/latest/web3.eth.account.html#prepare-message-for-ecrecover-in-solidity


## License info 

Please note different directories have different licenses. Please see license file in each folder respectively

* server directory -> GPLv2 [License](plasma_cash/License.md)
* plasma_cash directory  -> GPLv2 [License](plasma_cash/License.md)
* loom_test directory  -> Loom Public License [License](loom_test/License.md)
