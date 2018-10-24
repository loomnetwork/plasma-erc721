import test from 'tape'
import Web3 from 'web3'
import BN from 'bn.js'
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

export async function runChallengeAfterDemo(t: test.Test) {
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

  // Give Mallory 5 tokens
  await cards.registerAsync(mallory.ethAddress)

  const danTokensStart = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(danTokensStart.toNumber(), 0, 'START: Dan has correct number of tokens')
  const malloryTokensStart = await cards.balanceOfAsync(mallory.ethAddress)
  t.equal(malloryTokensStart.toNumber(), 5, 'START: Mallory has correct number of tokens')

  // Mallory deposits one of her coins to the plasma contract
  await mallory.depositERC721Async(new BN(6), cardsAddress)
  await mallory.depositERC721Async(new BN(7), cardsAddress)

  const deposits = await mallory.deposits()
  t.equal(deposits.length, 2, 'Mallory has correct number of deposits')

  const malloryTokensPostDeposit = await cards.balanceOfAsync(mallory.ethAddress)
  t.equal(
    malloryTokensPostDeposit.toNumber(),
    3,
    'POST-DEPOSIT: Mallory has correct number of tokens'
  )

  const deposit1Slot = deposits[0].slot

  // Mallory -> Dan
  const coin = await mallory.getPlasmaCoinAsync(deposit1Slot)
  let currentBlock = await mallory.getCurrentBlockAsync()
  await mallory.transferAndVerifyAsync(deposit1Slot, dan.ethAddress, 6)
  currentBlock = await mallory.pollForBlockChange(currentBlock, 20, 2000)
  t.equal(await dan.receiveAndWatchCoinAsync(deposit1Slot), true, 'Coin history verified')

  // Mallory attempts to exit spent coin (the one sent to Dan)
  // Needs to use the low level API to make an invalid tx
  await mallory.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    exitBlockNum: coin.depositBlockNum
  })

  // Having successufly challenged Mallory's exit Dan should be able to exit the coin
  await dan.exitAsync(deposit1Slot)

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await dan.finalizeExitsAsync()

  await dan.withdrawAsync(deposit1Slot)

  const danBalanceBefore = await getEthBalanceAtAddress(web3, dan.ethAddress)
  await dan.withdrawBondsAsync()
  const danBalanceAfter = await getEthBalanceAtAddress(web3, dan.ethAddress)
  t.ok(danBalanceBefore.cmp(danBalanceAfter) < 0, 'END: Dan withdrew his bonds')

  const malloryTokensEnd = await cards.balanceOfAsync(mallory.ethAddress)
  t.equal(malloryTokensEnd.toNumber(), 3, 'END: Mallory has correct number of tokens')
  const danTokensEnd = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(danTokensEnd.toNumber(), 1, 'END: Dan has correct number of tokens')

  dan.disconnect()
  mallory.disconnect()

  t.end()
}
