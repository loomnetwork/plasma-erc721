import test from 'tape'
import Web3 from 'web3'
import { IPlasmaDeposit, marshalDepositEvent } from 'loom-js'

import { increaseTime, getEthBalanceAtAddress } from './ganache-helpers'
import { ADDRESSES, ACCOUNTS, createTestEntity } from './config'
import { EthCardsContract } from './cards-contract'

// All the contracts are expected to have been deployed to Ganache when this function is called.
function setupContracts(web3: Web3): { cards: EthCardsContract } {
  const abi = require('./contracts/cards-abi.json')
  const cards = new EthCardsContract(new web3.eth.Contract(abi, ADDRESSES.token_contract))
  return { cards }
}

test('Plasma Cash Challenge Between Demo', async t => {
  const web3 = new Web3('http://localhost:8545')
  const { cards } = setupContracts(web3)
  const authority = createTestEntity(web3, ACCOUNTS.authority)
  const alice = createTestEntity(web3, ACCOUNTS.alice)
  const bob = createTestEntity(web3, ACCOUNTS.bob)
  const eve = createTestEntity(web3, ACCOUNTS.eve)

  const bobTokensStart = await cards.balanceOfAsync(bob.ethAddress)

  // Give Eve 5 tokens
  await cards.registerAsync(eve.ethAddress)

  const startBlockNum = await web3.eth.getBlockNumber()

  // Eve deposits a coin
  await cards.depositToPlasmaAsync({ tokenId: 11, from: eve.ethAddress })
  const depositEvents: any[] = await authority.plasmaCashContract.getPastEvents('Deposit', {
    fromBlock: startBlockNum
  })
  const deposits = depositEvents.map<IPlasmaDeposit>(event =>
    marshalDepositEvent(event.returnValues)
  )
  t.equal(deposits.length, 1, 'Eve has correct number of deposits')

  // NOTE: In practice the Plasma Cash Oracle will submit the deposits to the DAppChain,
  // we're doing it here manually to simplify the test setup.
  for (let i = 0; i < deposits.length; i++) {
    await authority.submitPlasmaDepositAsync(deposits[i])
  }

  const deposit1Slot = deposits[0].slot

  // wait to make sure that events get fired correctly
  //time.sleep(2)

  // Eve sends her plasma coin to Bob
  const coin = await eve.getPlasmaCoinAsync(deposit1Slot)
  await eve.transferTokenAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    denomination: 1,
    newOwner: bob
  })

  const eveToBobBlockNum = await authority.submitPlasmaBlockAsync()
  // bob.watch_exits(deposit1_utxo)

  // Eve sends this same plasma coin to Alice
  await eve.transferTokenAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    denomination: 1,
    newOwner: alice
  })

  const eveToAliceBlockNum = await authority.submitPlasmaBlockAsync()

  // FIXME: the start exit tx is reverted by the evm, need to figure out why, perhaps tx proofs are
  //        wrong?
  // Alice attempts to exit here double-spent coin
  await alice.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    exitBlockNum: eveToAliceBlockNum
  })

  // Alice's exit should be auto-challenged by Bob's client, but watching/auto-challenge hasn't
  // been implemented yet, so challenge the exit manually for now...
  await bob.challengeBetweenAsync({ slot: deposit1Slot, challengingBlockNum: eveToBobBlockNum })

  await bob.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    exitBlockNum: eveToBobBlockNum
  })

  // bob.stop_watching_exits(deposit1_utxo)

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await authority.finalizeExitsAsync()

  await bob.withdrawAsync(deposit1Slot)

  const bobBalanceBefore = await getEthBalanceAtAddress(web3, bob.ethAddress)

  await bob.withdrawBondsAsync()

  const bobBalanceAfter = await getEthBalanceAtAddress(web3, bob.ethAddress)

  t.ok(bobBalanceBefore.cmp(bobBalanceAfter) < 0, 'END: Bob did not withdraw his bonds')

  const bobTokensEnd = await cards.balanceOfAsync(bob.ethAddress)

  t.equal(
    bobTokensEnd.toNumber(),
    bobTokensStart.toNumber() + 1,
    'END: Bob has incorrect number of tokens'
  )

  t.end()
})
