import test from 'tape'
import BN from 'bn.js'
import Web3 from 'web3'
import { PlasmaUser } from 'loom-js'

import { increaseTime, getEthBalanceAtAddress } from './ganache-helpers'
import {
  sleep,
  ADDRESSES,
  ACCOUNTS,
  setupContracts,
  web3Endpoint,
  dappchainEndpoint,
  eventsEndpoint
} from './config'

export async function runRespondChallengeBeforeDemo(t: test.Test) {
  const web3 = new Web3(new Web3.providers.HttpProvider(web3Endpoint))
  const { cards } = setupContracts(web3)
  const cardsAddress = ADDRESSES.token_contract

  const dan = await PlasmaUser.createOfflineUser(
    ACCOUNTS.dan,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'dan_db'
  )

  const trudy = await PlasmaUser.createOfflineUser(
    ACCOUNTS.trudy,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'trudy_db'
  )

  // Give Trudy 5 tokens
  await cards.registerAsync(trudy.ethAddress)
  let balance = await cards.balanceOfAsync(trudy.ethAddress)
  t.equal(balance.toNumber(), 5)

  const startBlockNum = await web3.eth.getBlockNumber()
  // Trudy deposits a coin
  await trudy.depositERC721Async(new BN(21), cardsAddress)

  const deposits = await trudy.deposits()
  t.equal(deposits.length, 1, 'All deposit events accounted for')

  const deposit1Slot = deposits[0].slot

  // Trudy sends her coin to Dan
  const coin = await trudy.getPlasmaCoinAsync(deposit1Slot)
  let currentBlock = await trudy.getCurrentBlockAsync()
  await trudy.transferAndVerifyAsync(deposit1Slot, dan.ethAddress, 6)
  currentBlock = await trudy.pollForBlockChange(currentBlock, 20, 2000)

  // Dan exits the coin received by Trudy
  await dan.exitAsync(deposit1Slot)

  // Trudy tries to challengeBefore Dan's exit
  await trudy.challengeBeforeAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    challengingBlockNum: coin.depositBlockNum
  })
  await sleep(2000)

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await dan.finalizeExitsAsync()
  await dan.withdrawAsync(deposit1Slot)

  const danBalanceBefore = await getEthBalanceAtAddress(web3, dan.ethAddress)
  await dan.withdrawBondsAsync()
  const danBalanceAfter = await getEthBalanceAtAddress(web3, dan.ethAddress)
  t.ok(danBalanceBefore.cmp(danBalanceAfter) < 0, 'END: Dan withdrew his bonds')

  const danTokensEnd = await cards.balanceOfAsync(dan.ethAddress)
  // Dan had initially 5 from when he registered and he received 2 coins
  // 1 in this demo and 1 in a previous one.
  t.equal(danTokensEnd.toNumber(), 7, 'END: Dan has correct number of tokens')

  dan.disconnect()
  trudy.disconnect()

  t.end()
}
