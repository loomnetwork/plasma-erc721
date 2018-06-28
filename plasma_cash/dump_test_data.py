import rlp

from child_chain.transaction import Transaction, UnsignedTransaction
from dependency_config import container

token_contract = container.get_token('alice')
tx = Transaction(5, 0, 1, token_contract.account.address)
tx_hex = rlp.encode(tx, UnsignedTransaction).hex()
print(
    'Transaction(5, 0, 1, {}): {}'.format(
        token_contract.account.address, tx_hex
    )
)

tx = Transaction(5, 85478557858583, 1, token_contract.account.address)
tx_hex = rlp.encode(tx, UnsignedTransaction).hex()
print(
    'Transaction(5, 85478557858583, 1, {}): {}'.format(
        token_contract.account.address, tx_hex
    )
)

tx.sign(token_contract.account.privateKey)
print('Transaction Hash: {}'.format(tx.hash.hex()))
print('Transaction Sig: {}'.format(tx.sig.hex()))
