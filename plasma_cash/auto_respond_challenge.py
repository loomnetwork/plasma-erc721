import time

from client.client import Client
from dependency_config import container
from utils.utils import increaseTime

dan = Client(container.get_root('dan'), container.get_token('dan'))
trudy = Client(container.get_root('trudy'), container.get_token('trudy'))
authority = Client(
    container.get_root('authority'), container.get_token('authority')
)

# Give Trudy 5 tokens
trudy.register()

danTokensStart = dan.token_contract.balance_of()

# Trudy deposits a coin
tx_hash, gas_used = trudy.deposit(21)
event_data = trudy.root_chain.get_event_data('Deposit', tx_hash)
deposit1_utxo = event_data[0]['args']['slot']

# wait to make sure that events get fired correctly
time.sleep(2)

trudy_submit_block = authority.get_block_number()
trudyTokensStart = trudy.token_contract.balance_of()

coin = trudy.get_plasma_coin(deposit1_utxo)
authority.submit_block()
trudy.watch_exits(deposit1_utxo)

# Trudy sends her coin to Dan
trudy_to_dan = trudy.send_transaction(
    deposit1_utxo, coin['deposit_block'], dan.token_contract.account.address
)
authority.submit_block()
trudy_to_dan_block = authority.get_block_number()
trudy.stop_watching_exits(deposit1_utxo)

# Dan attempts to exit his coin
coin = dan.get_plasma_coin(deposit1_utxo)
dan.start_exit(deposit1_utxo, coin['deposit_block'], trudy_to_dan_block)
authority.submit_block()
dan.watch_exits(deposit1_utxo)
dan.watch_challenges(deposit1_utxo)

# Dan is challenged by Trudy
trudy.challenge_before(deposit1_utxo, 0, coin['deposit_block'])

# Wait for dan to automatically respond to the challenge
time.sleep(2)

# Dan successfully finalizes his exit
w3 = dan.root_chain.w3
increaseTime(w3, 8 * 24 * 3600)
authority.finalize_exits()

dan.withdraw(deposit1_utxo)

danTokensEnd = dan.token_contract.balance_of()
print('dan has {} tokens'.format(danTokensEnd))
assert (
    danTokensEnd == danTokensStart + 1
), "END: dan has incorrect number of tokens"
print('Automatic challenge response success :)')
