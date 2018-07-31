#!/bin/bash

set -exo pipefail

# Spins up a Ganache node & a DAppChain node
function start_chains {
    cd $REPO_ROOT/server
    npm run --silent migrate:dev
    sleep 1
    ganache_pid=`cat ganache.pid`
    echo 'Launched ganache' $ganache_pid

    cd $LOOM_DIR
    $LOOM_BIN run > loom.log 2>&1 &  
    loom_pid=$!
    echo "Launched Loom - Log(loom.log) Pid(${loom_pid})"

    # Wait for Ganache & Loom to spin up
    sleep 10
}

# Stops the Ganache node & the DAppChain node
function stop_chains {
    echo "exiting ganache-pid(${ganache_pid})"
    kill -9 "${ganache_pid}"    &> /dev/null
    echo "exiting loom-pid(${loom_pid})"
    kill -9 "${loom_pid}"   &> /dev/null
    echo "killing ${LOOM_DIR}/contracts/hostileoperator.1.0.0"
    pkill -f "${LOOM_DIR}/contracts/hostileoperator.1.0.0" || true
}

function init_honest_dappchain {
    cd $LOOM_DIR
    rm -rf app.db
    rm -rf chaindata
    $LOOM_BIN init -f
    echo 'Loom DAppChain initialized in ' $LOOM_DIR
}

function init_hostile_dappchain {
    init_honest_dappchain

    cd $REPO_ROOT/loom_test
    mkdir $LOOM_DIR/contracts
    cp contracts/hostileoperator.1.0.0 $LOOM_DIR/contracts/hostileoperator.1.0.0
    cp hostile.genesis.json $LOOM_DIR/genesis.json
}

function cleanup {
    stop_chains

    if [[ $LOOM_DIR ]]; then 
        rm -rf $LOOM_DIR
    fi
}

REPO_ROOT=`pwd`
LOOM_DIR=`pwd`/tmp/loom-plasma-$BUILD_TAG
BUILD_NUMBER=335

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

init_honest_dappchain

trap cleanup EXIT

start_chains

# Run first set of Go tests against the built-in Plasma Cash contract
cd $REPO_ROOT/loom_test
./plasmacash_tester
./plasmacash_challenge_after_tester

stop_chains
# Wait for Ganache & Loom to stop
sleep 10

# Reset the DAppChain and deploy a hostile/dumb Plasma Cash contract for the Go challenge tests
init_hostile_dappchain
start_chains

cd $REPO_ROOT/loom_test
./plasmacash_tester -hostile
./plasmacash_challenge_after_tester -hostile
./plasmacash_challenge_between_tester -hostile
./plasmacash_challenge_before_tester -hostile
./plasmacash_respond_challenge_before_tester -hostile

stop_chains
# Wait for Ganache & Loom to stop
sleep 10

# Reset the DAppChain again for the JS tests
init_honest_dappchain
start_chains

cd $REPO_ROOT/loom_js_test
yarn jenkins:test:honest

stop_chains
# Wait for Ganache & Loom to stop
sleep 10

init_hostile_dappchain
start_chains

cd $REPO_ROOT/loom_js_test
yarn jenkins:test:hostile
