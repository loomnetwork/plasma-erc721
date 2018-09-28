#!/bin/bash

set -exo pipefail

REPO_ROOT=`pwd`

cd $REPO_ROOT/server
npm install
npm run lint
npm run test

# build the Go tester and run the unit tests
cd $REPO_ROOT/loom_test
export GOPATH=/tmp/gopath-$BUILD_TAG:`pwd`
make clean
make deps
make demos
make contracts
make test

# build the JS e2e tests
cd $REPO_ROOT/loom_js_test
yarn install
yarn build
yarn copy-contracts

cd $REPO_ROOT
REPO_ROOT=`pwd` IS_JENKINS_ENV=true bash loom_integration_test.sh
