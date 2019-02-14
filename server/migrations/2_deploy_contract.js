const CryptoCards = artifacts.require("CryptoCards");
const LoomToken = artifacts.require("LoomToken")
const RootChain = artifacts.require("RootChain");
const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");

module.exports = async function(deployer, network, accounts) {

    deployer.deploy(ValidatorManagerContract).then(async () => {
        const vmc = await ValidatorManagerContract.deployed();
        console.log(`ValidatorManagerContract deployed at address: ${vmc.address}`);
    });
};

