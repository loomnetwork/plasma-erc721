const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");

const SparseMerkleTree = require('./SparseMerkleTree.js');

import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

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

contract("Plasma ERC721 - Exit Spent Coin Challenge / `challengeAfter`", async function(accounts) {

    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;
    const COINS = [ 1, 2, 3];

    let cards;
    let plasma;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger] = accounts;

    let data;
    let deposit_to_alice = [];

    beforeEach(async function() {
        plasma = await RootChain.new({from: authority});
        cards = await CryptoCards.new(plasma.address);
        plasma.setCryptoCards(cards.address);
        cards.register({from: alice});
        assert.equal(await cards.balanceOf.call(alice), 5);

        let ret;
        for (let i = 0; i < ALICE_DEPOSITED_COINS; i ++) {
            ret = txlib.createUTXO(i, 0, alice, alice);
            data = ret.tx;
            await cards.depositToPlasmaWithData(COINS[i], data, {from: alice});
            deposit_to_alice.push(ret);
        }


        assert.equal((await cards.balanceOf.call(alice)).toNumber(), ALICE_INITIAL_COINS - ALICE_DEPOSITED_COINS);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), ALICE_DEPOSITED_COINS);

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        const events = await Promisify(cb => depositEvent.get(cb));

        // Check that events were emitted properly
        let coin;
        for (let i = 0; i < events.length; i++) {
            coin = events[i].args;
            assert.equal(coin.slot.toNumber(), i);
            assert.equal(coin.depositBlockNumber.toNumber(), i+1);
            assert.equal(coin.denomination.toNumber(), 1);
            assert.equal(coin.from, alice);
        }

    });

    describe('Invalid Exit of UTXO 2', function() {
        let UTXO = { 'slot' : 2, 'block' : 3 };

        it("Charlie tries to exit a spent coin. Dylan challenges in time and exits his coin", async function() {
            let ret = await charlieExitSpentCoin(UTXO);
            let bob_to_charlie = ret.charlie.data;
            let tree_charlie = ret.charlie.tree;
            let charlie_to_dylan = ret.dylan.data;
            let tree_dylan = ret.dylan.tree
            let block_number = 3000; // dylan's TX was included in block 3000

            // Challenge the `Exit Spent Coin`
            let challengeTx = charlie_to_dylan.tx;
            let proof = tree_dylan.createMerkleProof(UTXO.slot);
            await plasma.challengeAfter(
                UTXO.slot, 
                block_number, 
                challengeTx, 
                proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            await increaseTimeTo( t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });

            // The exit was deleted so Charlie is not able to withdraw the coin
            assertRevert( plasma.withdraw(UTXO.slot, {from : charlie }));

            // Dylan will exit his coin now. This is the same as the cooperative exit case
            let prev_tx_proof = tree_charlie.createMerkleProof(UTXO.slot)
            let prev_tx = bob_to_charlie.tx;
            let exiting_tx = charlie_to_dylan.tx;
            let sigs = bob_to_charlie.sig + charlie_to_dylan.sig.replace('0x', '');

            plasma.startExit(
                    UTXO.slot,
                    prev_tx, exiting_tx, 
                    prev_tx_proof, proof,
                    sigs, 
                    2000, 3000, 
                     {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            await plasma.withdraw(UTXO.slot, {from : dylan });

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 1);
            assert.equal(await cards.balanceOf.call(plasma.address), 2);

            // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await txlib.withdrawBonds(plasma, challenger, 0.1 * 2)
        });

        it("Charlie tries to exit a spent coin. Dylan does not challenge in time", async function() {
            await charlieExitSpentCoin(UTXO);

            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo( t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });

            // Charlie can steal the coin
            plasma.withdraw(UTXO.slot, {from : charlie });

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 1);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 2);

            // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await txlib.withdrawBonds(plasma, charlie, 0.1)
        });

        async function charlieExitSpentCoin(UTXO) {

            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [ alice_to_bob.leaf ]
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            // Tx to Charlie from Bob referencing Bob's UTXO at block 1000
            let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
            txs = [ bob_to_charlie.leaf ]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

            // Tx to Dylan from Charlie referencing Charlie's UTXO at block 2000
            let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
            txs = [ charlie_to_dylan.leaf ]
            let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

            // Concatenate the 2 signatures
            let sigs = alice_to_bob.sig + bob_to_charlie.sig.replace('0x', '');

            let prev_tx_proof = tree_bob.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_charlie.createMerkleProof(UTXO.slot)

            let prev_tx = alice_to_bob.tx;
            let exiting_tx = bob_to_charlie.tx;

            // Charlie exits the coin, even though he sent the tx to Dylan.
            plasma.startExit(
                    UTXO.slot,
                    prev_tx, exiting_tx, 
                    prev_tx_proof, exiting_tx_proof, 
                    sigs, 
                    1000, 2000, 
                     {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
            );

            return {
                'charlie' : { 'data' : bob_to_charlie, 'tree': tree_charlie},
                'dylan' : { 'data' : charlie_to_dylan, 'tree' : tree_dylan }
            };
        }
    })

    describe('Invalid Exit of UTXO 0', function() {
        let UTXO = [ {'slot' : 0, 'block' : 1 }, { 'slot' : 2, 'block' : 3 }];

        it("Alice gives a coin to Bob and Charlie and immediately tries to exit Bob's coin. Gets Challenged.", async function() {
            let alice_to_bob = txlib.createUTXO(UTXO[0].slot, UTXO[0].block, alice, bob);
            let alice_to_charlie = txlib.createUTXO(UTXO[1].slot, UTXO[1].block, alice, charlie);
            let txs = [ alice_to_bob.leaf, alice_to_charlie.leaf ]
            let tree = await txlib.submitTransactions(authority, plasma, txs);

            let slot = UTXO[0].slot;
            let ret = txlib.createUTXO(slot, 0, alice, alice);
            let utxo = ret.tx;
            let sig = ret.sig

            await plasma.startExit(
                     slot,
                    '0x', utxo,
                    '0x0', '0x0', 
                     sig,
                     0, UTXO[0].block,
                     {'from': alice, 'value': web3.toWei(0.1, 'ether')}
            );

            let challengeTx = alice_to_bob.tx;
            let proof = tree.createMerkleProof(slot);
            await plasma.challengeAfter(
                slot, 1000, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            assertRevert(plasma.withdraw(slot, {from : alice }));
            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            await plasma.withdrawBonds({from: challenger });

            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, challenger);
            assert.equal(withdraw.amount, web3.toWei(0.2, 'ether'));
        });

        it("Alice gives a coin to Bob and Charlie. Bob gives a coin to Charlie and immediately tries to exit it. Gets Challenged", async function() {
            let alice_to_bob = txlib.createUTXO(UTXO[0].slot, UTXO[0].block, alice, bob);
            let alice_to_charlie = txlib.createUTXO(UTXO[1].slot, UTXO[1].block, alice, charlie);
            let txs = [ alice_to_bob.leaf, alice_to_charlie.leaf ]
            let tree1 = await txlib.submitTransactions(authority, plasma, txs);

            let bob_to_charlie = txlib.createUTXO(UTXO[0].slot, 1000, bob, charlie);
            txs = [ bob_to_charlie.leaf ];
            let tree2 = await txlib.submitTransactions(authority, plasma, txs);

            let slot = UTXO[0].slot;
            let sigs = deposit_to_alice[slot].sig + alice_to_bob.sig.replace('0x','');
            let exiting_tx_proof = tree1.createMerkleProof(slot);

            let prev_tx = deposit_to_alice[slot].tx;
            let exiting_tx = alice_to_bob.tx;
            await plasma.startExit(
                     slot,
                     prev_tx, exiting_tx,
                     '0x0', exiting_tx_proof, 
                     sigs,
                     UTXO[0].block, 1000,
                     {'from': bob, 'value': web3.toWei(0.1, 'ether')}
            );

            let challengeTx = bob_to_charlie.tx;
            let proof = tree2.createMerkleProof(slot);
            await plasma.challengeAfter(
                slot, 2000, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            assertRevert(plasma.withdraw(0, {from : bob }));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            await txlib.withdrawBonds(plasma, challenger, 0.2);
        });
    });
});
