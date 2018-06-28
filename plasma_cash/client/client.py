import json

import rlp
from ethereum import utils

from child_chain.block import Block
from child_chain.transaction import Transaction, UnsignedTransaction

from .child_chain_service import ChildChainService


class Client(object):
    def __init__(
        self,
        root_chain,
        token_contract,
        child_chain=ChildChainService('http://localhost:8546'),
    ):
        self.root_chain = root_chain
        self.key = token_contract.account.privateKey
        self.token_contract = token_contract
        self.child_chain = child_chain
        self.child_block_interval = 1000

        # Proof related state
        self.incl_proofs = {}
        self.excl_proofs = {}
        self.txs = {}

        # Event watchers
        self.watchers = {}
        self.challenge_watchers = {}

    # Token Functions

    def register(self):
        ''' Register a new player and grant 5 cards, for demo purposes'''
        tx_hash, gas_used = self.token_contract.register()
        return tx_hash, gas_used

    def deposit(self, tokenId):
        ''' Deposit happens by a use calling the erc721 token contract '''
        tx_hash, gas_used = self.token_contract.deposit(tokenId)
        return tx_hash, gas_used

    # Plasma Functions

    def start_exit(self, slot, prev_tx_blk_num, tx_blk_num):
        '''
        As a user, you declare that you want to exit a coin at slot `slot`
        at the state which happened at block `tx_blk_num` and you also need to
        reference a previous block
        '''
        # TODO The actual proof information should be passed to a user from its
        # previous owners, this is a hacky way of getting the info from the
        # operator which sould be changed in the future after the exiting
        # process is more standardized
        if tx_blk_num % self.child_block_interval != 0:
            # In case the sender is exiting a Deposit transaction, they should
            # just create a signed transaction to themselves. There is no need
            # for a merkle proof.

            # prev_block = 0 , denomination = 1
            exiting_tx = Transaction(
                slot, 0, 1, self.token_contract.account.address
            )
            exiting_tx.make_mutable()
            exiting_tx.sign(self.key)
            exiting_tx.make_immutable()
            tx_hash, gas_used = self.root_chain.start_exit(
                slot,
                b'0x0',
                rlp.encode(exiting_tx, UnsignedTransaction),
                b'0x0',
                b'0x0',
                exiting_tx.sig,
                0,
                tx_blk_num,
            )
        else:
            # Otherwise, they should get the raw tx info from the block
            # And the merkle proof and submit these
            exiting_tx, exiting_tx_proof = self.get_tx_and_proof(
                tx_blk_num, slot
            )
            prev_tx, prev_tx_proof = self.get_tx_and_proof(
                prev_tx_blk_num, slot
            )

            tx_hash, gas_used = self.root_chain.start_exit(
                slot,
                rlp.encode(prev_tx, UnsignedTransaction),
                rlp.encode(exiting_tx, UnsignedTransaction),
                prev_tx_proof,
                exiting_tx_proof,
                exiting_tx.sig,
                prev_tx_blk_num,
                tx_blk_num,
            )
        return tx_hash, gas_used

    def challenge_before(self, slot, prev_tx_blk_num, tx_blk_num):
        if tx_blk_num % self.child_block_interval != 0:
            # In case the sender is exiting a Deposit transaction, they should
            # just create a signed transaction to themselves. There is no need
            # for a merkle proof.

            # prev_block = 0 , denomination = 1
            exiting_tx = Transaction(
                slot, 0, 1, self.token_contract.account.address
            )
            exiting_tx.make_mutable()
            exiting_tx.sign(self.key)
            exiting_tx.make_immutable()
            tx_hash, gas_used = self.root_chain.challenge_before(
                slot,
                b'0x0',
                rlp.encode(exiting_tx, UnsignedTransaction),
                b'0x0',
                b'0x0',
                exiting_tx.sig,
                0,
                tx_blk_num,
            )
        else:
            # Otherwise, they should get the raw tx info from the block
            # And the merkle proof and submit these
            exiting_tx, exiting_tx_proof = self.get_tx_and_proof(
                tx_blk_num, slot
            )
            prev_tx, prev_tx_proof = self.get_tx_and_proof(
                prev_tx_blk_num, slot
            )

            tx_hash, gas_used = self.root_chain.challenge_before(
                slot,
                rlp.encode(prev_tx, UnsignedTransaction),
                rlp.encode(exiting_tx, UnsignedTransaction),
                prev_tx_proof,
                exiting_tx_proof,
                exiting_tx.sig,
                prev_tx_blk_num,
                tx_blk_num,
            )
        return tx_hash, gas_used

    def respond_challenge_before(self, slot, challenging_block_number):
        '''
        Respond to an exit with invalid history challenge by proving that
        you were given the coin under question
        '''
        challenging_tx, proof = self.get_tx_and_proof(
            challenging_block_number, slot
        )

        tx_hash, gas_used = self.root_chain.respond_challenge_before(
            slot,
            challenging_block_number,
            rlp.encode(challenging_tx, UnsignedTransaction),
            proof,
            challenging_tx.sig,
        )
        return tx_hash, gas_used

    def challenge_between(self, slot, challenging_block_number):
        '''
        `Double Spend Challenge`: Challenge a double spend of a coin
        with a spend between the exit's blocks
        '''
        challenging_tx, proof = self.get_tx_and_proof(
            challenging_block_number, slot
        )

        tx_hash, gas_used = self.root_chain.challenge_between(
            slot,
            challenging_block_number,
            rlp.encode(challenging_tx, UnsignedTransaction),
            proof,
            challenging_tx.sig,
        )
        return tx_hash, gas_used

    def challenge_after(self, slot, challenging_block_number):
        '''
        `Exit Spent Coin Challenge`: Challenge an exit with a spend
        after the exit's blocks
        '''
        challenging_tx, proof = self.get_tx_and_proof(
            challenging_block_number, slot
        )
        tx_hash, gas_used = self.root_chain.challenge_after(
            slot,
            challenging_block_number,
            rlp.encode(challenging_tx, UnsignedTransaction),
            proof,
            challenging_tx.sig,
        )
        return tx_hash, gas_used

    def finalize_exit(self, slot):
        tx_hash, gas_used = self.root_chain.finalize_exit(slot)
        return tx_hash, gas_used

    def finalize_exits(self):
        tx_hash, gas_used = self.root_chain.finalize_exits()
        return tx_hash, gas_used

    def withdraw(self, slot):
        tx_hash, gas_used = self.root_chain.withdraw(slot)
        return tx_hash, gas_used

    def withdraw_bonds(self):
        tx_hash, gas_used = self.root_chain.withdraw_bonds()
        return tx_hash, gas_used

    def get_plasma_coin(self, slot):
        return self.root_chain.get_plasma_coin(slot)

    def get_block_root(self, blknum):
        return self.root_chain.get_block_root(blknum)

    def check_inclusion(self, leaf, root, slot, proof):
        return self.root_chain.check_inclusion(leaf, root, slot, proof)

    def check_exclusion(self, root, slot, proof):
        return self.root_chain.check_exclusion(root, slot, proof)

    # Child Chain Functions

    def get_block_numbers(self, slot):
        # First get the coin's deposit block
        # todo efficiency -> start_block should be updated to the last block
        # obtained last time
        start_block = self.get_plasma_coin(slot)['deposit_block']

        # Get next non-deposit block
        next_deposit = (
            (start_block + self.child_block_interval)
            // self.child_block_interval
            * self.child_block_interval
        )
        end_block = self.get_block_number()

        # Create a list of indexes with coin's deposit block
        # and all subsequent submitted blocks that followed
        block_numbers = [start_block] + list(
            range(next_deposit, end_block + 1, self.child_block_interval)
        )
        return block_numbers

    def get_coin_history(self, slot):
        block_numbers = self.get_block_numbers(slot)

        incl_proofs = {}
        excl_proofs = {}
        txs = {}
        for blknum in block_numbers:
            blk_root = self.root_chain.get_block_root(blknum)
            tx, proof = self.get_tx_and_proof(blknum, slot)
            txs[blknum] = tx
            if self.check_inclusion(tx, blk_root, slot, proof):
                incl_proofs[blknum] = proof
            else:
                excl_proofs[blknum] = proof

        # Save the proofs to the client's "state", and return
        self.incl_proofs[slot] = incl_proofs
        self.excl_proofs[slot] = excl_proofs
        self.txs[slot] = txs
        return incl_proofs, excl_proofs

    # received_proofs should be a dictionary with merkle branches for each
    # block
    def verify_coin_history(self, slot, incl_proofs, excl_proofs):
        # Sanity checks, make sure incl_proofs and excl_proofs have all the
        # correct keys for the coin
        incl_keys = set(incl_proofs)
        excl_keys = set(excl_proofs)
        if len(incl_keys.intersection(excl_keys)) != 0:
            return False

        # gets all of the coin's block numbers
        block_numbers = self.get_block_numbers(slot)
        # ensure that all keys are included
        if incl_keys.union(excl_keys) != set(block_numbers):
            return False

        # assert inclusion proofs
        for blknum, proof in incl_proofs.items():
            blk_root = self.root_chain.get_block_root(blknum)
            # should we be polling the tx from the operator or trusting the
            # receiver?
            tx = self.get_tx(blknum, slot)
            if not self.check_inclusion(tx, blk_root, slot, proof):
                return False

        # assert exclusion proof / i.e. leaf at that slot is empty hash
        for blknum, proof in excl_proofs.items():
            blk_root = self.root_chain.get_block_root(blknum)
            if not self.check_exclusion(blk_root, slot, proof):
                return False
        # If it does not hit any of the return false branches, it's OK
        return True

    def submit_block(self):
        return self.child_chain.submit_block()

    def send_transaction(self, slot, prev_block, new_owner):
        new_owner = utils.normalize_address(new_owner)
        tx = Transaction(slot, prev_block, 1, new_owner)
        tx.make_mutable()
        tx.sign(self.key)
        tx.make_immutable()
        self.child_chain.send_transaction(rlp.encode(tx, Transaction).hex())
        return tx

    def watch_challenges(self, slot):
        self.challenge_watchers[slot] = self.root_chain.watch_event(
            'ChallengedExit',
            self._respond_to_challenge,
            0.1,
            filters={'slot': slot},
        )

    def _respond_to_challenge(self, event):
        slot = event['args']['slot']
        print(
            "CHALLENGE DETECTED by {} -- slot: {}".format(
                self.token_contract.account.address, slot
            )
        )
        # fetch coin history
        incl_proofs, excl_proofs = self.get_coin_history(slot)
        received_block = max(incl_proofs.keys())
        self.respond_challenge_before(slot, received_block)

    def stop_watching_challenges(self, slot):
        # a user stops watching exits of a particular coin after transferring
        # it to another plasma user
        event_filter = self.challenge_watchers[slot]
        self.root_chain.w3.eth.uninstallFilter(event_filter.filter_id)

    def watch_exits(self, slot):
        # TODO figure out how to have this function be invoked automatically
        self.watchers[slot] = self.root_chain.watch_event(
            'StartedExit', self._respond_to_exit, 0.1, filters={'slot': slot}
        )

    def _respond_to_exit(self, event):
        ''' Called by event watcher and checks that the exit event is
        legitimate
        '''
        slot = event['args']['slot']
        owner = event['args']['owner']
        print(
            "EXIT DETECTED by {} -- slot: {}, owner: {}".format(
                self.token_contract.account.address, slot, owner
            )
        )

        # A coin-owner will automatically start a challenge if he believes he
        # owns a coin that has been exited by someone else
        if owner != self.token_contract.account.address:
            print("invalid exit...challenging")

            # fetch exit information
            exit_details = self.root_chain.get_exit(slot)
            [owner, prev_block, exit_block, state] = exit_details

            # fetch coin history
            incl_proofs, excl_proofs = self.get_coin_history(slot)
            blocks = self.get_block_numbers(slot)  # skip the deposit tx block
            for blk in blocks:
                if blk not in incl_proofs:
                    continue
                if blk > exit_block:
                    print(
                        'CHALLENGE AFTER -- {} at block {}'.format(slot, blk)
                    )
                    self.challenge_after(slot, blk)
                    break
                elif prev_block < blk < exit_block:
                    print(
                        'CHALLENGE BETWEEN --  {} at block {}'.format(
                            slot, blk
                        )
                    )
                    self.challenge_between(slot, blk)
                    break
                elif blk < prev_block < exit_block:
                    # Need to find a previous block
                    tx = self.get_tx(blk, slot)
                    print(
                        'CHALLENGE BEFORE --  {} at prev block {} / block {}'
                        .format(
                            slot, tx.prev_block, blk
                        )
                    )
                    self.challenge_before(slot, tx.prev_block, blk)
                    break
        else:
            print("valid exit")

    def stop_watching_exits(self, slot):
        # a user stops watching exits of a particular coin after transferring
        # it to another plasma user
        event_filter = self.watchers[slot]
        self.root_chain.w3.eth.uninstallFilter(event_filter.filter_id)

    def get_block_number(self):
        return self.child_chain.get_block_number()

    def get_current_block(self):
        block = self.child_chain.get_current_block()
        return rlp.decode(utils.decode_hex(block), Block)

    def get_block(self, blknum):
        block = self.child_chain.get_block(blknum)
        return rlp.decode(utils.decode_hex(block), Block)

    def get_tx(self, blknum, slot):
        tx_bytes = self.child_chain.get_tx(blknum, slot)
        tx = rlp.decode(utils.decode_hex(tx_bytes), Transaction)
        return tx

    def get_tx_and_proof(self, blknum, slot):
        data = json.loads(self.child_chain.get_tx_and_proof(blknum, slot))
        tx = rlp.decode(utils.decode_hex(data['tx']), Transaction)
        proof = utils.decode_hex(data['proof'])
        return tx, proof

    def get_proof(self, blknum, slot):
        return utils.decode_hex(self.child_chain.get_proof(blknum, slot))

    def get_all_deposits(self):
        return self.root_chain.get_all_deposits(
            self.root_chain.account.address
        )
