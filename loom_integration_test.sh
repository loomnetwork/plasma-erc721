#!/bin/bash

# To run this script locally set LOOM_BIN env var to point at the loom binary you wish to run the
# tests with.

set -exo pipefail

# Loom build to use for tests when running on Jenkins, this build will be automatically downloaded.
BUILD_NUMBER=335

# These can be toggled via the options below, only useful when running the script locally.
LOOM_INIT_ONLY=false
DEBUG_LOOM=false

# Scripts options:
# -i / --init    - Reinitializes the DAppChain for a fresh test run.
# --debug-node   - Doesn't reinitialize or start the DAppChain (only Ganache), useful when you want to
#                  launch the DAppChain node manually via the debugger.
while [[ "$#" > 0 ]]; do case $1 in
  -i|--init) LOOM_INIT_ONLY=true; shift;;
  --debug-node) DEBUG_LOOM=true; shift;;
  *) echo "Unknown parameter: $1"; shift; shift;;
esac; done

echo "Only reinitializing DAppChain? $LOOM_INIT_ONLY"
echo "Skipping launching of DAppChain node? $DEBUG_LOOM"

# Spins up a Ganache node & a DAppChain node
function start_chains {
    cd $REPO_ROOT/server
    npm run --silent migrate:dev
    sleep 1
    ganache_pid=`cat ganache.pid`
    echo 'Launched ganache' $ganache_pid

    if [[ "$DEBUG_LOOM" == false ]]; then
        cd $LOOM_DIR
        $LOOM_BIN run > loom.log 2>&1 &  
        loom_pid=$!
        echo "Launched Loom - Log(loom.log) Pid(${loom_pid})"
    fi

    # Wait for Ganache & Loom to spin up
    sleep 10
}

# Stops the Ganache node & the DAppChain node
function stop_chains {
    echo "exiting ganache-pid(${ganache_pid})"
    kill -9 "${ganache_pid}"    &> /dev/null
    
    if [[ "$DEBUG_LOOM" == false ]]; then
        echo "exiting loom-pid(${loom_pid})"
        kill -9 "${loom_pid}"   &> /dev/null
        echo "killing ${LOOM_DIR}/contracts/hostileoperator.1.0.0"
        pkill -f "${LOOM_DIR}/contracts/hostileoperator.1.0.0" || true
    fi
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
}

function download_dappchain {
    cd $LOOM_DIR
    if [[ "`uname`" == 'Darwin' ]]; then
        wget https://private.delegatecall.com/loom/osx/build-$BUILD_NUMBER/loom
    else 
        wget https://private.delegatecall.com/loom/linux/build-$BUILD_NUMBER/loom
    fi
    chmod +x loom
    export LOOM_BIN=`pwd`/loom
}

# BUILD_TAG is usually only set by Jenkins, so when running locally just hardcode some value
if [[ -z "$BUILD_TAG" ]]; then
    BUILD_TAG=123
fi

# REPO_ROOT is set in jenkins.sh, if the script is executed directly just use cwd
if [[ -z "$REPO_ROOT" ]]; then
    REPO_ROOT=`pwd`
fi

LOOM_DIR=`pwd`/tmp/loom-plasma-$BUILD_TAG

if [[ "$DEBUG_LOOM" == false ]]; then
    rm -rf  $LOOM_DIR; true
fi

mkdir -p $LOOM_DIR

if [[ "$IS_JENKINS_ENV" == true ]]; then
    download_dappchain
fi

echo "REPO_ROOT=(${REPO_ROOT})"
echo "GOPATH=(${GOPATH})"

cp $REPO_ROOT/loom_test/loom-test.yml $LOOM_DIR/loom.yml

if [[ "$DEBUG_LOOM" == false ]]; then
    init_honest_dappchain
fi

if [[ "$LOOM_INIT_ONLY" == true ]]; then
    exit
fi

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

# If the script gets this far then nothing failed and we can wipe out the working dir since we
# probably wont't need the logs.
if [[ $LOOM_DIR ]]; then 
    rm -rf $LOOM_DIR
fi
