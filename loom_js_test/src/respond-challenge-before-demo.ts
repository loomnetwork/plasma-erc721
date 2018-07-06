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

test('Plasma Cash Respond Challenge Before Demo', async t => {
  const web3 = new Web3('http://localhost:8545')
  const { cards } = setupContracts(web3)
  const authority = createTestEntity(web3, ACCOUNTS.authority)
  const dan = createTestEntity(web3, ACCOUNTS.dan)
  const trudy = createTestEntity(web3, ACCOUNTS.trudy)

  await cards.registerAsync(trudy.ethAddress)
  let balance = await cards.balanceOfAsync(trudy.ethAddress)
  t.equal(balance.toNumber(), 5)

  const startBlockNum = await web3.eth.getBlockNumber()

  await cards.depositToPlasmaAsync({ tokenId: 16, from: trudy.ethAddress })

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

  // Trudy sends her coin to Dan
  const coin = await trudy.getPlasmaCoinAsync(deposit1Slot)
  await trudy.transferTokenAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    denomination: 1,
    newOwner: dan
  })

  // Operator includes it
  const trudyToDanBlock = await authority.submitPlasmaBlockAsync()

  // Dan exits the coin received by Trudy
  await dan.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    exitBlockNum: trudyToDanBlock
  })

  // Trudy tries to challengeBefore Dan's exit
  await trudy.challengeBeforeAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    challengingBlockNum: coin.depositBlockNum
  })

  // Dan responds to the invalid challenge
  await dan.respondChallengeBeforeAsync({
    slot: deposit1Slot,
    challengingBlockNum: trudyToDanBlock
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
  // Dan had initially 5 from when he registered and he received 2 coins
  // 1 in this demo and 1 in a previous one.
  t.equal(danTokensEnd.toNumber(), 7, 'END: Dan has correct number of tokens')

  t.end()
})
