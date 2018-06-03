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

contract("Plasma ERC721 - Double Spend Challenge / `challengeBetween`", async function(accounts) {

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
        let UTXO = { 'slot' : 2, 'block': 3 };

        it("Bob/Dylan tries to double spend a coin that was supposed to be given to Charlie. Gets Challenged and charlie exits that coin", async function() {
            let ret = await bobDoubleSpend(UTXO);
            let alice_to_bob = ret.bob.data;
            let tree_bob = ret.bob.tree;
            let bob_to_charlie = ret.charlie.data;
            let tree_charlie = ret.charlie.tree;

            let challengeTx = bob_to_charlie.tx;
            let proof = tree_charlie.createMerkleProof(UTXO.slot);
            let block_number = 2000; // Charlie's transaction which is the valid one was included at block 2000

            await plasma.challengeBetween(
                UTXO.slot, block_number, challengeTx, proof,
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            let prev_tx = alice_to_bob.tx;
            let exiting_tx = bob_to_charlie.tx;
            let prev_tx_proof = tree_bob.createMerkleProof(UTXO.slot);
            let exiting_tx_proof = tree_charlie.createMerkleProof(UTXO.slot);
            let sigs = alice_to_bob.sig + bob_to_charlie.sig.replace('0x', '');

            plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sigs, 
                1000, 2000, 
                {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });

            // Dylan shouldn't be able to withdraw the coin.
            assertRevert( plasma.withdraw(UTXO.slot, {from : dylan }));
            plasma.withdraw(UTXO.slot, {from : charlie });

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 1);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 2);

            // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await txlib.withdrawBonds(plasma, challenger, 0.1 * 2);
        });

        it("Bob/Dylan double spend a coin that was supposed to be given to Charlie since nobody challenged", async function() {
            await bobDoubleSpend(UTXO);
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });

            // Dylan successfully stole Charlie's coin since noone challenged
            plasma.withdraw(UTXO.slot, {from : dylan });

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 1);
            assert.equal(await cards.balanceOf.call(plasma.address), 2);

            await txlib.withdrawBonds(plasma, dylan, 0.1);
        });

        async function bobDoubleSpend(UTXO) {
            // Block 1000: Transaction from Alice to Bob
            // Block 2000: Transaction from Bob to Charlie
            // Block 3000: Transaction from Bob to Dylan

            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [ alice_to_bob.leaf ];
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            // Tx to Charlie from Bob referencing Bob's UTXO at block 1000
            let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
            txs = [ bob_to_charlie.leaf ];
            let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

            // Tx to Dylan from Bob referencing Charlie's UTXO at block 2000
            // Dylan is an address which is controlled by Bob or colludes by Bob to steal Charlie's coin
            let bob_to_dylan = txlib.createUTXO(UTXO.slot, 1000, bob, dylan);
            txs = [ bob_to_dylan.leaf ];
            let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

            // Dylan-Bob now tries to exit the coin.
            let sigs = alice_to_bob.sig + bob_to_dylan.sig.replace('0x', '');

            let prev_tx_proof = tree_bob.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_dylan.createMerkleProof(UTXO.slot)

            let prev_tx = alice_to_bob.tx;
            let exiting_tx = bob_to_dylan.tx;

            plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx, 
                prev_tx_proof, exiting_tx_proof, 
                sigs, 
                1000, 3000, 
                {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
            );

            return {
                'bob' : {'data': alice_to_bob, 'tree':  tree_bob}, 
                'charlie' : {'data' : bob_to_charlie, 'tree': tree_charlie}
            };
        }

    });
});
