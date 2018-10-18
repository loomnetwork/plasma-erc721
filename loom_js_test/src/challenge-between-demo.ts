import test from 'tape'
import Web3 from 'web3'
import { PlasmaUser } from 'loom-js'

import { increaseTime, getEthBalanceAtAddress } from './ganache-helpers'
import { sleep, ADDRESSES, ACCOUNTS, setupContracts, pollForBlockChange } from './config'

export async function runChallengeBetweenDemo(t: test.Test) {
  const web3Endpoint = 'ws://127.0.0.1:8545'
  const dappchainEndpoint = 'http://localhost:46658'
  const web3 = new Web3(new Web3.providers.WebsocketProvider(web3Endpoint))
  const { cards } = setupContracts(web3)

  const authority = PlasmaUser.createUser(
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    ACCOUNTS.authority
  )
  const alice = PlasmaUser.createUser(
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    ACCOUNTS.alice
  )
  const bob = PlasmaUser.createUser(
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    ACCOUNTS.bob
  )
  const eve = PlasmaUser.createUser(
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    ACCOUNTS.eve
  )

  const bobTokensStart = await cards.balanceOfAsync(bob.ethAddress)

  // Give Eve 5 tokens
  await cards.registerAsync(eve.ethAddress)

  // Eve deposits a coin
  let currentBlock = await authority.getCurrentBlockAsync()
  await cards.depositToPlasmaAsync({ tokenId: 11, from: eve.ethAddress })
  currentBlock = await pollForBlockChange(authority, currentBlock, 20, 2000)
  const deposits = await eve.deposits()
  t.equal(deposits.length, 1, 'Eve has correct number of deposits')

  const deposit1Slot = deposits[0].slot

  // Eve sends her plasma coin to Bob
  const coin = await eve.getPlasmaCoinAsync(deposit1Slot)
  await eve.transferAsync(deposit1Slot, bob.ethAddress)
  currentBlock = await pollForBlockChange(authority, currentBlock, 20, 2000)
  await sleep(2000) // need to wait a couple of seconds so that the onchain contract transaction gets submitted.

  t.equal(await bob.receiveCoinAsync(deposit1Slot), true, 'Coin history verified')
  const bobCoin = bob.watchExit(deposit1Slot, coin.depositBlockNum)

  // Eve sends this same plasma coin to Alice
  await eve.transferAsync(deposit1Slot, alice.ethAddress)
  currentBlock = await pollForBlockChange(authority, currentBlock, 20, 2000)

  // Alice attempts to exit her double-spent coin
  // Low level call to exit the double spend
  await alice.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    exitBlockNum: currentBlock
  })
  // Bob challenges here

  await sleep(2000)

  await bob.exitAsync(deposit1Slot)
  bob.stopWatching(bobCoin)

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await authority.finalizeExitsAsync()

  await bob.withdrawAsync(deposit1Slot)

  const bobBalanceBefore = await getEthBalanceAtAddress(web3, bob.ethAddress)

  await bob.withdrawBondsAsync()

  const bobBalanceAfter = await getEthBalanceAtAddress(web3, bob.ethAddress)

  t.ok(bobBalanceBefore.cmp(bobBalanceAfter) < 0, 'END: Bob withdrew his bonds')

  const bobTokensEnd = await cards.balanceOfAsync(bob.ethAddress)

  t.equal(
    bobTokensEnd.toNumber(),
    bobTokensStart.toNumber() + 1,
    'END: Bob has correct number of tokens'
  )

  // Close the websocket, hacky :/
  // @ts-ignore
  web3.currentProvider.connection.close()
  authority.disconnect()
  alice.disconnect()
  bob.disconnect()
  eve.disconnect()

  t.end()
}
