#!/bin/bash

set -exo pipefail

function start_chains {
    cd $REPO_ROOT/server
    npm run --silent migrate:dev
    sleep 1
    ganache_pid=`cat ganache.pid`
    echo 'Launched ganache' $ganache_pid

    cd $LOOM_DIR
    CONTRACT_LOG_LEVEL="debug" CONTRACT_LOG_DESTINATION="file://contract.log" $LOOM_BIN run > loom.log 2>&1 &  
    loom_pid=$!
    echo "Launched Loom - Log(loom.log) Pid(${loom_pid})"
}

function stop_chains {
    echo "exiting ganache-pid(${ganache_pid})"
    echo "exiting loom-pid(${loom_pid})"
    kill -9 "${ganache_pid}"    &> /dev/null
    kill -9 "${loom_pid}"   &> /dev/null
}

function cleanup {
    stop_chains

    if [[ $LOOM_DIR ]]; then 
        rm -rf $LOOM_DIR
    fi
}

REPO_ROOT=`pwd`
LOOM_DIR=`pwd`/tmp/loom-plasma-$BUILD_TAG
BUILD_NUMBER=324

rm -rf  $LOOM_DIR; true
mkdir -p $LOOM_DIR
cd $LOOM_DIR
if [[ "`uname`" == 'Darwin' ]]; then
wget https://private.delegatecall.com/loom/osx/build-$BUILD_NUMBER/loom
else 
wget https://private.delegatecall.com/loom/linux/build-$BUILD_NUMBER/loom
fi
chmod +x loom
export LOOM_BIN=`pwd`/loom
echo $REPO_ROOT
cp $REPO_ROOT/loom_test/loom-test.yml $LOOM_DIR/loom.yml

$LOOM_BIN init
echo 'Loom DAppChain initialized in ' $LOOM_DIR

trap cleanup EXIT

start_chains
# Wait for Ganache & Loom to spin up
sleep 10

cd $REPO_ROOT/loom_test
./plasmacash_tester
./plasmacash_challenge_after_tester
cd ..

stop_chains
sleep 60

# Most challenge tests require a hostile/dumb Plasma Cash operator
cd $LOOM_DIR
rm -rf app.db
rm -rf chaindata
$LOOM_BIN init -f
echo 'Loom DAppChain initialized in ' $LOOM_DIR

cd $REPO_ROOT/loom_test
make contracts
mkdir $LOOM_DIR/contracts
cp contracts/hostileoperator.1.0.0 $LOOM_DIR/contracts/hostileoperator.1.0.0
chmod +x $LOOM_DIR/contracts/hostileoperator.1.0.0
cp hostile.genesis.json $LOOM_DIR/genesis.json

# let's see if this plugin can start...
cd $LOOM_DIR/contracts
LOOM_CONTRACT=loomrocks ./hostileoperator.1.0.0
contract_pid=$!
sleep 10
kill -9 "${contract_pid}" &> /dev/null

#start_chains
#sleep 10

#cd $REPO_ROOT/loom_test
#./plasmacash_tester -hostile
#./plasmacash_challenge_after_tester -hostile
#./plasmacash_challenge_between_tester -hostile
#./plasmacash_challenge_before_tester -hostile
#./plasmacash_respond_challenge_before_tester -hostile
#cd ..
