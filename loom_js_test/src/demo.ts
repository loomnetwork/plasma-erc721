import test from 'tape'
import BN from 'bn.js'
import Web3 from 'web3'
import { IPlasmaDeposit, marshalDepositEvent } from 'loom-js'

import { increaseTime } from './ganache-helpers'
import { createTestEntity, ADDRESSES, ACCOUNTS } from './config'
import { EthCardsContract } from './cards-contract'

// Alice registers and has 5 coins, and she deposits 3 of them.
const ALICE_INITIAL_COINS = 5
const ALICE_DEPOSITED_COINS = 3
const COINS = [1, 2, 3]

// All the contracts are expected to have been deployed to Ganache when this function is called.
function setupContracts(web3: Web3): { cards: EthCardsContract } {
  const abi = require('./contracts/cards-abi.json')
  const cards = new EthCardsContract(new web3.eth.Contract(abi, ADDRESSES.token_contract))
  return { cards }
}

test('Plasma Cash with ERC721 Demo', async t => {
  const web3 = new Web3('http://localhost:8545')
  const { cards } = setupContracts(web3)
  const authority = createTestEntity(web3, ACCOUNTS.authority)
  const alice = createTestEntity(web3, ACCOUNTS.alice)
  const bob = createTestEntity(web3, ACCOUNTS.bob)
  const charlie = createTestEntity(web3, ACCOUNTS.charlie)

  await cards.registerAsync(alice.ethAddress)
  let balance = await cards.balanceOfAsync(alice.ethAddress)
  t.equal(balance.toNumber(), 5)

  const startBlockNum = await web3.eth.getBlockNumber()

  for (let i = 0; i < ALICE_DEPOSITED_COINS; i++) {
    await cards.depositToPlasmaAsync({ tokenId: COINS[i], from: alice.ethAddress })
  }

  const depositEvents: any[] = await authority.plasmaCashContract.getPastEvents('Deposit', {
    fromBlock: startBlockNum
  })
  const deposits = depositEvents.map<IPlasmaDeposit>(event =>
    marshalDepositEvent(event.returnValues)
  )
  t.equal(deposits.length, ALICE_DEPOSITED_COINS, 'All deposit events accounted for')
  for (let i = 0; i < deposits.length; i++) {
    const deposit = deposits[i]
    t.equal(deposit.blockNumber.toNumber(), i + 1, `Deposit ${i + 1} block number is correct`)
    t.equal(deposit.denomination.toNumber(), 1, `Deposit ${i + 1} denomination is correct`)
    t.equal(deposit.from, alice.ethAddress, `Deposit ${i + 1} sender is correct`)
  }

  balance = await cards.balanceOfAsync(alice.ethAddress)
  t.equal(
    balance.toNumber(),
    ALICE_INITIAL_COINS - ALICE_DEPOSITED_COINS,
    'alice should have 2 tokens in cards contract'
  )
  balance = await cards.balanceOfAsync(ADDRESSES.root_chain)
  t.equal(
    balance.toNumber(),
    ALICE_DEPOSITED_COINS,
    'plasma contract should have 3 tokens in cards contract'
  )

  // Alice to Bob, and Alice to Charlie. We care about the Alice to Bob
  // transaction
  const deposit3 = deposits[2]
  const deposit2 = deposits[1]
  // Alice -> Bob
  await alice.transferTokenAsync({
    slot: deposit3.slot,
    prevBlockNum: deposit3.blockNumber,
    denomination: 1,
    newOwner: bob
  })
  // Alice -> Charlie
  await alice.transferTokenAsync({
    slot: deposit2.slot,
    prevBlockNum: deposit2.blockNumber,
    denomination: 1,
    newOwner: charlie
  })
  const plasmaBlockNum1 = await authority.submitPlasmaBlockAsync()
  // Add an empty block in between (for proof of exclusion)
  await authority.submitPlasmaBlockAsync()
  // Bob -> Charlie
  await bob.transferTokenAsync({
    slot: deposit3.slot,
    prevBlockNum: new BN(1000),
    denomination: 1,
    newOwner: charlie
  })

  // TODO: get coin history of deposit3.slot from bob
  // TODO: charlie should verify coin history of deposit3.slot

  const plasmaBlockNum2 = await authority.submitPlasmaBlockAsync()

  // TODO: charlie should watch exits of deposit3.slot

  await charlie.startExitAsync({
    slot: deposit3.slot,
    prevBlockNum: plasmaBlockNum1,
    exitBlockNum: plasmaBlockNum2
  })

  // TODO: charlie should stop watching exits of deposit3.slot

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)
  // Charlie's exit should be finalizable...
  await authority.finalizeExitsAsync()
  // Charlie should now be able to withdraw the UTXO (plasma token) which contains ERC721 token #2
  // into his wallet.
  await charlie.withdrawAsync(deposit3.slot)

  balance = await cards.balanceOfAsync(alice.ethAddress)
  t.equal(balance.toNumber(), 2, 'alice should have 2 tokens in cards contract')
  balance = await cards.balanceOfAsync(bob.ethAddress)
  t.equal(balance.toNumber(), 0, 'bob should have no tokens in cards contract')
  balance = await cards.balanceOfAsync(charlie.ethAddress)
  t.equal(balance.toNumber(), 1, 'charlie should have 1 token in cards contract')

  t.end()
})
