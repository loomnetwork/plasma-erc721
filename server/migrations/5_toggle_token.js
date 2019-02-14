const CryptoCards = artifacts.require("CryptoCards");
const LoomToken = artifacts.require("LoomToken")
const RootChain = artifacts.require("RootChain");
const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");

module.exports = async function(deployer, network, accounts) {
    const vmc = await ValidatorManagerContract.deployed();
    const cards = await CryptoCards.deployed();
        
    await vmc.toggleToken(cards.address);
};



