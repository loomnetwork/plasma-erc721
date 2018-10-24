import test from 'tape'
import Web3 from 'web3'
import { PlasmaUser } from 'loom-js'

import { increaseTime } from './ganache-helpers'
import {
  sleep,
  ADDRESSES,
  ACCOUNTS,
  web3Endpoint,
  dappchainEndpoint,
  eventsEndpoint
} from './config'

import BN from 'bn.js'

// Complex demo where we try to break the system _lol_
// A whatever interaction between fred and greg (& harry who joins late to the party)
// All interactions happen in ETH
export async function complexDemo(t: test.Test) {
  const web3 = new Web3(new Web3.providers.HttpProvider(web3Endpoint))

  const fred = await PlasmaUser.createOfflineUser(
    ACCOUNTS.fred,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'fred_db'
  )

  const greg = await PlasmaUser.createOfflineUser(
    ACCOUNTS.greg,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'greg_db'
  )

  // Fred deposits 5000 Wei split across 3 coins
  // Greg deposits 1000 Wei split across 3 coins
  await fred.depositETHAsync(new BN(1000))
  await fred.depositETHAsync(new BN(2000))
  await fred.depositETHAsync(new BN(3000))
  await greg.depositETHAsync(new BN(4000))
  await greg.depositETHAsync(new BN(6000))

  // Get deposit events for all
  const fred_deposits = await fred.deposits()
  const greg_deposits = await greg.deposits()

  t.equal(fred_deposits.length, 3, 'Fred deposits correct')
  t.equal(greg_deposits.length, 2, 'Greg deposits correct')

  let coins = await fred.getUserCoinsAsync()
  t.ok(coins[0].slot.eq(fred_deposits[0].slot), 'fred: got correct deposit coins 1')
  t.ok(coins[1].slot.eq(fred_deposits[1].slot), 'fred: got correct deposit coins 2')
  t.ok(coins[2].slot.eq(fred_deposits[2].slot), 'fred: got correct deposit coins 3')

  coins = await greg.getUserCoinsAsync()
  t.ok(coins[0].slot.eq(greg_deposits[0].slot), 'greg: got correct deposit coins 1')
  t.ok(coins[1].slot.eq(greg_deposits[1].slot), 'greg: got correct deposit coins 2')

  const coin1 = fred_deposits[0].slot
  const coin3 = fred_deposits[1].slot
  const coin5 = fred_deposits[2].slot
  const coin2 = greg_deposits[0].slot
  const coin4 = greg_deposits[1].slot

  await fred.watchBlocks()
  await greg.watchBlocks()

  let currentBlock = await fred.getCurrentBlockAsync()
  fred.transferAndVerifyAsync(coin1, greg.ethAddress)
  greg.transferAndVerifyAsync(coin2, fred.ethAddress)
  currentBlock = await fred.pollForBlockChange(currentBlock, 20, 2000)

  // They both try to exit and defraud each other
  await fred.exitAsync(coin1)
  await sleep(5000)
  // Add a sleep in between given that Greg will challenge and we'll get a nonce-too-low error if we
  await greg.exitAsync(coin2)

  // Wait a bit until the challenges are complete
  await sleep(7000)

  // Greg owns coin 1,4. Need to sort slot values since
  let slots = (await greg.getUserCoinsAsync()).map(c => c.slot).sort()
  t.equal((await greg.getUserCoinsAsync()).length, 2, 'Greg owns 2 coins')
  t.deepEqual(slots, [coin4, coin1].sort(), 'Greg owns the correct coins')

  // Fred owns coin 2,3,5
  slots = (await fred.getUserCoinsAsync()).map(c => c.slot).sort()
  t.equal((await fred.getUserCoinsAsync()).length, 3, 'fred owns 3 coins')
  t.deepEqual(slots, [coin5, coin2, coin3].sort(), 'Greg owns the correct coins')

  t.equal((await greg.getPlasmaCoinAsync(coin1)).state, 0, 'Greg succesfully challenged Fred')
  t.equal((await fred.getPlasmaCoinAsync(coin2)).state, 0, 'Fred succesfully challenged Greg')

  // Harry joins in the fun
  const harry = PlasmaUser.createOfflineUser(
    ACCOUNTS.harry,
    web3Endpoint,
    ADDRESSES.root_chain,
    dappchainEndpoint,
    eventsEndpoint,
    'harry_db'
  )
  await harry.watchBlocks()

  // Previously, coin1 went from DEPOSITED -> EXITING and now is back to DEPOSITED. This should be reflected on the dappchain state as well. Build521 does not reset a coin to DEPOSITED after it is in EXITING and is challenged.
  currentBlock = await fred.getCurrentBlockAsync()
  greg.transferAndVerifyAsync(coin1, harry.ethAddress).then(() => {
    greg.transferAndVerifyAsync(coin4, harry.ethAddress)
  })
  fred.transferAndVerifyAsync(coin3, harry.ethAddress)
  currentBlock = await fred.pollForBlockChange(currentBlock, 20, 2000)

  // Harry owns coin 1,3,4
  slots = (await harry.getUserCoinsAsync()).map(c => c.slot).sort()
  t.equal((await harry.getUserCoinsAsync()).length, 3, 'Harry owns 3 coins')
  t.deepEqual(slots, [coin1, coin3, coin4].sort(), 'Harry owns the correct coins')

  t.equal((await greg.getUserCoinsAsync()).length, 0, 'greg has no coins')

  // Fred owns coins 2,5
  slots = (await fred.getUserCoinsAsync()).map(c => c.slot).sort()
  t.equal((await fred.getUserCoinsAsync()).length, 2, 'Fred owns 2 coins')
  t.deepEqual(slots, [coin2, coin5].sort(), 'Fred owns the correct coins')

  try {
    // Let's try stealing some money
    await greg.transferAndVerifyAsync(coin4, harry.ethAddress)
  } catch (e) {
    t.ok(
      e.message.includes(
        `Failed to commit Tx: [PlasmaCash] failed to process transfer: can't transfer coin ${coin4.toString(
          10
        )}`
      ),
      'Tx1 should fail'
    )
  }

  try {
    // Let's try stealing some money
    await greg.transferAndVerifyAsync(coin3, harry.ethAddress)
  } catch (e) {
    t.ok(
      e.message.includes(
        `Failed to commit Tx: [PlasmaCash] failed to process transfer: can't transfer coin ${coin3.toString(
          10
        )}`
      ),
      'Tx2 should fail'
    )
  }

  try {
    // Let's try stealing some money
    await greg.transferAndVerifyAsync(coin1, harry.ethAddress)
  } catch (e) {
    t.ok(
      e.message.includes(
        `Failed to commit Tx: [PlasmaCash] failed to process transfer: can't transfer coin ${coin1.toString(
          10
        )}`
      ),
      'Tx3 should fail'
    )
  }

  t.equal((await fred.getUserCoinsAsync()).length, 2, 'Fred still owns 2 coins')
  // spam a bit
  await fred.depositETHAsync(new BN(10000))
  await sleep(3000)
  t.equal((await fred.getUserCoinsAsync()).length, 3, 'Fred owns 3 coins')
  currentBlock = await harry.getCurrentBlockAsync()
  await harry.transferAndVerifyAsync(coin4, greg.ethAddress)
  currentBlock = await harry.pollForBlockChange(currentBlock, 20, 2000)
  await fred.depositETHAsync(new BN(10000))
  await sleep(3000)
  t.equal((await fred.getUserCoinsAsync()).length, 4, 'Fred owns 4 coins')
  await fred.depositETHAsync(new BN(10000))
  await sleep(3000)
  t.equal((await fred.getUserCoinsAsync()).length, 5, 'Fred owns 5 coins')

  // spam a bit
  await fred.depositETHAsync(new BN(10000))
  await sleep(3000)
  t.equal((await fred.getUserCoinsAsync()).length, 6, 'Fred owns 6 coins')

  currentBlock = await greg.getCurrentBlockAsync()
  greg.transferAndVerifyAsync(coin4, harry.ethAddress)
  currentBlock = await greg.pollForBlockChange(currentBlock, 20, 2000)
  await fred.depositETHAsync(new BN(10000))
  await sleep(3000)
  t.equal((await fred.getUserCoinsAsync()).length, 7, 'Fred owns 7 coins')
  await fred.depositETHAsync(new BN(10000))
  await sleep(3000)
  t.equal((await fred.getUserCoinsAsync()).length, 8, 'Fred owns 8 coins')

  t.equal((await harry.getUserCoinsAsync()).length, 3, 'Harry still owns 3 coins')
  await harry.exitAsync(coin4)
  await harry.exitAsync(coin1)
  await harry.exitAsync(coin3)

  await sleep(5000)
  t.equal((await fred.getUserCoinsAsync()).length, 8, 'Fred still owns 8 coins')

  await fred.exitAsync(coin2)
  await fred.exitAsync(coin5)
  t.equal((await fred.getUserCoinsAsync()).length, 8, 'Fred still owns 8 coins')

  await sleep(5000)
  t.equal(
    (await fred.getPlasmaCoinAsync(coin2)).state,
    1,
    'Fred succesfully started an exit for coin 2'
  )
  t.equal(
    (await fred.getPlasmaCoinAsync(coin5)).state,
    1,
    'Fred succesfully started an exit for coin 5'
  )
  t.equal(
    (await harry.getPlasmaCoinAsync(coin3)).state,
    1,
    'Harry succesfully started an exit for coin 3'
  )
  t.equal(
    (await harry.getPlasmaCoinAsync(coin4)).state,
    1,
    'Harry succesfully started an exit for coin 4'
  )
  t.equal(
    (await harry.getPlasmaCoinAsync(coin1)).state,
    1,
    'Harry succesfully started an exit for coin 1'
  )

  t.equal((await fred.getUserCoinsAsync()).length, 8, 'Fred still owns 8 coins')

  // Greg for some whatever reason decides to finalize all exits
  await increaseTime(web3, 8 * 24 * 3600)
  await greg.finalizeExitsAsync()

  t.equal(
    (await fred.getPlasmaCoinAsync(coin2)).state,
    2,
    'Fred succesfully finalized the exit for coin 2'
  )
  t.equal(
    (await fred.getPlasmaCoinAsync(coin5)).state,
    2,
    'Fred succesfully finalized the exit for coin 5'
  )
  t.equal(
    (await harry.getPlasmaCoinAsync(coin3)).state,
    2,
    'Harry succesfully finalized the exit for coin 3'
  )
  t.equal(
    (await harry.getPlasmaCoinAsync(coin4)).state,
    2,
    'Harry succesfully finalized the exit for coin 4'
  )
  t.equal(
    (await harry.getPlasmaCoinAsync(coin1)).state,
    2,
    'Harry succesfully finalized the exit for coin 1'
  )

  t.equal((await fred.getUserCoinsAsync()).length, 8, 'Fred still owns 8 coins')

  await fred.withdrawAsync(coin2)
  await fred.withdrawAsync(coin5)
  await harry.withdrawAsync(coin3)
  await harry.withdrawAsync(coin1)
  await harry.withdrawAsync(coin4)

  t.equal((await fred.getUserCoinsAsync()).length, 8, 'Fred 6 coins')

  t.equal((await fred.getPlasmaCoinAsync(coin2)).state, 0, 'Fred succesfully withdrew coin 2')
  t.equal((await fred.getPlasmaCoinAsync(coin5)).state, 0, 'Fred succesfully withdrew coin 5')
  t.equal((await harry.getPlasmaCoinAsync(coin3)).state, 0, 'Harry succesfully withdrew coin 3')
  t.equal((await harry.getPlasmaCoinAsync(coin4)).state, 0, 'Harry succesfully withdrew coin 4')
  t.equal((await harry.getPlasmaCoinAsync(coin1)).state, 0, 'Harry succesfully withdrew coin 1')

  // Wait until oracle operations are done
  while ((await fred.getUserCoinsAsync()).length != 6) {
    await sleep(2000)
  }

  while ((await harry.getUserCoinsAsync()).length != 0) {
    await sleep(2000)
  }

  t.equal((await fred.getUserCoinsAsync()).length, 6, 'Withdraw oracle for fred OK')
  t.equal((await harry.getUserCoinsAsync()).length, 0, 'Withdraw oracle for harry OK')

  harry.disconnect()
  fred.disconnect()
  greg.disconnect()

  t.end()
}
