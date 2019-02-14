const CryptoCards = artifacts.require("CryptoCards");
const LoomToken = artifacts.require("LoomToken")
const RootChain = artifacts.require("RootChain");
const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");

module.exports = async function(deployer, network, accounts) {
    const vmc = await ValidatorManagerContract.deployed();
    const root = await RootChain.deployed();


    await deployer.deploy(CryptoCards, root.address);
    const cards = await CryptoCards.deployed();
    console.log(`CryptoCards deployed at address: ${cards.address}`);
    
    // Main net configuration be careful !!!
    if (network !== "mainnet") {
        await deployer.deploy(LoomToken, root.address);
        const erc20 = await LoomToken.deployed();
        console.log(`Loom deployed at address: ${erc20.address}`);
    }
};



