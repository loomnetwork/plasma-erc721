from .base.contract import Contract


class PlasmaCash(Contract):
    '''Plasma Cash bindings for python '''

    def __init__(self, private_key, abi_file, address, endpoint):
        super().__init__(private_key, address, abi_file, endpoint)
        self.BOND = self.w3.toWei(0.1, 'ether')

    def challenge_before(
        self,
        slot,
        prev_tx_bytes,
        exiting_tx_bytes,
        prev_tx_inclusion_proof,
        exiting_tx_inclusion_proof,
        sig,
        prev_tx_block_num,
        exiting_tx_block_num,
    ):
        args = [
            slot,
            prev_tx_bytes,
            exiting_tx_bytes,
            prev_tx_inclusion_proof,
            exiting_tx_inclusion_proof,
            sig,
            [prev_tx_block_num, exiting_tx_block_num],
        ]

        return self.sign_and_send(
            self.contract.functions.challengeBefore, args, value=self.BOND
        )

    def respond_challenge_before(
        self,
        slot,
        challenging_block_number,
        challenging_transaction,
        proof,
        sig,
    ):
        args = [
            slot,
            challenging_block_number,
            challenging_transaction,
            proof,
            sig,
        ]
        return self.sign_and_send(
            self.contract.functions.respondChallengeBefore, args
        )

    def challenge_between(
        self,
        slot,
        challenging_block_number,
        challenging_transaction,
        proof,
        sig,
    ):
        args = [
            slot,
            challenging_block_number,
            challenging_transaction,
            proof,
            sig,
        ]
        return self.sign_and_send(
            self.contract.functions.challengeBetween, args
        )

    def challenge_after(
        self,
        slot,
        challenging_block_number,
        challenging_transaction,
        proof,
        sig,
    ):
        args = [
            slot,
            challenging_block_number,
            challenging_transaction,
            proof,
            sig,
        ]
        return self.sign_and_send(self.contract.functions.challengeAfter, args)

    def start_exit(
        self,
        uid,
        prev_tx,
        exiting_tx,
        prev_tx_proof,
        exiting_tx_proof,
        sigs,
        prev_tx_blk_num,
        tx_blk_num,
    ):
        args = [
            uid,
            prev_tx,
            exiting_tx,
            prev_tx_proof,
            exiting_tx_proof,
            sigs,
            [prev_tx_blk_num, tx_blk_num],
        ]
        return self.sign_and_send(
            self.contract.functions.startExit, args, value=self.BOND
        )

    def finalize_exits(self):
        args = []
        return self.sign_and_send(self.contract.functions.finalizeExits, args)

    def finalize_exit(self, slot):
        args = [slot]
        return self.sign_and_send(self.contract.functions.finalizeExit, args)

    def withdraw(self, uid):
        args = [uid]
        return self.sign_and_send(self.contract.functions.withdraw, args)

    def submit_block(self, root):
        args = [root]
        return self.sign_and_send(self.contract.functions.submitBlock, args)

    def withdraw_bonds(self):
        return self.sign_and_send(self.contract.functions.withdrawBonds, [])

    def get_plasma_coin(self, slot):
        data = self.contract.functions.getPlasmaCoin(slot).call()
        ret = {
            'uid': data[0],
            'deposit_block': data[1],
            'denomination': data[2],
            'owner': data[3],
            'contract_address': data[4],
            'state': data[5],
        }
        return ret

    def get_all_deposits(self, address, fromBlock=0):
        event_filter = self.contract.events.Deposit.createFilter(
            fromBlock=fromBlock,
            toBlock='latest',
            argument_filters={'from': address},
        )
        return event_filter.get_all_entries()

    def get_block_root(self, blknum):
        ret = self.contract.functions.getBlockRoot(blknum).call()
        return ret

    def get_exit(self, slot):
        ret = self.contract.functions.getExit(slot).call()
        return ret

    def check_inclusion(self, tx, root, slot, proof):
        if tx.prev_block == 0:  # deposit tx
            ret = tx.hash == root
        else:
            ret = self.contract.functions.checkMembership(
                tx.hash, root, slot, proof
            ).call()
        return ret

    def check_exclusion(self, root, slot, proof):
        empty_hash = (
            '0x290decd9548b62a8d60345a988386'
            + 'fc84ba6bc95484008f6362f93160ef3e563'
        )
        ret = self.contract.functions.checkMembership(
            empty_hash, root, slot, proof
        ).call()
        return ret
