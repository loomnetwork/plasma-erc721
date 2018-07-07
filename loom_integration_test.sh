#!/bin/bash

set -exo pipefail

function cleanup {
    echo "exiting ganache-pid(${ganache_pid})"
    echo "exiting loom-pid(${loom_pid})"
    kill -9 "${ganache_pid}"    &> /dev/null
    kill -9 "${loom_pid}"   &> /dev/null

    if [[ $LOOM_DIR ]]; then 
        rm -rf $LOOM_DIR
    fi
}

REPO_ROOT=`pwd`
LOOM_DIR=`pwd`/tmp/loom-plasma-$BUILD_TAG
BUILD_NUMBER=235

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

cd $REPO_ROOT/loom_test
./plasmacash_tester
./plasmacash_challenge_after_tester
./plasmacash_challenge_between_tester
cd ..
