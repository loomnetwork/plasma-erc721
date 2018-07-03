const ValidatorManagerContract = artifacts.require("ValidatorManagerContract");
const LoomToken = artifacts.require("LoomToken");
const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");
import {increaseTimeTo, duration} from './helpers/increaseTime'
import assertRevert from './helpers/assertRevert.js';

const txlib = require('./UTXO.js')

contract("Plasma Cash - All In One", async function(accounts) {

    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later

    // Alice registers and has 5 coins, and she deposits 3 of them.
    const ALICE_INITIAL_COINS = 5;
    const ALICE_DEPOSITED_COINS = 3;
    const coins = [1, 2, 3];

    let erc20;
    let erc721;
    let plasma;
    let vmc;
    let events;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger] = accounts;

    const DECIMALS = 10 ** 18;
    const denominations = [
        3000 * DECIMALS, 
        2000 * DECIMALS, 
        4000 * DECIMALS
    ];

    const ethers = [
        web3.toWei(1, 'ether'),
        web3.toWei(4, 'ether'),
        web3.toWei(5, 'ether')
    ];

    beforeEach(async function() {
        vmc = await ValidatorManagerContract.new({from: authority});
        plasma = await RootChain.new(vmc.address, {from: authority});
        erc20 = await LoomToken.new(plasma.address, {from: authority});
        erc721 = await CryptoCards.new(plasma.address, {from: authority});

        await vmc.toggleToken(erc20.address, {from: authority});
        await vmc.toggleToken(erc721.address, {from: authority});

        await erc20.transfer(alice, 10000 * DECIMALS, {from: authority});
        await erc721.register({from: alice});

        for (let i = 0; i < denominations.length; i ++) {
            await web3.eth.sendTransaction({from: alice, to: plasma.address, value: ethers[i], gas: 200000 });
            await erc20.depositToPlasma(denominations[i], {from: alice});
            await erc721.depositToPlasma(coins[i], {from: alice});
        }
        assert.equal(await erc20.balanceOf.call(alice), 1000 * DECIMALS);
        assert.equal(await erc20.balanceOf.call(plasma.address), 9000 * DECIMALS);

        assert.equal(await erc721.balanceOf.call(plasma.address), 3);
        assert.equal(await erc721.balanceOf.call(alice), 2);

        assert.equal(await web3.eth.getBalance(plasma.address), web3.toWei(10, 'ether'));

        const depositEvent = plasma.Deposit({}, {fromBlock: 0, toBlock: 'latest'});
        events = await txlib.Promisify(cb => depositEvent.get(cb));
    });

    describe('Exit of an ERC20, an ERC721 and an ETH coin', function() {
		it('Directly after their deposit', async function() {
			let UTXO = [
                {'slot': events[0]['args'].slot, 'block': events[0]['args'].blockNumber.toNumber()},
                {'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()},
            ]

            let prevBlock = 0;
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let ret = txlib.createUTXO(aUTXO.slot, prevBlock, alice, alice);
                let utxo = ret.tx;
                let sig = ret.sig;

                await plasma.startExit(
                    aUTXO.slot,
                    '0x', utxo,
                    '0x0', '0x0',
                    sig,
                    [prevBlock, aUTXO.block],
                    {'from': alice, 'value': web3.toWei(0.1, 'ether')}
                );
            }
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1);
            await plasma.finalizeExits({from: random_guy2 });

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                await plasma.withdraw(aUTXO.slot, {from : alice });
            }

            // Alice has her coins back.
            await txlib.withdrawBonds(plasma, alice, 0.3);
        });

		it('After 1 on chain transaction', async function() {
			let UTXO = [
                {'slot': events[0]['args'].slot, 'block': events[0]['args'].blockNumber.toNumber()},
                {'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()},
            ]

            let prevBlock = 0;
            let leaves = [];
            let txs = [];
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let tx = txlib.createUTXO(aUTXO.slot, prevBlock, alice, bob);
                leaves.push(tx.leaf)
                txs.push(tx)
            }
            let tree_1000 = await txlib.submitTransactions(authority, plasma, leaves);

            let exitingBlock = 1000;
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let prev_tx = txlib.createUTXO(aUTXO.slot, 0, alice, alice).tx;
                let exiting_tx = txs[i];
                let utxo = exiting_tx.tx;
                let sig = exiting_tx.sig;
                let proof = tree_1000.createMerkleProof(aUTXO.slot);

                await plasma.startExit(
                    aUTXO.slot,
                    prev_tx, utxo,
                    '0x0', proof,
                    sig,
                    [aUTXO.block, exitingBlock],
                    {'from': bob, 'value': web3.toWei(0.1, 'ether')}
                );
            }
            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1);
            await plasma.finalizeExits({from: random_guy2 });


            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                await plasma.withdraw(aUTXO.slot, {from : bob });
            }

            // Alice has her coins back.
            await txlib.withdrawBonds(plasma, bob, 0.3);
        });

		it('After 2 on chain transaction', async function() {
			let UTXO = [
                {'slot': events[0]['args'].slot, 'block': events[0]['args'].blockNumber.toNumber()},
                {'slot': events[1]['args'].slot, 'block': events[1]['args'].blockNumber.toNumber()},
                {'slot': events[2]['args'].slot, 'block': events[2]['args'].blockNumber.toNumber()},
            ]

            let prevBlock = 0;
            let leaves = [];
            let prev_txs = [];
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let tx = txlib.createUTXO(aUTXO.slot, prevBlock, alice, bob);
                leaves.push(tx.leaf)
                prev_txs.push(tx)
            }
            let tree_1000 = await txlib.submitTransactions(authority, plasma, leaves);

            prevBlock = 1000;
            leaves = [];
            let txs = [];
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let tx = txlib.createUTXO(aUTXO.slot, prevBlock, bob, charlie);
                leaves.push(tx.leaf)
                txs.push(tx)
            }
            let tree_2000 = await txlib.submitTransactions(authority, plasma, leaves);


            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                let prev_tx = prev_txs[i];
                let exiting_tx = txs[i];
                let prev_tx_proof = tree_1000.createMerkleProof(aUTXO.slot);
                let exiting_tx_proof = tree_2000.createMerkleProof(aUTXO.slot);

                await plasma.startExit(
                    aUTXO.slot,
                    prev_tx.tx, exiting_tx.tx,
                    prev_tx_proof, exiting_tx_proof,
                    exiting_tx.sig,
                    [1000, 2000],
                    {'from': charlie, 'value': web3.toWei(0.1, 'ether')}
                );
            }

            t0 = (await web3.eth.getBlock('latest')).timestamp;
            await increaseTimeTo(t0 + t1);
            await plasma.finalizeExits({from: random_guy2 });

            await increaseTimeTo(t0 + t1 + t2);
            await plasma.finalizeExits({from: random_guy2 });
            for (let i in UTXO) {
                let aUTXO = UTXO[i];
                await plasma.withdraw(aUTXO.slot, {from : charlie });
            }

            // Alice has her coins back.
            await txlib.withdrawBonds(plasma, charlie, 0.3);
        });

    });

});
