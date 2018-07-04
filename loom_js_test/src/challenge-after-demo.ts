import test from 'tape'
import Web3 from 'web3'
import BN from 'bn.js'
import { IPlasmaDeposit, marshalDepositEvent } from 'loom-js'

import { increaseTime, getEthBalanceAtAddress } from './ganache-helpers'
import { createTestEntity, ADDRESSES, ACCOUNTS } from './config'
import { EthCardsContract } from './cards-contract'

// All the contracts are expected to have been deployed to Ganache when this function is called.
function setupContracts(web3: Web3): { cards: EthCardsContract } {
  const abi = require('./contracts/cards-abi.json')
  const cards = new EthCardsContract(new web3.eth.Contract(abi, ADDRESSES.token_contract))
  return { cards }
}

test('Plasma Cash Challenge After Demo', async t => {
  const web3 = new Web3('http://localhost:8545')
  const { cards } = setupContracts(web3)
  const authority = createTestEntity(web3, ACCOUNTS.authority)
  const mallory = createTestEntity(web3, ACCOUNTS.mallory)
  const dan = createTestEntity(web3, ACCOUNTS.dan)

  // Give Mallory 5 tokens
  await cards.registerAsync(mallory.ethAddress)

  const danTokensStart = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(danTokensStart.toNumber(), 0, 'START: Dan has correct number of tokens')
  const malloryTokensStart = await cards.balanceOfAsync(mallory.ethAddress)
  t.equal(malloryTokensStart.toNumber(), 5, 'START: Mallory has correct number of tokens')

  const startBlockNum = await web3.eth.getBlockNumber()

  // Mallory deposits one of her coins to the plasma contract
  await cards.depositToPlasmaAsync({ tokenId: 6, from: mallory.ethAddress })
  await cards.depositToPlasmaAsync({ tokenId: 7, from: mallory.ethAddress })

  const depositEvents: any[] = await authority.plasmaCashContract.getPastEvents('Deposit', {
    fromBlock: startBlockNum
  })
  const deposits = depositEvents.map<IPlasmaDeposit>(event =>
    marshalDepositEvent(event.returnValues)
  )
  t.equal(deposits.length, 2, 'Mallory has correct number of deposits')

  const malloryTokensPostDeposit = await cards.balanceOfAsync(mallory.ethAddress)
  t.equal(
    malloryTokensPostDeposit.toNumber(),
    3,
    'POST-DEPOSIT: Mallory has correct number of tokens'
  )

  // NOTE: In practice the Plasma Cash Oracle will submit the deposits to the DAppChain,
  // we're doing it here manually to simplify the test setup.
  for (let i = 0; i < deposits.length; i++) {
    await authority.submitPlasmaDepositAsync(deposits[i])
  }

  const plasmaBlock1 = await authority.submitPlasmaBlockAsync()
  const plasmaBlock2 = await authority.submitPlasmaBlockAsync()

  const deposit1Slot = deposits[0].slot

  // Mallory -> Dan
  // Coin 6 was the first deposit of
  const coin = await mallory.getPlasmaCoinAsync(deposit1Slot)
  await mallory.transferTokenAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    denomination: 1,
    newOwner: dan
  })

  //incl_proofs, excl_proofs = mallory.get_coin_history(deposit1_utxo)
  //assert dan.verify_coin_history(deposit1_utxo, incl_proofs, excl_proofs)

  const plasmaBlock3 = await authority.submitPlasmaBlockAsync()
  //dan.watch_exits(deposit1_utxo)

  // Mallory attempts to exit spent coin (the one sent to Dan)
  await mallory.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: new BN(0),
    exitBlockNum: coin.depositBlockNum
  })

  // Mallory's exit should be auto-challenged by Dan's client, but watching/auto-challenge hasn't
  // been implemented yet, so challenge the exit manually for now...
  await dan.challengeAfterAsync({ slot: deposit1Slot, challengingBlockNum: plasmaBlock3 })

  // Having successufly challenged Mallory's exit Dan should be able to exit the coin
  await dan.startExitAsync({
    slot: deposit1Slot,
    prevBlockNum: coin.depositBlockNum,
    exitBlockNum: plasmaBlock3
  })
  //dan.stop_watching_exits(deposit1_utxo)

  // Jump forward in time by 8 days
  await increaseTime(web3, 8 * 24 * 3600)

  await authority.finalizeExitsAsync()

  await dan.withdrawAsync(deposit1Slot)

  const danBalanceBefore = await getEthBalanceAtAddress(web3, dan.ethAddress)
  await dan.withdrawBondsAsync()
  const danBalanceAfter = await getEthBalanceAtAddress(web3, dan.ethAddress)
  t.ok(danBalanceBefore.cmp(danBalanceAfter) < 0, 'END: Dan withdrew his bonds')

  const malloryTokensEnd = await cards.balanceOfAsync(mallory.ethAddress)
  t.equal(malloryTokensEnd.toNumber(), 3, 'END: Mallory has correct number of tokens')
  const danTokensEnd = await cards.balanceOfAsync(dan.ethAddress)
  t.equal(danTokensEnd.toNumber(), 1, 'END: Dan has correct number of tokens')

  t.end()
})
