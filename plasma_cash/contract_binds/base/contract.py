import json
import time
from threading import Thread

from web3.utils.events import get_event_data

from ..utils.getWeb3 import getWeb3


class Contract(object):
    '''Base class for interfacing with a contract'''

    def __init__(self, keystore, address, abi_file, endpoint):
        w3 = getWeb3(endpoint)
        with open(abi_file) as f:
            abi = json.load(f)['abi']
        contract = w3.eth.contract(
            abi=abi, address=w3.toChecksumAddress(address)
        )
        self.w3 = w3

        if keystore is not None:
            self.account = self.to_account(keystore)
        self.contract = contract

    def to_account(self, data):
        account = self.w3.eth.account.privateKeyToAccount(data)
        del data
        return account

    def sign_and_send(self, func, args, value=0, gas=1000000):
        ''' Expecting all arguments in 1 array '''
        signed_tx = self._sign_function_call(
            func,
            args,
            value,
            # may need to change gas
            gas,
        )

        try:
            tx_hash, gas_used = self._send_raw_tx(signed_tx)
        except Exception as e:
            print('FAILURE: ', e)
            info = 'Failed: {}, Args: {}'.format(func.__name__, args)
            print(info)
        return tx_hash, gas_used

    def send_transaction(self, to, value):
        signed_tx = self._sign_transaction(to, value)
        return self._send_raw_tx(signed_tx)

    def _sign_transaction(self, to, value):
        gas = 21000
        gasPrice = self.w3.toWei('10', 'gwei')

        raw_tx = {
            'chainId': int(self.w3.version.network),
            'to': self.w3.toChecksumAddress(to),
            'value': value,
            'gas': gas,
            'gasPrice': gasPrice,
            'nonce': self.w3.eth.getTransactionCount(self.account.address),
        }

        # print(raw_tx)

        signed_tx = self.account.signTransaction(raw_tx)

        return signed_tx

    def _sign_function_call(self, func, args, value, gas):
        """
            Takes reading and timestamp and creates a
            raw transaction call to `ping` at the target contract
            TODO: Add option to modify gas
        """
        # Build the raw transaction
        raw_tx = func(*args).buildTransaction(
            {
                'gas': gas,
                'value': value,
                'nonce': self.w3.eth.getTransactionCount(self.account.address),
            }
        )
        raw_tx['to'] = self.w3.toChecksumAddress(raw_tx['to'])

        # Sign the transaction with the meter's private key
        signed_tx = self.account.signTransaction(raw_tx)

        return signed_tx

    def _send_raw_tx(self, signed_tx):
        tx_hash = self.w3.eth.sendRawTransaction(signed_tx.rawTransaction)
        gas_used = self.waitForTxReceipt(tx_hash)['gasUsed']
        return tx_hash, gas_used

    def waitForTxReceipt(self, tx):
        receipt = self.w3.eth.getTransactionReceipt(tx)
        while receipt is None:
            time.sleep(1)  # Block time avg
            receipt = self.w3.eth.getTransactionReceipt(tx)
        return receipt

    def get_event_data(self, event_name, tx_hash):
        tx_logs = self.w3.eth.getTransactionReceipt(tx_hash)['logs']
        event_abi = self.contract._find_matching_event_abi(event_name)
        matched = []
        for log in tx_logs:
            try:
                d = get_event_data(event_abi, log)
            except Exception as e:
                continue
            matched.append(d)
        return matched

    def watch_event(
        self,
        event_name,
        callback,
        interval,
        fromBlock=0,
        toBlock='latest',
        filters=None,
    ):
        event_filter = self.install_filter(
            event_name, fromBlock, toBlock, filters
        )
        Thread(
            target=self.watcher,
            args=(event_filter, callback, interval),
            daemon=True,
        ).start()
        return event_filter

    def watcher(self, event_filter, callback, interval):
        while True:
            for event in event_filter.get_new_entries():
                callback(event)
                time.sleep(interval)

    def install_filter(
        self, event_name, fromBlock=0, toBlock='latest', filters=None
    ):
        event = getattr(self.contract.events, event_name)
        eventFilter = event.createFilter(
            fromBlock=fromBlock, toBlock=toBlock, argument_filters=filters
        )
        return eventFilter
