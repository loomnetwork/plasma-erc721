pragma solidity ^0.4.24;

// Zeppelin Imports
import "openzeppelin-solidity/contracts/token/ERC721/ERC721.sol";
import "openzeppelin-solidity/contracts/token/ERC721/ERC721Receiver.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";

// Lib deps
import "../Libraries/Transaction/Transaction.sol";
import "../Libraries/ECVerify.sol";

import "./SparseMerkleTree.sol";
import "./ValidatorManagerContract.sol";


contract RootChain is ERC721Receiver {

    /**
     * Event for coin deposit logging.
     * @notice The Deposit event indicates that a deposit block has been added
     *         to the Plasma chain
     * @param slot Plasma slot, a unique identifier, assigned to the deposit
     * @param blockNumber The index of the block in which a deposit transaction
     *                    is included
     * @param denomination Quantity of a particular coin deposited
     * @param from The address of the depositor
     */
    event Deposit(uint64 indexed slot, uint256 blockNumber, uint64 denomination, address indexed from, address indexed contractAddress);
    /**
     * Event for block submission logging
     * @notice The event indicates the addition of a new Plasma block
     * @param blockNumber The block number of the submitted block
     * @param root The root hash of the Merkle tree containing all of a block's
     *             transactions.
     * @param timestamp The time when a block was added to the Plasma chain
     */
    event SubmittedBlock(uint256 blockNumber, bytes32 root, uint256 timestamp);


    /**
     * Event for logging exit starts
     * @param slot The slot of the coin being exited
     * @param owner The user who claims to own the coin being exited
     */
    event StartedExit(uint64 indexed slot, address indexed owner);
    /**
     * Event for exit challenge logging
     * @notice This event only fires if `challengeBefore` is called. Other
     *         types of challenges cannot be responded to and thus do not
     *         require an event.
     * @param slot The slot of the coin whose exit was challenged
     */
    event ChallengedExit(uint64 indexed slot);
    /**
     * Event for exit response logging
     * @notice This only logs responses to `challengeBefore`, other challenges
     *         do not require responses.
     * @param slot The slot of the coin whose challenge was responded to
     */
    event RespondedExitChallenge(uint64 indexed slot);
    /**
     * Event for exit finalization logging
     * @param slot The slot of the coin whose exit has been finalized
     * @param owner The owner of the coin whose exit has been finalized
     */
    event FinalizedExit(uint64 indexed slot, address owner);

    /**
     * Event to log the freeing of a bond
     * @param from The address of the user whose bonds have been freed
     * @param amount The bond amount which can now be withdrawn
     */
    event FreedBond(address indexed from, uint256 amount);
    /**
     * Event to log the slashing of a bond
     * @param from The address of the user whose bonds have been slashed
     * @param to The recipient of the slashed bonds
     * @param amount The bound amount which has been forfeited
     */
    event SlashedBond(address indexed from, address indexed to, uint256 amount);
    /**
     * Event to log the withdrawal of a bond
     * @param from The address of the user who withdrew bonds
     * @param amount The bond amount which has been withdrawn
     */
    event WithdrewBonds(address indexed from, uint256 amount);

    using SafeMath for uint256;
    using Transaction for bytes;
    using ECVerify for bytes32;

    uint256 constant BOND_AMOUNT = 0.1 ether;

    /*
     * Modifiers
     */
    modifier isValidator() {
        require(vmc.checkValidator(msg.sender));
        _;
    }

    modifier isTokenApproved(address _address) {
        require(vmc.allowedTokens(_address));
        _;
    }

    modifier isBonded() {
        require(msg.value == BOND_AMOUNT);

        // Save challenger's bond
        balances[msg.sender].bonded = balances[msg.sender].bonded.add(msg.value);
        _;
    }

    modifier isState(uint64 slot, State state) {
        require(coins[slot].state == state, "Wrong state");
        _;
    }

    modifier cleanupExit(uint64 slot) {
        _;
        delete coins[slot].exit;
        delete exitSlots[getExitIndex(slot)];
    }

    struct Balance {
        uint256 bonded;
        uint256 withdrawable;
    }
    mapping (address => Balance) public balances;

    // exits
    uint64[] public exitSlots;
    // Each exit can only be challenged by a single challenger at a time
    mapping (uint64 => address) challengers;
    struct Exit {
        address prevOwner; // previous owner of coin
        address owner;
        uint256 createdAt;
        uint256 bond;
        uint256 prevBlock;
        uint256 exitBlock;
    }
    enum State {
        DEPOSITED,
        EXITING,
        CHALLENGED,
        EXITED
    }

    // Track owners of txs that are pending a response
    struct Challenge {
        address owner;
        uint256 blockNumber;
    }
    mapping (uint64 => Challenge) challenges;

    // tracking of NFTs deposited in each slot
    uint64 public numCoins = 0;
    mapping (uint64 => Coin) coins;
    struct Coin {
        uint64 uid; // there are up to 2^64 cards, one for every leaf of
                    // a depth 64 Sparse Merkle Tree
        uint32 denomination; // Currently set to 1 always, subject to change once the token changes
        uint256 depositBlock;
        address owner; // who owns that nft
        address contractAddress; // which contract does the coin belong to
        State state;
        Exit exit;
    }

    // child chain
    uint256 public childBlockInterval = 1000;
    uint256 public currentBlock = 0;
    struct ChildBlock {
        bytes32 root;
        uint256 createdAt;
    }

    mapping(uint256 => ChildBlock) public childChain;
    ValidatorManagerContract vmc;
    SparseMerkleTree smt;

    constructor (ValidatorManagerContract _vmc) public {
        vmc = _vmc;
        smt = new SparseMerkleTree();
    }


    /// @dev called by a Validator to append a Plasma block to the Plasma chain
    /// @param root The transaction root hash of the Plasma block being added
    function submitBlock(bytes32 root)
        public
        isValidator
    {
        // rounding to next whole `childBlockInterval`
        currentBlock = currentBlock.add(childBlockInterval)
            .div(childBlockInterval)
            .mul(childBlockInterval);

        childChain[currentBlock] = ChildBlock({
            root: root,
            createdAt: block.timestamp
        });

        emit SubmittedBlock(currentBlock, root, block.timestamp);
    }

    /// @dev Allows anyone to deposit funds into the Plasma chain, called when
    //       contract receives ERC721
    /// @notice Appends a deposit block to the Plasma chain
    /// @param from The address of the user who is depositing a coin
    /// @param uid The uid of the ERC721 coin being deposited. This is an
    ///            identifier allocated by the ERC721 token contract; it is not
    ///            related to `slot`.
    /// @param denomination The quantity of a particular coin being deposited
    function deposit(address from, uint64 uid, uint32 denomination)
        private
    {
        currentBlock = currentBlock.add(1);

        // Update state. Leave `exit` empty
        Coin memory coin;
        coin.uid = uid;
        coin.contractAddress = msg.sender;
        coin.denomination = denomination;
        coin.depositBlock = currentBlock;
        coin.owner = from;
        coin.state = State.DEPOSITED;
        uint64 slot = uint64(bytes8(keccak256(abi.encodePacked(numCoins, msg.sender, from))));
        coins[slot] = coin;

        childChain[currentBlock] = ChildBlock({
            // save signed transaction hash as root
            // hash for deposit transactions is the hash of its slot
            root: keccak256(abi.encodePacked(slot)),
            createdAt: block.timestamp
        });

        // create a utxo at `slot`
        emit Deposit(
            slot,
            currentBlock,
            denomination,
            from,
            msg.sender
        );

        numCoins += 1;
    }

    /******************** EXIT RELATED ********************/

    function startExit(
        uint64 slot,
        bytes prevTxBytes, bytes exitingTxBytes,
        bytes prevTxInclusionProof, bytes exitingTxInclusionProof,
        bytes signature,
        uint256[2] blocks)
        external
        payable isBonded
        isState(slot, State.DEPOSITED)
    {
        require(msg.sender == exitingTxBytes.getOwner());
        doInclusionChecks(
            prevTxBytes, exitingTxBytes,
            prevTxInclusionProof, exitingTxInclusionProof,
            signature,
            blocks
        );
        pushExit(slot, prevTxBytes.getOwner(), blocks);
    }

    /// @dev Verifies that consecutive two transaction involving the same coin
    ///      are valid
    /// @notice If exitingTxBytes corresponds to a deposit transaction,
    ///         prevTxBytes cannot have a meaningul value and thus it is ignored.
    /// @param prevTxBytes The RLP-encoded transaction involving a particular
    ///        coin which took place directly before exitingTxBytes
    /// @param exitingTxBytes The RLP-encoded transaction involving a particular
    ///        coin which an exiting owner of the coin claims to be the latest
    /// @param prevTxInclusionProof An inclusion proof of prevTx
    /// @param exitingTxInclusionProof An inclusion proof of exitingTx
    /// @param signature The signature of the exitingTxBytes by the coin
    ///        owner indicated in prevTx
    /// @param blocks An array of two block numbers, at index 0, the block
    ///        containing the prevTx and at index 1, the block containing
    ///        the exitingTx
    function doInclusionChecks(
        bytes prevTxBytes, bytes exitingTxBytes,
        bytes prevTxInclusionProof, bytes exitingTxInclusionProof,
        bytes signature,
        uint256[2] blocks)
        private
        view
    {
        if (blocks[1] % childBlockInterval != 0) {
            checkIncludedAndSigned(
                exitingTxBytes,
                exitingTxInclusionProof,
                signature,
                blocks[1]
            );
        } else {
            checkBothIncludedAndSigned(
                prevTxBytes, exitingTxBytes, prevTxInclusionProof,
                exitingTxInclusionProof, signature,
                blocks
            );
        }
    }

    // Needed to bypass stack limit errors
    function pushExit(
        uint64 slot,
        address prevOwner,
        uint256[2] blocks)
        private
    {
        // Push exit to list
        exitSlots.push(slot);

        // Create exit
        Coin storage c = coins[slot];
        c.exit = Exit({
            prevOwner: prevOwner,
            owner: msg.sender,
            createdAt: block.timestamp,
            bond: msg.value,
            prevBlock: blocks[0],
            exitBlock: blocks[1]
        });

        // Update coin state
        c.state = State.EXITING;
        emit StartedExit(slot, msg.sender);
    }

    /// @dev Finalizes an exit, i.e. puts the exiting coin into the EXITED
    ///      state which will allow it to be withdrawn, provided the exit has
    ///      matured and has not been successfully challenged
    function finalizeExit(uint64 slot) public {
        Coin storage coin = coins[slot];

        // If a coin is not under exit/challenge, then ignore it
        if (coin.state == State.DEPOSITED || coin.state == State.EXITED)
            return;

        // If an exit is not matured, ignore it
        if ((block.timestamp - coin.exit.createdAt) <= 7 days)
            return;

        // If a coin has been challenged AND not responded, slash it
        if (coin.state == State.CHALLENGED) {
            // Update coin state & penalize exitor
            coin.state = State.DEPOSITED;
            slashBond(coin.exit.owner, challengers[slot]);
        // otherwise, the exit has not been challenged, or it has been challenged and responded
        } else {
            // Update coin's owner
            coin.owner = coin.exit.owner;
            coin.state = State.EXITED;

            // Allow the exitor to withdraw their bond
            freeBond(coin.owner);

            emit FinalizedExit(slot, coin.owner);
        }
        delete coins[slot].exit;
        delete exitSlots[getExitIndex(slot)];
    }

    /// @dev Iterates through all of the initiated exits and finalizes those
    ///      which have matured without being successfully challenged
    function finalizeExits() external {
        uint256 exitSlotsLength = exitSlots.length;
        for (uint256 i = 0; i < exitSlotsLength; i++) {
            finalizeExit(exitSlots[i]);
        }
    }

    /// @dev Withdraw a UTXO that has been exited
    /// @param slot The slot of the coin being withdrawn
    function withdraw(uint64 slot) external isState(slot, State.EXITED) {
        require(coins[slot].owner == msg.sender, "You do not own that UTXO");
        ERC721(coins[slot].contractAddress).safeTransferFrom(address(this), msg.sender, uint256(coins[slot].uid));
    }

    /******************** CHALLENGES ********************/

    /// @dev Submits proof of a transaction before prevTx as an exit challenge
    /// @notice Exitor has to call respondChallengeBefore and submit a
    ///         transaction before prevTx or prevTx itself.
    /// @param slot The slot corresponding to the coin whose exit is being challenged
    /// @param prevTxBytes The RLP-encoded transaction involving a particular
    ///        coin which took place directly before exitingTxBytes
    /// @param txBytes The RLP-encoded transaction involving a particular
    ///        coin which an exiting owner of the coin claims to be the latest
    /// @param prevTxInclusionProof An inclusion proof of prevTx
    /// @param txInclusionProof An inclusion proof of exitingTx
    /// @param signature The signature of the txBytes by the coin
    ///        owner indicated in prevTx
    /// @param blocks An array of two block numbers, at index 0, the block
    ///        containing the prevTx and at index 1, the block containing
    ///        the exitingTx
    function challengeBefore(
        uint64 slot,
        bytes prevTxBytes, bytes txBytes,
        bytes prevTxInclusionProof, bytes txInclusionProof,
        bytes signature,
        uint256[2] blocks)
        external
        payable isBonded
        isState(slot, State.EXITING)
    {
        doInclusionChecks(
            prevTxBytes, txBytes,
            prevTxInclusionProof, txInclusionProof,
            signature,
            blocks
        );
        setChallenged(slot, txBytes.getOwner(), blocks[1]);
    }

    // If `challengeBefore` is successfully responded to, then set state to
    // EXITING and allow the coin to be exited. No need to attach a bond
    // when responding to a challenge.
    function respondChallengeBefore(
        uint64 slot,
        uint256 challengingBlockNumber,
        bytes challengingTransaction,
        bytes proof,
        bytes signature)
        external
        isState(slot, State.CHALLENGED)
    {
        Transaction.TX memory txData = challengingTransaction.getTx();
        require(txData.hash.ecverify(signature, challenges[slot].owner), "Invalid signature");
        require(txData.slot == slot, "Tx is referencing another slot");
        require(challengingBlockNumber > challenges[slot].blockNumber);
        checkTxIncluded(txData.slot, txData.hash, challengingBlockNumber, proof);

        // If the exit was actually challenged and responded, penalize the challenger
        slashBond(challengers[slot], coins[slot].exit.owner);

        // Put coin back to the exiting state
        coins[slot].state = State.EXITING;

        emit RespondedExitChallenge(slot);
    }

    function challengeBetween(
        uint64 slot,
        uint256 challengingBlockNumber,
        bytes challengingTransaction,
        bytes proof,
        bytes signature)
        external isState(slot, State.EXITING) cleanupExit(slot)
    {
        checkBetween(slot, challengingTransaction, challengingBlockNumber, signature, proof);
        applyPenalties(slot);
    }

    function challengeAfter(
        uint64 slot,
        uint256 challengingBlockNumber,
        bytes challengingTransaction,
        bytes proof,
        bytes signature)
        external
        isState(slot, State.EXITING)
        cleanupExit(slot)
    {
        checkAfter(slot, challengingTransaction, challengingBlockNumber, signature, proof);
        applyPenalties(slot);
    }


    // Must challenge with a tx in between

    // Check that the challenging transaction has been signed
    // by the attested previous owner of the coin in the exit
    function checkBetween(uint64 slot, bytes txBytes, uint blockNumber, bytes signature, bytes proof) private view {
        require(
            coins[slot].exit.exitBlock > blockNumber &&
            coins[slot].exit.prevBlock < blockNumber,
            "Tx should be between the exit's blocks"
        );

        Transaction.TX memory txData = txBytes.getTx();
        require(txData.hash.ecverify(signature, coins[slot].exit.prevOwner), "Invalid signature");
        require(txData.slot == slot, "Tx is referencing another slot");
        checkTxIncluded(slot, txData.hash, blockNumber, proof);
    }

    function checkAfter(uint64 slot, bytes txBytes, uint blockNumber, bytes signature, bytes proof) private view {
        Transaction.TX memory txData = txBytes.getTx();
        require(txData.hash.ecverify(signature, coins[slot].exit.owner), "Invalid signature");
        require(txData.slot == slot, "Tx is referencing another slot");
        require(txData.prevBlock == coins[slot].exit.exitBlock, "Not a direct spend");
        checkTxIncluded(slot, txData.hash, blockNumber, proof);
    }

    function applyPenalties(uint64 slot) private {
        // Apply penalties and change state
        slashBond(coins[slot].exit.owner, msg.sender);
        coins[slot].state = State.DEPOSITED;
    }

    /// @param slot The slot of the coin being challenged
    /// @param owner The user claimed to be the true ower of the coin
    function setChallenged(uint64 slot, address owner, uint256 challengingBlockNumber) private {
        // When an exit is challenged, its state is set to challenged and the
        // contract waits for the exitor's response. The exit is not
        // immediately deleted.
        coins[slot].state = State.CHALLENGED;
        // Save the challenger's address, for applying penalties
        challengers[slot] = msg.sender;

        // Need to save the exiting transaction's owner, to verify
        // that the response is valid
        challenges[slot] = Challenge({
            owner: owner, 
            blockNumber: challengingBlockNumber
        });

        emit ChallengedExit(slot);
    }

    /******************** BOND RELATED ********************/

    function freeBond(address from) private {
        balances[from].bonded = balances[from].bonded.sub(BOND_AMOUNT);
        balances[from].withdrawable = balances[from].withdrawable.add(BOND_AMOUNT);
        emit FreedBond(from, BOND_AMOUNT);
    }

    function withdrawBonds() external {
        // Can only withdraw bond if the msg.sender
        uint256 amount = balances[msg.sender].withdrawable;
        balances[msg.sender].withdrawable = 0; // no reentrancy!

        msg.sender.transfer(amount);
        emit WithdrewBonds(msg.sender, amount);
    }

    function slashBond(address from, address to) private {
        balances[from].bonded = balances[from].bonded.sub(BOND_AMOUNT);
        balances[to].withdrawable = balances[to].withdrawable.add(BOND_AMOUNT);
        emit SlashedBond(from, to, BOND_AMOUNT);
    }

    /******************** PROOF CHECKING ********************/

    function checkIncludedAndSigned(
        bytes exitingTxBytes,
        bytes exitingTxInclusionProof,
        bytes signature,
        uint256 blk)
        private
        view
    {
        Transaction.TX memory txData = exitingTxBytes.getTx();

        // Deposit transactions need to be signed by their owners
        // e.g. Alice signs a transaction to Alice
        require(txData.hash.ecverify(signature, txData.owner), "Invalid signature");
        checkTxIncluded(txData.slot, txData.hash, blk, exitingTxInclusionProof);
    }

    function checkBothIncludedAndSigned(
        bytes prevTxBytes, bytes exitingTxBytes,
        bytes prevTxInclusionProof, bytes exitingTxInclusionProof,
        bytes signature,
        uint256[2] blocks)
        private
        view
    {
        require(blocks[0] < blocks[1]);

        Transaction.TX memory exitingTxData = exitingTxBytes.getTx();
        Transaction.TX memory prevTxData = prevTxBytes.getTx();

        // Both transactions need to be referring to the same slot
        require(exitingTxData.slot == prevTxData.slot);

        // The exiting transaction must be signed by the previous transaciton's owner
        require(exitingTxData.hash.ecverify(signature, prevTxData.owner), "Invalid signature");

        // Both transactions must be included in their respective blocks
        checkTxIncluded(prevTxData.slot, prevTxData.hash, blocks[0], prevTxInclusionProof);
        checkTxIncluded(exitingTxData.slot, exitingTxData.hash, blocks[1], exitingTxInclusionProof);
    }

    function checkTxIncluded(uint64 slot, bytes32 txHash, uint256 blockNumber, bytes proof) private view {
        bytes32 root = childChain[blockNumber].root;

        if (blockNumber % childBlockInterval != 0) {
            // Check against block root for deposit block numbers
            require(txHash == root);
        } else {
            // Check against merkle tree for all other block numbers
            require(
                checkMembership(
                    txHash,
                    root,
                    slot,
                    proof
            ),
            "Tx not included in claimed block"
            );
        }
    }

    /******************** ERC721 ********************/

    function onERC721Received(address _from, uint256 _uid, bytes)
        public
        isTokenApproved(msg.sender)
        returns(bytes4)
    {
        deposit(_from, uint64(_uid), uint32(1));
        return ERC721_RECEIVED;
    }

    /******************** HELPERS ********************/

    /// @notice If the slot's exit is not found, a large number is returned to
    ///         ensure the exit array access fails
    /// @param slot The slot being exited
    /// @return The index of the slot's exit in the exitSlots array
    function getExitIndex(uint64 slot) private view returns (uint256) {
        uint256 len = exitSlots.length;
        for (uint256 i = 0; i < len; i++) {
            if (exitSlots[i] == slot)
                return i;
        }
        // a defualt value to return larger than the possible number of coins
        return 2**65;
    }

    function checkMembership(
        bytes32 txHash,
        bytes32 root,
        uint64 slot,
        bytes proof) public view returns (bool)
    {
        return smt.checkMembership(
            txHash,
            root,
            slot,
            proof);
    }

    function getPlasmaCoin(uint64 slot) external view returns(uint64, uint256, uint32, address, address, State) {
        Coin memory c = coins[slot];
        return (c.uid, c.depositBlock, c.denomination, c.owner, c.contractAddress, c.state);
    }

    function getExit(uint64 slot) external view returns(address, uint256, uint256, State) {
        Exit memory e = coins[slot].exit;
        return (e.owner, e.prevBlock, e.exitBlock, coins[slot].state);
    }

    function getBlockRoot(uint256 blockNumber) public view returns (bytes32 root) {
        root = childChain[blockNumber].root;
    }
}
