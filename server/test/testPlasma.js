const _ = require('lodash')

const RLP = require('rlp')
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");

const SparseMerkleTree = require('./SparseMerkleTree.js');

import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';
const utils = require('web3-utils');
const ethutil = require('ethereumjs-util');

const Promisify = (inner) =>
new Promise((resolve, reject) =>
        inner((err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        })
);

contract("Plasma ERC721", async function(accounts) {

    let cards;
    let plasma;
    let start;
    let utxo_slot; // the utxo that alice will attempt to withdrawo

    const UTXO_ID = 2

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger] = accounts;

    let exit_coin;
    let data;
    let rawdata;


    let to_alice;

    beforeEach("Deploys the contracts, Registers Alice and deposits her coins", async function() {
        plasma = await RootChain.new({from: authority});
        cards = await CryptoCards.new(plasma.address);
        plasma.setCryptoCards(cards.address);
        cards.register({from: alice});
        assert.equal(await cards.balanceOf.call(alice), 5);


        let ret = createUTXO(0, 0, alice, alice); data = ret[0];
        await cards.depositToPlasmaWithData(1, data, {from: alice});

        ret = createUTXO(1, 0, alice, alice); data = ret[0];
        await cards.depositToPlasmaWithData(2, data, {from: alice});

        ret = createUTXO(2, 0, alice, alice); data = ret[0];
        await cards.depositToPlasmaWithData(3, data, {from: alice});

        to_alice = ret;

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 3);

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        const events = await Promisify(cb => depositEvent.get(cb));
        exit_coin = events[2].args;
        assert.equal(exit_coin.slot.toNumber(), 2);
        assert.equal(exit_coin.depositBlockNumber.toNumber(), 3);
        assert.equal(exit_coin.denomination.toNumber(), 1);
        assert.equal(exit_coin.from, alice);

    });

    it('Tests that Merkle Proofs work', async function() {
        let slot = 1500;
        let tx = createUTXO(slot, 1000, alice, bob);
        let txHash = utils.soliditySha3(tx[0]);

        let leaves = {};
        leaves[slot] = txHash;

        // BUG! proofbits are not properly returned. WIP
        // slot = 63;
        // data = [slot, 2000, bob, charlie];
        // tx = '0x' + RLP.encode(data).toString('hex');
        // txHash = utils.soliditySha3(tx);
        // leaves[slot] = txHash;

        // This will be happening on the Plasma Cash client
        // The root will be submitted by the authority
        let tree = new SparseMerkleTree(64, leaves);
        let proof = tree.createMerkleProof(slot);

        let ret = await plasma.checkMembership(txHash, tree.root, slot, proof);
        assert.equal(ret, true);

    
    });

    it("Submits an exit for the UTXO of Coin 3 (utxo id 2)  directly after depositing it", async function() {
        utxo_slot = exit_coin.slot.toNumber();
        let includedBlock = exit_coin.depositBlockNumber.toNumber();
        let denom = exit_coin.denomination.toNumber();
        let from  = exit_coin.from;

        let ret = createUTXO(2, 0, alice, alice); 
        let utxo = ret[0];
        let sig = ret[1];

        await plasma.startExit(
                 utxo_slot,
                '0x', utxo,  // prevTx, exitingTx
                '0x0', '0x0', // inclusion proofs
                 sig,
                 0, includedBlock, 
                 {'from': alice, 'value': web3.toWei(0.1, 'ether')}
        );

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit
        await increaseTimeTo(expire);

        await plasma.finalizeExits({from: random_guy2 });

        plasma.withdraw(utxo_slot, {from : alice });
        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 3);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);
    });

    it("Cooperative Exit case after 1 Plasma-Chain transfers", async function() {
        let utxo_slot = 2;
        await bobExitAfterOneTransfer();

        let afterExit = web3.eth.getBalance(charlie)
        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit
        await increaseTimeTo(expire);

        await plasma.finalizeExits({from: random_guy2 });
        let c = web3.eth.getBalance(charlie)

        await plasma.withdraw(utxo_slot, {from : bob });
        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        await plasma.withdrawBonds({from: bob });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'});
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, bob);
        assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
    });

    it("Cooperative Exit case after 2 Plasma-Chain transfers", async function() {
        let utxo_slot = 2;
        await charlieExitAfterTwoTransfers();

        let afterExit = web3.eth.getBalance(charlie)

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit
        await increaseTimeTo(expire);

        await plasma.finalizeExits({from: random_guy2 });
        let c = web3.eth.getBalance(charlie)

        await plasma.withdraw(utxo_slot, {from : charlie });
        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        await plasma.withdrawBonds({from: charlie });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'});
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, charlie);
        assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
    });

    it("Bob/Dylan tries to double spend a coin that was supposed to be given to Charlie. Gets Challenged and charlie exits that coin", async function() {
        let utxo_slot = 2;
        let data = await bobDoubleSpend();
        let to_bob = data[0];
        let tree_bob = data[1];
        let to_charlie = data[2];
        let tree_charlie = data[3];

        let challengeTx = to_charlie[0];
        let proof = tree_charlie.createMerkleProof(utxo_slot);
        let block_number = 2000;

        await plasma.challengeBetween(
                utxo_slot, block_number, challengeTx, proof, 
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
        );

        let prev_tx = to_bob[0];
        let exiting_tx = to_charlie[0]; 
        let prev_tx_proof = tree_bob.createMerkleProof(utxo_slot);
        let exiting_tx_proof = tree_charlie.createMerkleProof(utxo_slot);
        let sigs = to_bob[1] + to_charlie[1].substr(2, 132);

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                1000, 2000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
        );

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit
        await increaseTimeTo(expire);
        await plasma.finalizeExits({from: random_guy2 });

        // Dylan shouldn't be able to withdraw the coin.
        assertRevert( plasma.withdraw(utxo_slot, {from : dylan }));
        plasma.withdraw(utxo_slot, {from : charlie });

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
        await plasma.withdrawBonds({from: challenger });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'});
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, challenger);
        assert.equal(withdraw.amount, web3.toWei(0.2, 'ether'));
    });

    it("Bob/Dylan double spend a coin that was supposed to be given to Charlie since nobody challenged", async function() {
        let utxo_slot = 2;
        let data = await bobDoubleSpend();
        let to_bob = data[0];
        let tree_bob = data[1];
        let to_charlie = data[2];
        let tree_charlie = data[3];

        let challengeTx = to_charlie[0];
        let proof = tree_charlie.createMerkleProof(utxo_slot);
        let block_number = 2000;

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit
        await increaseTimeTo(expire);
        await plasma.finalizeExits({from: random_guy2 });

        // Dylan shouldn't be able to withdraw the coin.
        plasma.withdraw(utxo_slot, {from : dylan });

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
        await plasma.withdrawBonds({from: dylan });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'});
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, dylan);
        assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
    });

    it("Charlie tries to exit a spent coin. Dylan challenges in time", async function() {
        let utxo_slot = 2;

        // Charlie receives the coin from Bob as before, but now he sends it to Dylan and tries to exit right after that, ignoring dylan's transaction
        // // Dylan sees this and he challengesj
        let dylanTx = await charlieExitSpentCoin();

        let to_dylan = dylanTx[0];
        let dylan_tree = dylanTx[1];

        let to_charlie = dylanTx[2];
        let tree_charlie = dylanTx[3];

        let block_number = 3000; // dylan's TX was included in block 3000

        // Challenge the double spend
        let challengeTx = to_dylan[0];
        let proof = dylan_tree.createMerkleProof(utxo_slot);
        await plasma.challengeAfter(
                utxo_slot, block_number, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
        );

        // dylan exit
        let prev_tx_proof = tree_charlie.createMerkleProof(utxo_slot)

        let prev_tx = to_charlie[0];
        let exiting_tx = to_dylan[0];

        let sigs = to_charlie[1] + to_dylan[1].substr(2, 132);

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, proof, // proofs from the tree
                sigs, // concatenated signatures
                2000, 3000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
        );

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit

        await increaseTimeTo(expire);
        await plasma.finalizeExits({from: random_guy2 });
        let c = web3.eth.getBalance(charlie)

        // Charlie shouldn't be able to withdraw the coin.
        assertRevert( plasma.withdraw(utxo_slot, {from : charlie }));
        await  plasma.withdraw(utxo_slot, {from : dylan });

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
        await plasma.withdrawBonds({from: challenger });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'});
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, challenger);
        assert.equal(withdraw.amount, web3.toWei(0.2, 'ether'));
    });

    it("Charlie tries to exit a spent coin. Dylan does not challenge in time", async function() {
        let utxo_slot = 2;

        // Charlie receives the coin from Bob as before, but now he sends it to Dylan and tries to exit right after that, ignoring dylan's transaction
        // // Dylan does NOT challenge
        let dylanTx = await charlieExitSpentCoin();

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit

        await increaseTimeTo(expire);
        await plasma.finalizeExits({from: random_guy2 });
        let c = web3.eth.getBalance(charlie)

        // Charlie shouldn't be able to withdraw the coin.
        plasma.withdraw(utxo_slot, {from : charlie });

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
        await plasma.withdrawBonds({from: charlie });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'});
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, charlie);
        assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
    });

    it("Challenges Elliot's exit with challengeBefore. Elliot does NOT respond, as there is no way for him to have a valid proof since the tx was invalid", async function() {
        let utxo_slot = 2;
        let bobTx = await elliotInvalidHistoryExit();
        let to_bob = bobTx[0];
        let tree_bob = bobTx[1];

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit

        // Concatenate the 2 signatures
        let sigs = to_alice[1] + to_bob[1].substr(2,132);
        let tx_proof = tree_bob.createMerkleProof(utxo_slot)

        let prev_tx = to_alice[0];
        let tx = to_bob[0];

        // Challenge before is essentially a challenge where the challenger submits the proof required to exit a coin, claiming that this is the last valid state of a coin. Due to bonds the challenger will only do this when he actually knows that there was an invalid spend. If the challenger is a rational player, there should be no case where respondChallengeBefore should succeed. 
        await plasma.challengeBefore(
                utxo_slot,
                prev_tx , tx, // rlp encoded
                '0x0', tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                3, 1000, 
                 {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
        );

        await increaseTimeTo(expire);
        await plasma.finalizeExits({from: random_guy2 });

        // Charlie shouldn't be able to withdraw the coin.
        assertRevert( plasma.withdraw(utxo_slot, {from : elliot }));

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(elliot)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 3);

        // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
        await plasma.withdrawBonds({from: challenger });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'})
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, challenger);
        assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
    });

    it("Challenges Elliot's exit with challengeBefore. Elliot responds in time", async function() {
        let utxo_slot = 2;
        let bobTx = await elliotValidHistoryExit();
        let to_bob = bobTx[0];
        let tree_bob = bobTx[1];

        let to_charlie = bobTx[2];
        let tree_charlie = bobTx[3];

        start = (await web3.eth.getBlock('latest')).timestamp;
        let expire = start + 3600 * 24 * 8; // 8 days pass, can finalize exit

        // Concatenate the 2 signatures
        let sigs = to_alice[1] + to_bob[1].substr(2,132);
        let proof = tree_bob.createMerkleProof(utxo_slot)

        let prev_tx = to_alice[0];
        let tx = to_bob[0];

        // Challenge before is essentially a challenge where the challenger submits the proof required to exit a coin, claiming that this is the last valid state of a coin. Due to bonds the challenger will only do this when he actually knows that there was an invalid spend. If the challenger is a rational player, there should be no case where respondChallengeBefore should succeed. 
        await plasma.challengeBefore(
                utxo_slot,
                prev_tx , tx, // rlp encoded
                '0x0', proof, // proofs from the tree
                sigs, // concatenated signatures
                3, 1000, 
                 {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
        );
        

        let responseTx = to_charlie[0];
        let responseProof = tree_charlie.createMerkleProof(utxo_slot);

        await plasma.respondChallengeBefore(
                utxo_slot, 2000, responseTx, responseProof,
                {'from': elliot }
        );


        await increaseTimeTo(expire);
        await plasma.finalizeExits({from: random_guy2 });
        let c = web3.eth.getBalance(charlie)

        await plasma.withdraw(utxo_slot, {from : elliot });

        assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
        assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
        assert.equal((await cards.balanceOf.call(elliot)).toNumber(), 1);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

        await plasma.withdrawBonds({from: elliot });
        
        let withdrawedBonds = plasma.WithdrawedBonds({}, {fromBlock: 0, toBlock: 'latest'})
        let e = await Promisify(cb => withdrawedBonds.get(cb));
        let withdraw = e[0].args;
        assert.equal(withdraw.from, elliot);
        assert.equal(withdraw.amount, web3.toWei(0.2, 'ether'));
    });

    /********** UTILS ********/

    function signHash(from, hash) {
        let sig = (web3.eth.sign(from, hash)).slice(2);

        let r = ethutil.toBuffer('0x' + sig.substring(0, 64));
        let s = ethutil.toBuffer('0x' + sig.substring(64, 128));
        let v = ethutil.toBuffer(parseInt(sig.substring(128, 130), 16) + 27);
        let mode = ethutil.toBuffer(1); // mode = geth

        let signature = '0x' + Buffer.concat([mode, r, s, v]).toString('hex');
        return signature;
    }

    // Scenarios!

    async function bobExitAfterOneTransfer() {
        let leaves = {};
        let utxo_slot = 2;

        // Block 3: Transaction from Alice root -> Alice 
        // Block 1000: Transaction from Alice to Bob
        
        let to_bob = createUTXO(utxo_slot, 3, alice, bob);
        let tree_bob = await submitUTXO(utxo_slot, to_bob[0]);
       
        // Concatenate the 2 signatures
        let sigs = to_alice[1] + to_bob[1].substr(2,132);
        let exiting_tx_proof = tree_bob.createMerkleProof(utxo_slot)

        let prev_tx = to_alice[0];
        let exiting_tx = to_bob[0];

        plasma.startExit(
                utxo_slot,
                prev_tx , exiting_tx, // rlp encoded
                '0x0', exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                3, 1000, // alice_deposit->alice 3, alice-> bob 1000
                 {'from': bob, 'value': web3.toWei(0.1, 'ether')}
        );
    }




    async function charlieExitAfterTwoTransfers() {
        let leaves = {};
        let utxo_slot = 2;

        // Block 1000: Transaction from Alice to Bob
        // Block 2000: Transaction from Bob to Charlie
        
        let to_bob = createUTXO(utxo_slot, 3, alice, bob);
        // submits tree root frmo authority
        let tree_bob = await submitUTXO(utxo_slot, to_bob[0]);

        // Tx to Charlie from Bob referencing Bob's UTXO at block 1000
        let to_charlie = createUTXO(utxo_slot, 1000, bob, charlie);
        let tree_charlie = await submitUTXO(utxo_slot, to_charlie[0]);
       
        // Concatenate the 2 signatures
        let sigs = to_bob[1] + to_charlie[1].substr(2, 132);

        let prev_tx_proof = tree_bob.createMerkleProof(utxo_slot)
        let exiting_tx_proof = tree_charlie.createMerkleProof(utxo_slot)

        let prev_tx = to_bob[0];
        let exiting_tx = to_charlie[0];

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                1000, 2000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
        );
    }

    async function charlieExitSpentCoin() {
        let leaves = {};
        let utxo_slot = 2;

        // Block 1000: Transaction from Alice to Bob
        // Block 2000: Transaction from Bob to Charlie
        
        let to_bob = createUTXO(utxo_slot, 3, alice, bob);
        // submits tree root frmo authority
        let tree_bob = await submitUTXO(utxo_slot, to_bob[0]);

        // Tx to Charlie from Bob referencing Bob's UTXO at block 1000
        let to_charlie = createUTXO(utxo_slot, 1000, bob, charlie);
        let tree_charlie = await submitUTXO(utxo_slot, to_charlie[0]);

        // Tx to Dylan from Charlie referencing Charlie's UTXO at block 2000
        let to_dylan = createUTXO(utxo_slot, 2000, charlie, dylan);
        let tree_dylan = await submitUTXO(utxo_slot, to_dylan[0]);

        // Concatenate the 2 signatures
        let sigs = to_bob[1] + to_charlie[1].substr(2, 132);

        let prev_tx_proof = tree_bob.createMerkleProof(utxo_slot)
        let exiting_tx_proof = tree_charlie.createMerkleProof(utxo_slot)

        let prev_tx = to_bob[0];
        let exiting_tx = to_charlie[0];

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                1000, 2000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
        );

        return [to_dylan, tree_dylan, to_charlie, tree_charlie];
    }

    async function bobDoubleSpend() {
        let leaves = {};
        let utxo_slot = 2;

        // Block 1000: Transaction from Alice to Bob
        // Block 2000: Transaction from Bob to Charlie
        // Block 3000: Transaction from Charlie to Dylan
        
        let to_bob = createUTXO(utxo_slot, 3, alice, bob);
        // submits tree root frmo authority
        let tree_bob = await submitUTXO(utxo_slot, to_bob[0]);

        // Tx to Charlie from Bob referencing Bob's UTXO at block 1000
        let to_charlie = createUTXO(utxo_slot, 1000, bob, charlie);
        let tree_charlie = await submitUTXO(utxo_slot, to_charlie[0]);

        // Tx to Dylan from Bob referencing Charlie's UTXO at block 2000
        // Dylan is an address which is controlled by Bob or colludes by Bob to steal Charlie's coin
        let to_dylan = createUTXO(utxo_slot, 1000, bob, dylan);
        let tree_dylan = await submitUTXO(utxo_slot, to_dylan[0]);

        // Dylan-Bob now tries to exit the coin.
        let sigs = to_bob[1] + to_dylan[1].substr(2, 132);

        let prev_tx_proof = tree_bob.createMerkleProof(utxo_slot)
        let exiting_tx_proof = tree_dylan.createMerkleProof(utxo_slot)

        let prev_tx = to_bob[0];
        let exiting_tx = to_dylan[0]; 

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                1000, 3000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
        );

        return [to_bob, tree_bob, to_charlie, tree_charlie];
    }

  async function elliotInvalidHistoryExit() {
        let utxo_slot = 2;
        let to_bob = createUTXO(utxo_slot, 3, alice, bob);
        let tree_bob = await submitUTXO(utxo_slot, to_bob[0]);

        // The authority submits a block, but there is no transaction from Bob to Charlie
        let tree_charlie = await submitUTXO();

        // Nevertheless, Charlie pretends he received the coin, and by colluding with the chain operator he is able to include his invalid transaction in a block.
        let to_dylan = createUTXO(utxo_slot, 2000, charlie, dylan);
        let tree_dylan = await submitUTXO(utxo_slot, to_dylan[0]);

        // Dylan having received the coin, gives it to Elliot. 
        let to_elliot = createUTXO(utxo_slot, 3000, dylan, elliot);
        let tree_elliot = await submitUTXO(utxo_slot, to_elliot[0]);
        
        // Elliot normally should be always checking the coin's history and not accepting the payment if it's invalid like in this case, but it is considered that they are all colluding together to steal Bob's coin.;
        // Elliot actually has all the info required to submit an exit, even if one of the transactions in the coin's history were invalid. 
        let sigs = to_dylan[1] + to_elliot[1].substr(2, 132);

        let prev_tx_proof = tree_dylan.createMerkleProof(utxo_slot)
        let exiting_tx_proof = tree_elliot.createMerkleProof(utxo_slot)

        let prev_tx = to_dylan[0];
        let exiting_tx = to_elliot[0]; 

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                3000, 4000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
        );

        return [to_bob, tree_bob];
    
    }

    async function elliotValidHistoryExit() {
        let utxo_slot = 2;
        let to_bob = createUTXO(utxo_slot, 3, alice, bob);
        let tree_bob = await submitUTXO(utxo_slot, to_bob[0]);

        // The authority submits a block, but there is no transaction from Bob to Charlie
        let to_charlie = createUTXO(utxo_slot, 1000, bob, charlie);
        let tree_charlie = await submitUTXO(utxo_slot, to_charlie[0]);

        // Nevertheless, Charlie pretends he received the coin, and by colluding with the chain operator he is able to include his invalid transaction in a block.
        let to_dylan = createUTXO(utxo_slot, 2000, charlie, dylan);
        let tree_dylan = await submitUTXO(utxo_slot, to_dylan[0]);

        // Dylan having received the coin, gives it to Elliot. 
        let to_elliot = createUTXO(utxo_slot, 3000, dylan, elliot);
        let tree_elliot = await submitUTXO(utxo_slot, to_elliot[0]);
        
        // Elliot normally should be always checking the coin's history and not accepting the payment if it's invalid like in this case, but it is considered that they are all colluding together to steal Bob's coin.;
        // Elliot actually has all the info required to submit an exit, even if one of the transactions in the coin's history were invalid. 
        let sigs = to_dylan[1] + to_elliot[1].substr(2, 132);

        let prev_tx_proof = tree_dylan.createMerkleProof(utxo_slot)
        let exiting_tx_proof = tree_elliot.createMerkleProof(utxo_slot)

        let prev_tx = to_dylan[0];
        let exiting_tx = to_elliot[0]; 

        plasma.startExit(
                utxo_slot,
                prev_tx, exiting_tx, // rlp encoded
                prev_tx_proof, exiting_tx_proof, // proofs from the tree
                sigs, // concatenated signatures
                3000, 4000, // 1000 is when alice->bob got included, 2000 for bob->charlie
                 {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
        );

        return [to_bob, tree_bob, to_charlie, tree_charlie];
    
    }

  function createUTXO(slot, prevBlock, from, to) {
        let data = [ slot, prevBlock, 1, to ];
        data = '0x' + RLP.encode(data).toString('hex');
        let txHash = utils.soliditySha3(data);
        let sig = signHash(from, txHash); // prefixed signature on the hash
        return [data, sig];
    }

    async function submitUTXO(slot, tx) {
        // Create merkle Tree from A SINGLE UTXO and submit it.
        // Returns merkle tree that was created
        let tree;
        if (tx) {
            let leaves = {}
            leaves[slot] = utils.soliditySha3(tx);
            tree = new SparseMerkleTree(64, leaves);
        } else {
            tree = new SparseMerkleTree(64);
        }

        await plasma.submitBlock(tree.root, {'from': authority});

        return tree;
    }
});
