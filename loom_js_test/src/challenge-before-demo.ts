import test from 'tape'
import BN from 'bn.js'
import Web3 from 'web3'
import { IPlasmaDeposit, marshalDepositEvent } from 'loom-js'

import { increaseTime, getEthBalanceAtAddress } from './ganache-helpers'
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

test('Plasma Cash Challenge Before Demo', async t => {
  const web3 = new Web3('http://localhost:8545')
  const { cards } = setupContracts(web3)
  const authority = createTestEntity(web3, ACCOUNTS.authority)
  const dan = createTestEntity(web3, ACCOUNTS.dan)
  const trudy = createTestEntity(web3, ACCOUNTS.trudy)
  const mallory = createTestEntity(web3, ACCOUNTS.mallory)

  await cards.registerAsync(dan.ethAddress)
  let balance = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(balance.toNumber(), 6)

  const startBlockNum = await web3.eth.getBlockNumber()

  await cards.depositToPlasmaAsync({ tokenId: 12, from: dan.ethAddress })

  const depositEvents: any[] = await authority.plasmaCashContract.getPastEvents('Deposit', {
    fromBlock: startBlockNum
  })
  const deposits = depositEvents.map<IPlasmaDeposit>(event =>
    marshalDepositEvent(event.returnValues)
  )
  t.equal(deposits.length, 1, 'All deposit events accounted for')

  await authority.submitPlasmaDepositAsync(deposits[0])

  const plasmaBlock1 = await authority.submitPlasmaBlockAsync()
  const plasmaBlock2 = await authority.submitPlasmaBlockAsync()
  const deposit1Slot = deposits[0].slot

  // Trudy creates an invalid spend of the coin to Mallory
  const coin = await trudy.getPlasmaCoinAsync(deposit1Slot)
  await trudy.transferTokenAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    denomination: 1,
    newOwner: mallory
  })

  // Operator includes it
  const trudyToMalloryBlock = await authority.submitPlasmaBlockAsync()

  // Mallory gives the coin back to Trudy.
  await mallory.transferTokenAsync({
    slot: deposit1Slot,
    prevBlockNum: trudyToMalloryBlock,
    denomination: 1,
    newOwner: trudy
  })

  // Operator includes it
  const malloryToTrudyBlock = await authority.submitPlasmaBlockAsync()

  // Having successufly challenged Mallory's exit Dan should be able to exit the coin
  await trudy.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: trudyToMalloryBlock,
    exitBlockNum: malloryToTrudyBlock
  })

  // Dan challenges with his coin that hasn't moved
  await dan.challengeBeforeAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    challengingBlockNum: coin.depositBlockNum
  })

  // 8 days pass without any response to the challenge
  await increaseTime(web3, 8 * 24 * 3600)
  await authority.finalizeExitsAsync()

  // Having successfully challenged Trudy-Mallory's exit Dan should be able to exit the coin
  await dan.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    exitBlockNum: coin.depositBlockNum
  })

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await authority.finalizeExitsAsync()

  await dan.withdrawAsync(deposit1Slot)

  const danBalanceBefore = await getEthBalanceAtAddress(web3, dan.ethAddress)
  await dan.withdrawBondsAsync()
  const danBalanceAfter = await getEthBalanceAtAddress(web3, dan.ethAddress)
  t.ok(danBalanceBefore.cmp(danBalanceAfter) < 0, 'END: Dan withdrew his bonds')

  const danTokensEnd = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(danTokensEnd.toNumber(), 6, 'END: Dan has correct number of tokens')

  t.end()
})
