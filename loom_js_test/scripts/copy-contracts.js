// This script copies Solidity contract ABI files to the dist directory

const shell = require('shelljs')
const os = require('os')
const path = require('path')

shell.mkdir('-p', './dist/contracts')
shell.cp('./src/contracts/cards-abi.json', './dist/contracts/cards-abi.json')
