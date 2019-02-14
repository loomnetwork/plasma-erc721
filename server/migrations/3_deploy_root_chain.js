const CryptoCards = artifacts.require("CryptoCards");
const LoomToken = artifacts.require("LoomToken")
const RootChain = artifacts.require("RootChain");

module.exports = async function(deployer, network, accounts) {
    let vmcAddress = '0x0000';
    if (network !== "mainnet") {
        vmcAddress = '0xf1ffd3f1598cd054f5031b2af219d85b0d443175';
    }else {
        const vmc = await ValidatorManagerContract.deployed();
        vmcAddress = vmc.address;
    }
    console.log(`ValidatorManagerContract deployed at address: ${vmcAddress}`);


    if (vmcAddress == "0x0000" ) {
        throw "Invalid vmcAddress";
        return
    }
    
    await deployer.deploy(RootChain, vmcAddress);
    const root = await RootChain.deployed();
    console.log(`RootChain deployed at address: ${root.address}`);        
};



