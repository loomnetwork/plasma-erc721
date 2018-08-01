#!/bin/bash

set -exo pipefail

REPO_ROOT=`pwd`

cd $REPO_ROOT/server
npm install
npm run lint
npm run test

#cd $REPO_ROOT/plasma_cash

#virtualenv --python=python3.5 .
#source bin/activate
#export PATH="/var/lib/jenkins/.pyenv/bin:$PATH"
#eval "$(pyenv init -)"
#eval "$(pyenv virtualenv-init -)"
#pyenv virtualenv 3.6.0 general
#pyenv global general

#pip install -r requirements.txt
#make lint
#make test

#cd ../
#bash integration_test.sh

# build the Go tester and run the unit tests
cd $REPO_ROOT/loom_test
export GOPATH=/tmp/gopath-$BUILD_TAG:`pwd`
make clean
make deps
make demos
make test

cd $REPO_ROOT
bash loom_integration_test.sh

#cd $REPO_ROOT
#bash loom_js_integration_test.sh