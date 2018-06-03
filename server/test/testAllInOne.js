const CryptoCards = artifacts.require("CryptoCards");
const RootChain = artifacts.require("RootChain");

const SparseMerkleTree = require('./SparseMerkleTree.js');

import {increaseTimeTo} from './helpers/increaseTime';
import assertRevert from './helpers/assertRevert.js';

const _ = require('lodash');
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

contract("Plasma ERC721 - Everything together", async function(accounts) {

    const t1 = 3600 * 24 * 3; // 3 days later
    const t2 = 3600 * 24 * 5; // 5 days later
    const COINS_PER_ACTOR = 5;


    let cards;
    let plasma;
    let t0;

    let [authority, alice, bob, charlie, dylan, elliot, random_guy, random_guy2, challenger, challenger2] = accounts;

    const ACTORS = [alice, bob, charlie, dylan, elliot];
    const FINALIZERS = [ random_guy, random_guy2 ]
    const WATCHERS = [ challenger, challenger2 ];

    before('Register all actors', async function() {
        plasma = await RootChain.new({from: authority});
        cards = await CryptoCards.new(plasma.address);
        plasma.setCryptoCards(cards.address);
        for (let i = 0 ; i < ACTORS.length; i++) {
            await cards.register( { 'from' :  ACTORS[i] } );
        }
    });


    it('Alice Bob and Charlie deposit two coins each', async function() {
        // Prevblock = 0 because we're exiting a tx 
        // directly after being minted in the plasma chain
        let prevBlock = 0;

        let localActors = ACTORS.slice(0,3);
        let actor, ret, slot, coin;
        for (let i = 0; i < 2 * localActors.length; i+=2) {
            actor = localActors[i/2];
            for (let j = 0; j < 2 ; j ++) {
                coin = COINS_PER_ACTOR * i/2 + j + 1;
                slot = await plasma.NUM_COINS.call()
                // console.log(coin);
                ret = txlib.createUTXO(slot, 0, actor, actor);
                // cards.depositToPlasmaWithData(coin, ret.tx, {'from' : actor });
            }
        }
    });



});


