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

export async function runChallengeBeforeDemo(t: test.Test) {
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

  const mallory = await PlasmaUser.createOfflineUser(
    ACCOUNTS.mallory,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'mallory_db'
  )

  const trudy = await PlasmaUser.createOfflineUser(
    ACCOUNTS.trudy,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'trudy_db'
  )

  // Give Dan 5 tokens
  await cards.registerAsync(dan.ethAddress)
  let balance = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(balance.toNumber(), 6)

  // Dan deposits a coin
  await dan.depositERC721Async(new BN(16), cardsAddress)
  const deposits = await dan.deposits()
  t.equal(deposits.length, 1, 'All deposit events accounted for')

  const deposit1Slot = deposits[0].slot

  const coin = await dan.getPlasmaCoinAsync(deposit1Slot)

  // Trudy creates an invalid spend of the coin to Mallory
  let currentBlock = await trudy.getCurrentBlockAsync()
  await trudy.transferAndVerifyAsync(deposit1Slot, mallory.ethAddress, 6)
  const trudyToMalloryBlock = await trudy.pollForBlockChange(currentBlock, 20, 2000)

  await mallory.transferAndVerifyAsync(deposit1Slot, trudy.ethAddress, 6)
  const malloryToTrudyBlock = await mallory.pollForBlockChange(trudyToMalloryBlock, 20, 2000)

  // Low level call for the malicious exit
  await trudy.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: trudyToMalloryBlock,
    exitBlockNum: malloryToTrudyBlock
  })
  // Dan challenges with his coin that hasn't moved

  await sleep(2000)

  // 8 days pass without any response to the challenge
  await increaseTime(web3, 8 * 24 * 3600)
  await dan.finalizeExitsAsync()

  // Having successufly challenged Mallory's exit Dan should be able to exit the coin
  await dan.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    exitBlockNum: coin.depositBlockNum
  })

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await dan.finalizeExitsAsync()

  await dan.withdrawAsync(deposit1Slot)

  const danBalanceBefore = await getEthBalanceAtAddress(web3, dan.ethAddress)
  await dan.withdrawBondsAsync()
  const danBalanceAfter = await getEthBalanceAtAddress(web3, dan.ethAddress)
  t.ok(danBalanceBefore.cmp(danBalanceAfter) < 0, 'END: Dan withdrew his bonds')

  const danTokensEnd = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(danTokensEnd.toNumber(), 6, 'END: Dan has correct number of tokens')

  dan.disconnect()
  mallory.disconnect()
  trudy.disconnect()

  t.end()
}
