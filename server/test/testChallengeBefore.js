const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");
import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

contract("Plasma ERC721 - Invalid History Challenge / `challengeBefore`", async function(accounts) {

    const RESPONSE_PERIOD = 3600 * 24 * 3.5; // 3.5 days later
    const MATURITY_PERIOD = 3600 * 24 * 7; // 3.5 days later
    const e = 3600;

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;
    const COINS = [1, 2, 3];

    let cards;
    let plasma;
    let vmc;
    let events;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, fred, random_guy, random_guy2, challenger] = accounts;


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

    describe('Without Responses', function() {
        it("Directly after deposit", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

            // The authority submits a block, but there is no transaction from Alice to Bob
            let tree_bob = await txlib.submitTransactions(authority, plasma);

            // Nevertheless, Bob pretends he received the coin, and by
            // colluding with the chain operator he is able to include his
            // invalid transaction in a block.
            let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
            let txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

            // Charlie having received the coin, gives it to Dylan.
            let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
            txs = [charlie_to_dylan.leaf]
            let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

            // Dylan normally should be always checking the coin's history and
            // not accepting the payment if it's invalid like in this case, but
            // it is considered that they are all colluding together to steal
            // Alice's coin.  Dylan has all the info required to submit
            // an exit, even if one of the transactions in the coin's history
            // were invalid.
            let sig = charlie_to_dylan.sig;
            let prev_tx_proof = tree_charlie.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
            let prev_tx = bob_to_charlie.tx;
            let exiting_tx = charlie_to_dylan.tx;

            // Dylan submits the invalid exit and waits.
            await plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [2000, 3000],
                {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            // Alice has seen the collusion scheme and submits a challenge
            let alice_to_alice = txlib.createUTXO(UTXO.slot, 0, alice, alice);
            await plasma.challengeBefore(
                UTXO.slot,
                '0x0' , alice_to_alice.tx, 
                '0x0', '0x0', 
                alice_to_alice.sig,
                [0, UTXO.block],
                {'from': alice, 'value': web3.toWei(0.1, 'ether')}
            );

            // Go a litle after the maturity period
            await increaseTimeTo(t0 + MATURITY_PERIOD + e);
            await plasma.finalizeExits({from: random_guy2});

            // Dylan shouldn't be able to withdraw the coin.
            assertRevert(plasma.withdraw(UTXO.slot, {from : dylan}));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(elliot), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            // Alice is able to get both her bond and Dylan's invalid exit bond
            await txlib.withdrawBonds(plasma, alice, 0.2);
        });

        it("After 1 transfer", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

            // Alice gives her coin legitimately to Bob
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
            // Bob's coin.  Elliot has all the info required to submit
            // an exit, even if one of the transactions in the coin's history
            // were invalid.
            let sig = dylan_to_elliot.sig;
            let prev_tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)
            let prev_tx = charlie_to_dylan.tx;
            let exiting_tx = dylan_to_elliot.tx;

            // Elliot submits the invalid exit and waits
            await plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [3000, 4000],
                {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            // Bob has seen the collusion scheme and challenges
            sig = alice_to_bob.sig;
            let tx_proof = tree_bob.createMerkleProof(UTXO.slot)
            prev_tx = txlib.createUTXO(UTXO.slot, 0, alice, alice).tx;
            let tx = alice_to_bob.tx;
            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , tx,
                '0x0', tx_proof,
                sig,
                [UTXO.block, 1000],
                {'from': bob, 'value': web3.toWei(0.1, 'ether')}
            );
            await increaseTimeTo(t0 + MATURITY_PERIOD + e);
            await plasma.finalizeExits({from: random_guy2});

            // Elliot shouldn't be able to withdraw the coin.
            assertRevert(plasma.withdraw(UTXO.slot, {from : elliot}));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(elliot), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            // Bob is able to get both her bond and Elliot's invalid exit bond
            await txlib.withdrawBonds(plasma, bob, 0.2);
        });

        it("After 2 transfers", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

            // Alice gives her coin legitimately to Bob
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            // Bob gives his coin legitimately to Charlie
            let bob_to_charlie = txlib.createUTXO(UTXO.slot, UTXO.block, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

            // The authority submits a block, but there is no transaction from Charlie to Dylan
            let tree_dylan = await txlib.submitTransactions(authority, plasma);

            // Nevertheless, Dylan pretends he received the coin, and by
            // colluding with the chain operator he is able to include his
            // invalid transaction in a block.
            let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 4000, dylan, elliot);
            txs = [dylan_to_elliot.leaf]
            let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);

            // Elliot having received the coin, gives it to Fred.
            let elliot_to_fred = txlib.createUTXO(UTXO.slot, 5000, elliot, fred);
            txs = [elliot_to_fred.leaf]
            let tree_fred = await txlib.submitTransactions(authority, plasma, txs);

            // Fred normally should be always checking the coin's history and
            // not accepting the payment if it's invalid like in this case, but
            // it is considered that they are all colluding together to steal
            // Bob's coin. Fred has all the info required to submit
            // an exit, even if one of the transactions in the coin's history
            // were invalid.
            let sig = elliot_to_fred.sig;
            let prev_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)
            let exiting_tx_proof = tree_fred.createMerkleProof(UTXO.slot)
            let prev_tx = dylan_to_elliot.tx;
            let exiting_tx = elliot_to_fred.tx;

            // Fred submits the invalid exit and waits
            await plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [4000, 5000],
                {'from': fred, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            // Charlie has seen the collusion scheme and challenges
            sig = bob_to_charlie.sig;
            prev_tx_proof = tree_bob.createMerkleProof(UTXO.slot)
            let tx_proof = tree_charlie.createMerkleProof(UTXO.slot)
            prev_tx = alice_to_bob.tx;
            let challenging_tx = bob_to_charlie.tx;
            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , challenging_tx,
                prev_tx_proof, tx_proof,
                sig,
                [1000, 2000],
                {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
            );
            await increaseTimeTo(t0 + MATURITY_PERIOD + e);
            await plasma.finalizeExits({from: random_guy2});

            // Fred shouldn't be able to withdraw the coin.
            assertRevert(plasma.withdraw(UTXO.slot, {from : fred}));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(elliot), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            // Bob is able to get both her bond and Elliot's invalid exit bond
            await txlib.withdrawBonds(plasma, charlie, 0.2);
        });
    });

    describe('With Responses', function() {
        it("Attempt to make an invalid response fails", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

            // alice gives coin to bob
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            // bob gives it back to alice
            let bob_to_alice = txlib.createUTXO(UTXO.slot, 1000, bob, alice);
            txs = [bob_to_alice.leaf]
            let tree_alice = await txlib.submitTransactions(authority, plasma, txs);

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
            await plasma.startExit(
                UTXO.slot,
                prev_tx, exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [4000, 5000],
                {'from': elliot, 'value': web3.toWei(0.1, 'ether')}
            );
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            prev_tx = alice_to_bob.tx
            prev_tx_proof = tree_bob.createMerkleProof(UTXO.slot)
            exiting_tx_proof = tree_alice.createMerkleProof(UTXO.slot)
            exiting_tx = bob_to_alice.tx;
            sig = bob_to_alice.sig;
            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , exiting_tx,
                prev_tx_proof, exiting_tx_proof,
                sig,
                [1000, 2000],
                {'from': alice, 'value': web3.toWei(0.1, 'ether')}
            );
            
            // Fast forward to the second window where responses are allowed
            // await increaseTimeTo(t0 + RESPONSE_PERIOD + e);

            // Elliot tries to make an invalid response by providing
            // the initial transfer from Alice to Bob. A valid response
            // would involve a later spend
            let responseTx = alice_to_bob.tx;
            sig = alice_to_bob.sig;
            let responseProof = tree_bob.createMerkleProof(UTXO.slot);

            // Get the tx hash of the challenge we are responding to
            let challengingTxHash = alice_to_bob.leaf.hash;

            assertRevert(plasma.respondChallengeBefore(
                UTXO.slot, 1000, challengingTxHash, responseTx, responseProof, sig,
                {'from': elliot}
            ));

            await increaseTimeTo(t0 + MATURITY_PERIOD + e);
            await plasma.finalizeExits({from: random_guy2});

            // Elliot shouldn't be able to withdraw the coin.
            assertRevert(plasma.withdraw(UTXO.slot, {from : elliot}));

            assert.equal(await cards.balanceOf.call(alice), 2);
            assert.equal(await cards.balanceOf.call(bob), 0);
            assert.equal(await cards.balanceOf.call(charlie), 0);
            assert.equal(await cards.balanceOf.call(dylan), 0);
            assert.equal(await cards.balanceOf.call(elliot), 0);
            assert.equal(await cards.balanceOf.call(plasma.address), 3);

            // Bob is able to get both her bond and Elliot's invalid exit bond
            await txlib.withdrawBonds(plasma, alice, 0.2);
        });

        it("Elliot makes a valid exit which gets challenged, however he responds with `respondChallengeBefore`", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf]
            let tree_bob = await txlib.submitTransactions(authority, plasma, txs);

            let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
            txs = [bob_to_charlie.leaf]
            let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

            let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
            txs = [charlie_to_dylan.leaf]
            let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

            let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
            txs = [dylan_to_elliot.leaf]
            let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);

            // Elliot exits his coin
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
            t0 = (await web3.eth.getBlock('latest')).timestamp;

            // Invalid `challengeBefore`
            sig = alice_to_bob.sig;
            let proof = tree_bob.createMerkleProof(UTXO.slot)
            prev_tx = txlib.createUTXO(UTXO.slot, 0, alice, alice).tx;
            let tx = alice_to_bob.tx;
            await plasma.challengeBefore(
                UTXO.slot,
                prev_tx , tx,
                '0x0', proof,
                sig,
                [3, 1000],
                {'from': challenger, 'value': web3.toWei(0.1, 'ether')}
            );

            // await increaseTimeTo(t0 + RESPONSE_PERIOD + e);

            let challengingTxHash = alice_to_bob.leaf.hash;
            let responseTx = bob_to_charlie.tx;
            sig = bob_to_charlie.sig;
            let responseProof = tree_charlie.createMerkleProof(UTXO.slot);
            await plasma.respondChallengeBefore(
                UTXO.slot, challengingTxHash, 2000, responseTx, responseProof, sig,
                {'from': elliot}
            );

            await increaseTimeTo(t0 + MATURITY_PERIOD + e);
            await plasma.finalizeExits({from: random_guy2});
            await plasma.withdraw(UTXO.slot, {from : elliot});

            assert.equal((await cards.balanceOf.call(alice)).toNumber(), 2);
            assert.equal((await cards.balanceOf.call(bob)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(charlie)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(dylan)).toNumber(), 0);
            assert.equal((await cards.balanceOf.call(elliot)).toNumber(), 1);
            assert.equal((await cards.balanceOf.call(plasma.address)).toNumber(), 2);

            // Elliot gets back his exit bond and the challenger's bond
            await txlib.withdrawBonds(plasma, elliot, 0.2);
        });

        describe("Multiple Challenges", async function() {
            // This scenario can occur as follows when the operator is byzaantine
            // 1) Operator makes an Invalid exit
            // 2) Operator challenges the invalid exit
            // 3) Operator responds with a response that looks valid (but in fact was forged)
            // If multiple challenges were not allowed, the operator would
            // challenge their exit right before the response period starts, which would
            // disallow any valid responses, thus allowing them to finalize an invalid exit
            // By allowing multiple challenges, we require that during finalizations there are
            // no pending challenges which mitigates the above vector.
            // Splitting the maturity period in 2 was introduced to avoid griefing attacks as
            // discussed in issue #103
            it("Invalid exit - Multichallenged in time", async function() {
                let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

                // Bob/Operator forges a transaction and gives the coin all the way to Elliot
                // Elliot exits, Bob challenges,
                // The authority submits a block, but there is no transaction from Alice to Bob
                let tree_bob = await txlib.submitTransactions(authority, plasma);

                // Nevertheless, Bob pretends he received the coin, and by
                // colluding with the chain operator he is able to include his
                // invalid transaction in a block.
                let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
                let txs = [bob_to_charlie.leaf]
                let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

                // Charlie having received the coin, gives it to Dylan.
                let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
                txs = [charlie_to_dylan.leaf]
                let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

                // Dylan having received the coin, gives it to Elliot.
                let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
                txs = [dylan_to_elliot.leaf]
                let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);
                //
                // Dylan having received the coin, gives it to Elliot.
                let elliot_to_fred = txlib.createUTXO(UTXO.slot, 4000, elliot, fred);
                txs = [elliot_to_fred.leaf]
                let tree_fred = await txlib.submitTransactions(authority, plasma, txs);

                // Elliot normally should be always checking the coin's history and
                // not accepting the payment if it's invalid like in this case, but
                // it is considered that they are all colluding together to steal
                // Bob's coin.  Elliot has all the info required to submit
                // an exit, even if one of the transactions in the coin's history
                // were invalid.
                let sig = elliot_to_fred.sig;
                let prev_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)
                let exiting_tx_proof = tree_fred.createMerkleProof(UTXO.slot)
                let prev_tx = dylan_to_elliot.tx;
                let exiting_tx = elliot_to_fred.tx;

                // Fred submits the exit which is valid as far as the chain is concerned
                await plasma.startExit(
                    UTXO.slot,
                    prev_tx, exiting_tx,
                    prev_tx_proof, exiting_tx_proof,
                    sig,
                    [4000, 5000],
                    {'from': fred, 'value': web3.toWei(0.1, 'ether')}
                );
                t0 = (await web3.eth.getBlock('latest')).timestamp;

                // Dylan challenges the exit
                sig = charlie_to_dylan.sig;
                let tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
                prev_tx_proof = tree_charlie.createMerkleProof(UTXO.slot)
                prev_tx = bob_to_charlie.tx;
                let tx = charlie_to_dylan.tx;
                await plasma.challengeBefore(
                    UTXO.slot,
                    prev_tx , tx,
                    prev_tx_proof, tx_proof,
                    sig,
                    [2000, 3000],
                    {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
                );

                // Alice ALSO challenges the exit! Note that Dylan's challenge is an artificial one
                // that can be responded to by a response which holds on to invalid transactions
                let alice_to_alice = txlib.createUTXO(UTXO.slot, 0, alice, alice);
                await plasma.challengeBefore(
                    UTXO.slot,
                    '0x0' , alice_to_alice.tx,
                    '0x0', '0x0',
                    alice_to_alice.sig,
                    [0, UTXO.block],
                    {'from': alice, 'value': web3.toWei(0.1, 'ether')}
                );

                // No more challenges can be issued
                await increaseTimeTo(t0 + RESPONSE_PERIOD);

                // Elliot responds to the challenge (what are they even trying to do?!)
                let challengingTxHash = charlie_to_dylan.leaf.hash;
                let responseTx = dylan_to_elliot.tx;
                sig = dylan_to_elliot.sig;
                let responseProof = tree_elliot.createMerkleProof(UTXO.slot);
                await plasma.respondChallengeBefore(
                    UTXO.slot, challengingTxHash, 4000, responseTx, responseProof, sig,
                    {'from': elliot}
                );

                await increaseTimeTo(t0 + MATURITY_PERIOD + e);
                await plasma.finalizeExits({from: random_guy2});

                // Fred shouldn't be able to withdraw the coin.
                assertRevert(plasma.withdraw(UTXO.slot, {from : fred}));

                assert.equal(await cards.balanceOf.call(alice), 2);
                assert.equal(await cards.balanceOf.call(bob), 0);
                assert.equal(await cards.balanceOf.call(charlie), 0);
                assert.equal(await cards.balanceOf.call(dylan), 0);
                assert.equal(await cards.balanceOf.call(elliot), 0);
                assert.equal(await cards.balanceOf.call(plasma.address), 3);


                // Bond withdrawals
                await plasma.withdrawBonds({from: elliot});
                await plasma.withdrawBonds({from: alice});
                let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
                let eventLog = await txlib.Promisify(cb => withdrewBonds.get(cb));

                // Elliot is able to get the challenger's bond
                // (nothing gained since they are all colluding)
                let elliot_bond = eventLog[0].args;
                assert.equal(elliot_bond.from, elliot);
                assert.equal(elliot_bond.amount, web3.toWei(0.1, 'ether'));

                // Alice gets her own bond back and the exitor's bond
                let alice_bond = eventLog[1].args;
                assert.equal(alice_bond.from, alice);
                assert.equal(alice_bond.amount, web3.toWei(0.2, 'ether'));
            });

            it("Invalid exit - Not challenged in time", async function() {
                let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

                // Bob/Operator forges a transaction and gives the coin all the way to Elliot
                // Elliot exits, Bob challenges,
                // The authority submits a block, but there is no transaction from Alice to Bob
                let tree_bob = await txlib.submitTransactions(authority, plasma);

                // Nevertheless, Bob pretends he received the coin, and by
                // colluding with the chain operator he is able to include his
                // invalid transaction in a block.
                let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
                let txs = [bob_to_charlie.leaf]
                let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

                // Charlie having received the coin, gives it to Dylan.
                let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
                txs = [charlie_to_dylan.leaf]
                let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

                // Dylan having received the coin, gives it to Elliot.
                let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
                txs = [dylan_to_elliot.leaf]
                let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);
                //
                // Dylan having received the coin, gives it to Elliot.
                let elliot_to_fred = txlib.createUTXO(UTXO.slot, 4000, elliot, fred);
                txs = [elliot_to_fred.leaf]
                let tree_fred = await txlib.submitTransactions(authority, plasma, txs);

                // Elliot normally should be always checking the coin's history and
                // not accepting the payment if it's invalid like in this case, but
                // it is considered that they are all colluding together to steal
                // Bob's coin.  Elliot has all the info required to submit
                // an exit, even if one of the transactions in the coin's history
                // were invalid.
                let sig = elliot_to_fred.sig;
                let prev_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)
                let exiting_tx_proof = tree_fred.createMerkleProof(UTXO.slot)
                let prev_tx = dylan_to_elliot.tx;
                let exiting_tx = elliot_to_fred.tx;

                // Fred submits the exit which is valid as far as the chain is concerned
                await plasma.startExit(
                    UTXO.slot,
                    prev_tx, exiting_tx,
                    prev_tx_proof, exiting_tx_proof,
                    sig,
                    [4000, 5000],
                    {'from': fred, 'value': web3.toWei(0.1, 'ether')}
                );
                t0 = (await web3.eth.getBlock('latest')).timestamp;

                // Dylan challenges the exit
                sig = charlie_to_dylan.sig;
                let tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
                prev_tx_proof = tree_charlie.createMerkleProof(UTXO.slot)
                prev_tx = bob_to_charlie.tx;
                let tx = charlie_to_dylan.tx;
                await plasma.challengeBefore(
                    UTXO.slot,
                    prev_tx , tx,
                    prev_tx_proof, tx_proof,
                    sig,
                    [2000, 3000],
                    {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
                );

                // No more challenges can be issued
                await increaseTimeTo(t0 + RESPONSE_PERIOD + e);
                // Alice can no longer challenge the exit! :(
                let alice_to_alice = txlib.createUTXO(UTXO.slot, 0, alice, alice);
                assertRevert(plasma.challengeBefore(
                    UTXO.slot,
                    '0x0' , alice_to_alice.tx,
                    '0x0', '0x0',
                    alice_to_alice.sig,
                    [0, UTXO.block],
                    {'from': alice, 'value': web3.toWei(0.1, 'ether')}
                ));

                // Elliot responds to the challenge (this time it will complete the robbery)
                let challengingTxHash = charlie_to_dylan.leaf.hash;
                let responseTx = dylan_to_elliot.tx;
                sig = dylan_to_elliot.sig;
                let responseProof = tree_elliot.createMerkleProof(UTXO.slot);
                await plasma.respondChallengeBefore(
                    UTXO.slot, challengingTxHash, 4000, responseTx, responseProof, sig,
                    {'from': elliot}
                );

                await increaseTimeTo(t0 + MATURITY_PERIOD + e);
                await plasma.finalizeExits({from: random_guy2});

                // Fred withdraws the coin.
                await plasma.withdraw(UTXO.slot, {from : fred});

                assert.equal(await cards.balanceOf.call(alice), 2);
                assert.equal(await cards.balanceOf.call(bob), 0);
                assert.equal(await cards.balanceOf.call(charlie), 0);
                assert.equal(await cards.balanceOf.call(dylan), 0);
                assert.equal(await cards.balanceOf.call(elliot), 0);
                assert.equal(await cards.balanceOf.call(fred), 1);
                assert.equal(await cards.balanceOf.call(plasma.address), 2);


                // Bond withdrawals
                await plasma.withdrawBonds({from: elliot});
                await plasma.withdrawBonds({from: fred});

                let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
                let eventLog = await txlib.Promisify(cb => withdrewBonds.get(cb));

                // Elliot is able to get the challenger's bond
                // (nothing gained since they are all colluding)
                let elliot_bond = eventLog[0].args;
                assert.equal(elliot_bond.from, elliot);
                assert.equal(elliot_bond.amount, web3.toWei(0.1, 'ether'));

                // Alice gets her own bond back and the exitor's bond
                let fred_bond = eventLog[1].args;
                assert.equal(fred_bond.from, fred);
                assert.equal(fred_bond.amount, web3.toWei(0.1, 'ether'));
            });

            it("2 challenges resolved at finalization", async function() {
                let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};

                // Bob/Operator forges a transaction and gives the coin all the way to Elliot
                // Elliot exits, Bob challenges,
                // The authority submits a block, but there is no transaction from Alice to Bob
                let tree_bob = await txlib.submitTransactions(authority, plasma);

                // Nevertheless, Bob pretends he received the coin, and by
                // colluding with the chain operator he is able to include his
                // invalid transaction in a block.
                let bob_to_charlie = txlib.createUTXO(UTXO.slot, 1000, bob, charlie);
                let txs = [bob_to_charlie.leaf]
                let tree_charlie = await txlib.submitTransactions(authority, plasma, txs);

                // Charlie having received the coin, gives it to Dylan.
                let charlie_to_dylan = txlib.createUTXO(UTXO.slot, 2000, charlie, dylan);
                txs = [charlie_to_dylan.leaf]
                let tree_dylan = await txlib.submitTransactions(authority, plasma, txs);

                // Dylan having received the coin, gives it to Elliot.
                let dylan_to_elliot = txlib.createUTXO(UTXO.slot, 3000, dylan, elliot);
                txs = [dylan_to_elliot.leaf]
                let tree_elliot = await txlib.submitTransactions(authority, plasma, txs);
                //
                // Dylan having received the coin, gives it to Elliot.
                let elliot_to_fred = txlib.createUTXO(UTXO.slot, 4000, elliot, fred);
                txs = [elliot_to_fred.leaf]
                let tree_fred = await txlib.submitTransactions(authority, plasma, txs);

                // Elliot normally should be always checking the coin's history and
                // not accepting the payment if it's invalid like in this case, but
                // it is considered that they are all colluding together to steal
                // Bob's coin.  Elliot has all the info required to submit
                // an exit, even if one of the transactions in the coin's history
                // were invalid.
                let sig = elliot_to_fred.sig;
                let prev_tx_proof = tree_elliot.createMerkleProof(UTXO.slot)
                let exiting_tx_proof = tree_fred.createMerkleProof(UTXO.slot)
                let prev_tx = dylan_to_elliot.tx;
                let exiting_tx = elliot_to_fred.tx;

                // Fred submits the exit which is valid as far as the chain is concerned
                await plasma.startExit(
                    UTXO.slot,
                    prev_tx, exiting_tx,
                    prev_tx_proof, exiting_tx_proof,
                    sig,
                    [4000, 5000],
                    {'from': fred, 'value': web3.toWei(0.1, 'ether')}
                );
                t0 = (await web3.eth.getBlock('latest')).timestamp;

                // Dylan challenges the exit
                sig = charlie_to_dylan.sig;
                let tx_proof = tree_dylan.createMerkleProof(UTXO.slot)
                prev_tx_proof = tree_charlie.createMerkleProof(UTXO.slot)
                prev_tx = bob_to_charlie.tx;
                let tx = charlie_to_dylan.tx;
                await plasma.challengeBefore(
                    UTXO.slot,
                    prev_tx , tx,
                    prev_tx_proof, tx_proof,
                    sig,
                    [2000, 3000],
                    {'from': dylan, 'value': web3.toWei(0.1, 'ether')}
                );

                // No more challenges can be issued
                // await increaseTimeTo(t0 + RESPONSE_PERIOD + e);
                // Alice can no longer challenge the exit! :(
                let alice_to_alice = txlib.createUTXO(UTXO.slot, 0, alice, alice);
                await plasma.challengeBefore(
                    UTXO.slot,
                    '0x0' , alice_to_alice.tx,
                    '0x0', '0x0',
                    alice_to_alice.sig,
                    [0, UTXO.block],
                    {'from': alice, 'value': web3.toWei(0.1, 'ether')}
                );

                await increaseTimeTo(t0 + MATURITY_PERIOD + e);
                await plasma.finalizeExits({from: random_guy2});

                // Fred withdraws the coin.
                assertRevert(plasma.withdraw(UTXO.slot, {from : fred}));

                assert.equal(await cards.balanceOf.call(alice), 2);
                assert.equal(await cards.balanceOf.call(bob), 0);
                assert.equal(await cards.balanceOf.call(charlie), 0);
                assert.equal(await cards.balanceOf.call(dylan), 0);
                assert.equal(await cards.balanceOf.call(elliot), 0);
                assert.equal(await cards.balanceOf.call(fred), 0);
                assert.equal(await cards.balanceOf.call(plasma.address), 3);

                // Bond withdrawals
                await plasma.withdrawBonds({from: dylan});
                await plasma.withdrawBonds({from: alice});

                let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
                let eventLog = await txlib.Promisify(cb => withdrewBonds.get(cb));

                // Dylan's challenge was first (even if it was invalid! and this is what ultimately caused the exit to be cancelled, so he gets both his bond back and the challenger's bond back.
                let dylan_bond = eventLog[0].args;
                assert.equal(dylan_bond.from, dylan);
                assert.equal(dylan_bond.amount, web3.toWei(0.2, 'ether'));

                // Alice gets her own bond back
                let alice_bond = eventLog[1].args;
                assert.equal(alice_bond.from, alice);
                assert.equal(alice_bond.amount, web3.toWei(0.1, 'ether'));
            });
        });

    });
});
