const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");
import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

contract("Plasma ERC721 - Multiple Deposits in various blocks", async function(accounts) {

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
        cards.register({from: bob});
        assert.equal(await cards.balanceOf.call(alice), 5);
        assert.equal(await cards.balanceOf.call(bob), 5);

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
            // assert.equal(coin.slot.toNumber(), i);
            assert.equal(coin.blockNumber.toNumber(), i+1);
            assert.equal(coin.denomination.toNumber(), 1);
            assert.equal(coin.from, alice);
        }

    });

    describe('Exit of UTXO 2 and 7 (UTXO 7 added at 1000-2000 block interval)', function() {
        it("Alice sends Bob UTXO 2, submits it, Bob deposits his coin and sends Alice UTXO 4, submits it, both exit", async function() {
            let UTXO = {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()};
            let alice_to_bob = txlib.createUTXO(UTXO.slot, UTXO.block, alice, bob);
            let txs = [alice_to_bob.leaf];
            let tree_1000 = await txlib.submitTransactions(authority, plasma, txs);

            // Bob deposits Coin 7, which generates a new UTXO in the Plasma chain.
            await cards.depositToPlasma(7, {from: bob});
            const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
            events = await txlib.Promisify(cb => depositEvent.get(cb));
            let bobCoin = events[events.length - 1].args;
            let slot = bobCoin.slot;
            let block = await plasma.getPlasmaCoin.call(slot);
            block = block[1].toNumber();

            let bob_to_alice = txlib.createUTXO(slot, block, bob, alice);
            txs = [bob_to_alice.leaf];
            let tree_2000 = await txlib.submitTransactions(authority, plasma, txs);

            // Bob exits his coin as usual, referencing block `UTXO.block` and 1000
            let sig = alice_to_bob.sig;
            let utxo = alice_to_bob.tx;
            let proof = tree_1000.createMerkleProof(UTXO.slot);

            let prev_tx = txlib.createUTXO(UTXO.slot, 0, alice, alice).tx;

            await plasma.startExit(
                UTXO.slot,
                prev_tx, utxo,
                '0x0', proof,
                sig,
                [3, 1000],
                {'from': bob, 'value': web3.toWei(0.1, 'ether')}
            );

            // Alice exits the coin she received from Bob referencing the deposited coin at Block 1001
            sig = bob_to_alice.sig;
            utxo = bob_to_alice.tx;
            proof = tree_2000.createMerkleProof(slot);

            prev_tx = txlib.createUTXO(slot, 0, bob, bob).tx;

            await plasma.startExit(
                slot,
                prev_tx, utxo,
                '0x0', proof,
                sig,
                [block, 2000],
                {'from': alice, 'value': web3.toWei(0.1, 'ether')}
            );

            t0 = (await web3.eth.getBlock('latest')).timestamp;

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2});
            await plasma.withdraw(UTXO.slot, {from: bob});
            await plasma.withdraw(slot, {from: alice});

            assert.equal(await cards.ownerOf(3), bob);
            assert.equal(await cards.ownerOf(7), alice);

            await plasma.withdrawBonds({'from': bob});
            await plasma.withdrawBonds({'from': alice});
            let withdrewBonds = plasma.WithdrewBonds({}, {fromBlock: 0, toBlock: 'latest'});
            let e = await txlib.Promisify(cb => withdrewBonds.get(cb));
            let withdraw = e[0].args;
            assert.equal(withdraw.from, bob);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));
            withdraw = e[1].args;
            assert.equal(withdraw.from, alice);
            assert.equal(withdraw.amount, web3.toWei(0.1, 'ether'));

        });
    });

});
