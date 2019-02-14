const HDWalletProvider = require('truffle-hdwallet-provider')
const PrivateKeyProvider = require('truffle-privatekey-provider')
const fs = require("fs")

require('babel-register');
require('babel-polyfill');

const mnemonic = 'stumble story behind hurt patient ball whisper art swift tongue ice alien';

let mainnetMnemonic = '';
let infuraKey = process.env.INFURA_KEY; //TODO put into env var before merge

let filename = process.env.SECRET_FILE
if (filename == "") {
  filename = "secrets.json"
}
if(fs.existsSync(filename)) {
  secrets = JSON.parse(fs.readFileSync(filename, "utf8"))
  mainnetMnemonic = secrets.mnemonic
  console.log("Found mainnet mnemonic")
} 

let ropstenProvider, kovanProvider, rinkebyProvider, mainnetProvider = {}

if (process.env.LIVE_NETWORKS) {
  ropstenProvider = new HDWalletProvider(mnemonic, 'https://ropsten.infura.io/')
  kovanProvider = new HDWalletProvider(mnemonic, 'https://kovan.infura.io')

  try {
    const { rpc, key } = require(require('homedir')()+'/.rinkebykey.json')
    rinkebyProvider = new PrivateKeyProvider(key, rpc)
  } catch (e) {
    rinkebyProvider = new HDWalletProvider(mnemonic, 'https://rinkeby.infura.io')
  }
}

const mochaGasSettings = {
  reporter: 'eth-gas-reporter',
  reporterOptions : {
    currency: 'USD',
    gasPrice: 3
  }
}

const mocha = process.env.GAS_REPORTER ? mochaGasSettings : {}

module.exports = {
  networks: {
    rpc: {
      network_id: '*',
      host: 'localhost',
      port: 8545,
      skipDryRun: true
    },
    ropsten: {
      network_id: 3,
      provider: ropstenProvider,
      gas: 4700036,
      skipDryRun: true
    },
    kovan: {
      network_id: 42,
      provider: kovanProvider,
      gas: 6.9e6,
      skipDryRun: true
    },
    rinkeby: {
      network_id: 4,
      provider: rinkebyProvider,
      gas: 6.9e6,
      gasPrice: 15000000001,
      skipDryRun: true
    },
    mainnet: {
      network_id: 1,
      provider:  function() {
        return new HDWalletProvider(mainnetMnemonic, 'https://mainnet.infura.io/' + infuraKey)
      },
      gas: 6.9e6,
      gasPrice: 15000000001,
      skipDryRun: true
    },    
    coverage: {
      host: "localhost",
      network_id: "*",
      port: 8555,
      gas: 0xffffffffff,
      gasPrice: 0x01
    },
  },
  build: {},
  mocha,
  solc: {
      optimizer: {
          enabled: true,
          runs: 200
      }
  },
}
