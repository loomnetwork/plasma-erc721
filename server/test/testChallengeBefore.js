const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");
import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

contract("Plasma ERC721 - Invalid History Challenge / `challengeBefore`", async function(accounts) {

    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;
    const COINS = [1, 2, 3];

    let cards;
    let plasma;
    let vmc;
    let events;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger] = accounts;


    beforeEach(async function() {
        vmc = await ValidatorManagerContract.new({from: authority});
        plasma = await RootChain.new(vmc.address, {from: authority});
        cards = await CryptoCards.new(plasma.address);
        await vmc.toggleToken(cards.address);
        cards.register({from: alice});
        assert.equal(await cards.balanceOf.call(alice), 5);

        let ret;
        for (let i = 0; i < ALICE_DEPOSITED_COINS; i ++) {
            await cards.depositToPlasma(COINS[i], {from: alice});
        }


        assert.equal((await cards.balanceOf.call(alice)).toNumber(), ALICE_INITIAL_COINS - ALICE_DEPOSITED_COINS);
        assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), ALICE_DEPOSITED_COINS);

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        events = await txlib.Promisify(cb => depositEvent.get(cb));

        // Check that events were emitted properly
        let coin;
        for (let i = 0; i < events.length; i++) {
            coin = events[i].args;
            assert.equal(coin.blockNumber.toNumber(), i+1);
            assert.equal(coin.denomination.toNumber(), 1);
            assert.equal(coin.from, alice);
        }

    });

    describe('Invalid Exit of UTXO 2', function() {

        it("Elliot tries to exit a coin that has invalid history. Elliot's exit gets challenged with challengeBefore w/o response as there is no valid transaction to respond with", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};
            let ret = await elliotInvalidHistoryExit(UTXO);
            let alice_to_bob = ret.data;
            let tree_bob = ret.tree;

            // Concatenate the 2 signatures
            let sig = alice_to_bob.sig;
            let tx_proof = tree_bob.createMerkleProof(UTXO.slot)

            let prev_tx = txlib.createUTXO(UTXO.slot, 0, alice, alice).tx;
            let tx = alice_to_bob.tx;

            // Challenge before is essentially a challenge where the challenger
            // submits the proof required to exit a coin, claiming that this is
            // the last valid state of a coin. Due to bonds the challenger will
            // only do this when he actually knows that there was an invalid
            // spend. If the challenger is a rational player, there should be
            // no case where respondChallengeBefore should succeed.
            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , tx, // rlp encoded
                '0x0', tx_proof, // proofs from the tree
                sig, // concatenated signatures
                [UTXO.block, 1000],
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo( t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2});

            // Charlie shouldn't be able to withdraw the coin.
            assertRevert(plasma.withdraw(UTXO.slot, {from : elliot}));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(elliot), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await txlib.withdrawBonds(plasma, challenger, 0.1);
        });

        it("Elliot makes a valid exit which gets challenged, however he responds with `respondChallengeBefore`", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};
            let ret = await elliotValidHistoryExit(UTXO);
            let alice_to_bob = ret.bob.data;
            let tree_bob = ret.bob.tree;
            let bob_to_charlie = ret.charlie.data;
            let tree_charlie = ret.charlie.tree;

            t0 = (await web3.eth.getBlock('latest')).timestamp;

            // Concatenate the 2 signatures
            let sig = alice_to_bob.sig;
            let proof = tree_bob.createMerkleProof(UTXO.slot)

            let prev_tx = txlib.createUTXO(UTXO.slot, 0, alice, alice).tx;
            let tx = alice_to_bob.tx;

            // Challenge before is essentially a challenge where the challenger
            // submits the proof required to exit a coin, claiming that this is
            // the last valid state of a coin. Due to bonds the challenger will
            // only do this when he actually knows that there was an invalid
            // spend. If the challenger is a rational player, there should be
            // no case where respondChallengeBefore should succeed.
            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , tx, // rlp encoded
                '0x0', proof, // proofs from the tree
                sig, // concatenated signatures
                [3, 1000],
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            let responseTx = bob_to_charlie.tx;
            sig = bob_to_charlie.sig;
            let responseProof = tree_charlie.createMerkleProof(UTXO.slot);

            await plasma.respondChallengeBefore(
                UTXO.slot, 2000, responseTx, responseProof, sig,
                {'from': elliot}
            );


            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2});
            await plasma.withdraw(UTXO.slot, {from : elliot});

            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(elliot)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

            await txlib.withdrawBonds(plasma, elliot, 0.2);
        });

        it("Elliot tries to exit a coin that has invalid history. Elliot's exit gets challenged with challengeBefore. Elliot tries to provide an invalid response and fails", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_1000 = await txlib.submitTransactions(authority, plasma, txs);

            // Charlie creates a false transaction to himself and colludes with the operator to include it
            let bob_to_charlie = txlib.createUTXO(UTXO.slot, UTXO.block, charlie, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_2000 = await txlib.submitTransactions(authority, plasma, txs);

            // Charlie starts moving his coin around (Dylan/Elliot are Charlie's friends)
            let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
            txs = [charlie_to_dylan.leaf]
            let tree_3000 = await txlib.submitTransactions(authority, plasma, txs);
            let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
            txs = [dylan_to_elliot.leaf]
            let tree_4000 = await txlib.submitTransactions(authority, plasma, txs);

            // Elliot normally should be always checking the coin's history and
            // not accepting the payment if it's invalid like in this case, but
            // it is considered that they are all colluding together to steal
            // Bob's coin.  Elliot actually has all the info required to submit
            // an exit, even if one of the transactions in the coin's history
            // were invalid.
            let sig = dylan_to_elliot.sig;

            let prev_tx_proof = tree_3000.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_4000.createMerkleProof(UTXO.slot)

            let prev_tx = charlie_to_dylan.tx;
            let exiting_tx = dylan_to_elliot.tx;

            plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [3000, 4000],
                {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
            );

            // Challenger sees the invalid exit and proceeds to `challengeBefore`
            // If the challenger is honest, 
            // then there is no valid response to the challenge
            sig = alice_to_bob.sig;
            let tx_proof = tree_1000.createMerkleProof(UTXO.slot)
            prev_tx = txlib.createUTXO(UTXO.slot, 0, alice, alice).tx;
            let tx = alice_to_bob.tx;

            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , tx, // rlp encoded
                '0x0', tx_proof, // proofs from the tree
                sig, // concatenated signatures
                [UTXO.block, 1000],
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            // The colluding parties try to respond with their invalid transaction
            // included in block 2000, but fail.
            sig = bob_to_charlie.sig;
            tx_proof = tree_2000.createMerkleProof(UTXO.slot)
            tx = bob_to_charlie.tx;

            assertRevert(plasma.respondChallengeBefore(
                UTXO.slot,
                2000,
                tx,
                tx_proof,
                sig,
                {'from': elliot}
            ));

            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo( t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2});

            // Elliot shouldn't be able to withdraw the coin.
            assertRevert(plasma.withdraw(UTXO.slot, {from : elliot}));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(elliot), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            // // On the contrary, his bond must be slashed, and `challenger` must be able to claim it
            await txlib.withdrawBonds(plasma, challenger, 0.1);
        });

        async function elliotInvalidHistoryExit(UTXO) {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            // The authority submits a block, but there is no transaction from Bob to Charlie
            let tree_charlie = await txlib.submitTransactions(authority, plasma);

            // Nevertheless, Charlie pretends he received the coin, and by
            // colluding with the chain operator he is able to include his
            // invalid transaction in a block.
            let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
            txs = [charlie_to_dylan.leaf]
            let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

            // Dylan having received the coin, gives it to Elliot.
            let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
            txs = [dylan_to_elliot.leaf]
            let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);

            // Elliot normally should be always checking the coin's history and
            // not accepting the payment if it's invalid like in this case, but
            // it is considered that they are all colluding together to steal
            // Bob's coin.  Elliot actually has all the info required to submit
            // an exit, even if one of the transactions in the coin's history
            // were invalid.
            let sig = dylan_to_elliot.sig;

            let prev_tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)

            let prev_tx = charlie_to_dylan.tx;
            let exiting_tx = dylan_to_elliot.tx;

            plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [3000, 4000],
                {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
            );

            return {'data' : alice_to_bob, 'tree': tree_bob};

        }

        async function elliotValidHistoryExit(UTXO) {
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            // The authority submits a block, but there is no transaction from Bob to Charlie
            let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

            // Nevertheless, Charlie pretends he received the coin, and by
            // colluding with the chain operator he is able to include his
            // invalid transaction in a block.
            let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
            txs = [charlie_to_dylan.leaf]
            let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

            // Dylan having received the coin, gives it to Elliot.
            let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
            txs = [dylan_to_elliot.leaf]
            let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);

            // Elliot normally should be always checking the coin's history and
            // not accepting the payment if it's invalid like in this case, but
            // it is considered that they are all colluding together to steal
            // Bob's coin. Elliot actually has all the info required to submit
            // an exit, even if one of the transactions in the coin's history
            // were invalid.
            let sig = dylan_to_elliot.sig;

            let prev_tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)

            let prev_tx = charlie_to_dylan.tx;
            let exiting_tx = dylan_to_elliot.tx;

            plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [3000, 4000],
                {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
            );

            return {
                'bob': {'data': alice_to_bob, 'tree': tree_bob},
                'charlie': {'data': bob_to_charlie, 'tree': tree_charlie}
            };

        }

    })
});
