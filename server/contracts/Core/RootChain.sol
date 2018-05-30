pragma solidity ^0.4.24;

// Linked contract for withdrawals, import only safeTransferFrom interface for gas efficiency in the future
import './Cards.sol';

// Zeppelin Imports
import 'openzeppelin-solidity/contracts/token/ERC721/ERC721Receiver.sol';
import 'openzeppelin-solidity/contracts/math/SafeMath.sol';

// Lib deps
import '../Libraries/Transaction/Transaction.sol';
import '../Libraries/ByteUtils.sol';
import '../Libraries/ECVerify.sol';

// Sparse Merkle Tree functionalities
import './SparseMerkleTree.sol';

contract RootChainEvents{
    event Deposit(uint64 indexed slot, uint256 depositBlockNumber, uint64 denomination, address indexed from);
    event SubmittedBlock(uint blockNumber, bytes32 root, uint timestamp);

    event StartedExit(uint64 indexed slot, address indexed owner, uint created_at);
    event ChallengedExit(uint64 indexed slot);
    event RespondedExitChallenge(uint64 indexed slot);
    event FinalizedExit(uint64  indexed slot, address owner);

    event FreedBond(address indexed from, uint amount);
    event SlashedBond(address indexed from, address indexed to, uint amount);
    event WithdrawedBonds(address indexed from, uint amount);
}

contract RootChain is ERC721Receiver, SparseMerkleTree, RootChainEvents {
    
    using SafeMath for uint256;
    using Transaction for bytes;
    using ECVerify for bytes32;

    uint constant BOND_AMOUNT = 0.1 ether;

    address public authority;

    /*
     * Modifiers
     */
    modifier isAuthority() {
        require(msg.sender == authority);
        _;
    }


    modifier isBonded() { 
        require ( msg.value == BOND_AMOUNT ); 

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
        delete exitSlots[getIndex(slot)];
    }

    struct Balance {
        uint bonded;
        uint withdrawable;
    }
    mapping (address => Balance ) public balances;

    // exits
    uint64[] public exitSlots;
    // Each exit can be challenged once ? Need to confirm if needed for more.
    mapping (uint64 => address) challengers;
    struct Exit {
        address owner;
        uint256 created_at;
        uint256 bond;
        uint256 prevBlock;
        uint256 exitBlock;
    }
    enum State {

        DEPOSITED,
        EXITING,
        CHALLENGED,
        RESPONDED,
        EXITED
    }

    // tracking of NFTs deposited in each slot
    uint64 public NUM_COINS;
    mapping (uint64 => Coin) public coins; 
    struct Coin {
        uint64 uid; // there are up to 2^256 cards, can probably make it less
        uint32 denomination; // an owner cannot own more than 256 of a card. Currently set to 1 always, subject to change once the token changes
        address owner; // who owns that nft
        State state;
        Exit exit;
    }

    // child chain
    uint256 public childBlockInterval;
    uint256 public currentChildBlock;
    uint256 public currentDepositBlock;
    uint256 public lastParentBlock;
    struct childBlock {
        bytes32 root;
        uint256 created_at;
    }

    uint public depositCount;
    mapping(uint => childBlock) public childChain;
    CryptoCards cryptoCards;

    constructor () public{
        authority = msg.sender;
        childBlockInterval = 1000;
        currentChildBlock = childBlockInterval;
        currentDepositBlock = 1;
        lastParentBlock = block.number; // to ensure no chain reorgs

    }

    /// @param root 32 byte merkleRoot of ChildChain block
    /// @notice childChain blocks can only be submitted at most every 6 root chain blocks
    function submitBlock(bytes32 root)
        public
        isAuthority
    {
        // ensure finality on previous blocks before submitting another
        // require(block.number >= lastParentBlock.add(6)); // commented out while prototyping

        childChain[currentChildBlock] = childBlock({
            root: root,
            created_at: block.timestamp
        });

        emit SubmittedBlock(currentChildBlock, root, block.timestamp);

        currentChildBlock = currentChildBlock.add(childBlockInterval);
        currentDepositBlock = 1;
        lastParentBlock = block.number;

	}


    /// @dev Allows anyone to deposit funds into the Plasma chain, called when contract receives ERC721
    function deposit(address from, uint64 uid, uint32 denomination, bytes txBytes)
        private
    {
        Transaction.TX memory txData = txBytes.getTx();
        // Verify that the transaction data sent matches the coin data from ERC721
        require(txData.slot == NUM_COINS);
        require(txData.denomination == denomination);
        require(txData.owner == from);
        require(txData.prevBlock == 0);

        // Update state. Leave `exit` empty
        Coin memory coin;
        coin.uid = uid;
        coin.denomination = denomination;
        coin.owner = from;
        coin.state = State.DEPOSITED;
        coins[NUM_COINS] = coin;

        bytes32 txHash = keccak256(txBytes);
        uint256 depositBlockNumber = getDepositBlock();

        childChain[depositBlockNumber] = childBlock({
            root: txHash, // save signed transaction hash as root
            created_at: block.timestamp
        });

        currentDepositBlock = currentDepositBlock.add(1);
        emit Deposit(NUM_COINS, depositBlockNumber, denomination, from); // create a utxo at slot `NUM_COINS`

        NUM_COINS += 1;
    }

    /******************** EXIT RELATED ********************/

    function startExit(
        uint64 slot,
        bytes prevTxBytes, bytes exitingTxBytes, 
        bytes prevTxInclusionProof, bytes exitingTxInclusionProof, 
        bytes sigs,
        uint prevTxIncBlock, uint exitingTxIncBlock) 
        payable isBonded
        external
    {
        // If we're exiting a deposit UTXO, we do a different inclusion check
        if (exitingTxIncBlock % childBlockInterval != 0 ) { 
           require(
                checkDepositBlockInclusion(
                    exitingTxBytes, 
                    sigs, // for deposit blocks this is just a single sig
                    exitingTxIncBlock, 
                    true
                ),
                "Not included in deposit block"
            );
        } else {
            require(
                checkBlockInclusion(
                    prevTxBytes, exitingTxBytes,
                    prevTxInclusionProof, exitingTxInclusionProof,
                    sigs,
                    prevTxIncBlock, exitingTxIncBlock,
                    true
                ), 
                "Not included in blocks"
            );
        }

        exitSlots.push(slot);

        // Create exit
        Coin storage c = coins[slot];
        c.exit = Exit({
            owner: msg.sender, 
            created_at: block.timestamp,
            bond: msg.value,
            prevBlock: prevTxIncBlock,
            exitBlock: exitingTxIncBlock

        });

        // Update coin state
        c.state = State.EXITING;

        emit StartedExit(slot, msg.sender, block.timestamp);
    }

    function finalizeExit(uint64 slot) public cleanupExit(slot) {
        Coin storage coin = coins[slot];

        // If a coin is not under exit/challenge, then ignore it
        if (coin.state == State.DEPOSITED || coin.state == State.EXITED) return; 

        // If an exit is not matured, ignore it
        if ((block.timestamp - coin.exit.created_at) <= 7 days) return;

        // If a coin has been challenged AND not responded, slash it
        if (coin.state == State.CHALLENGED) {
            // Update coin state & penalize exitor
            coin.state = State.DEPOSITED;
            slashBond(coin.exit.owner, challengers[slot]);
        }
        // otherwise, the exit has not been challenged, or it has been challenged and responded
        else {
            // If the exit was actually challenged and responded, penalize the challenger
            if (coin.state == State.RESPONDED) {
                slashBond(challengers[slot], coin.exit.owner);
            }

            // Update coin's owner
            coin.owner = coin.exit.owner;
            coin.state = State.EXITED;

            // Allow the exitor to withdraw their bond
            freeBond(coin.owner);

            emit FinalizedExit(slot, coin.owner);
        }
    }

    function finalizeExits() external {
        uint exitSlotsLength = exitSlots.length;
        for (uint i = 0; i < exitSlotsLength; i++) { 
            finalizeExit(exitSlots[i]);
        }
    }

    // Withdraw a UTXO that has been exited
    function withdraw(uint64 slot) external isState(slot, State.EXITED) {
        require(coins[slot].owner == msg.sender, "You do not own that UTXO");
        cryptoCards.safeTransferFrom(address(this), msg.sender, uint256(coins[slot].uid));
    }

    /******************** CHALLENGES ********************/

    // Submit proof of a transaction before prevTx 
    // Exitor has to call respondChallengeBefore and submit a transaction before prevTx or prevTx itself.
    function challengeBefore(
        uint64 slot,
        bytes prevTxBytes, bytes exitingTxBytes, 
        bytes prevTxInclusionProof, bytes exitingTxInclusionProof, 
        bytes sigs,
        uint prevTxIncBlock, uint exitingTxIncBlock) 
        external 
        payable isBonded
        isState(slot, State.EXITING) 
    {
        require( 
                coins[slot].exit.prevBlock > exitingTxIncBlock,
                "Challenging transaction must have happened BEFORE the attested exit's timestamp"
       );
        // If we're exiting a deposit UTXO, we do a different inclusion check
        if (exitingTxIncBlock % childBlockInterval != 0 ) { 
           require(
                checkDepositBlockInclusion(
                    exitingTxBytes, 
                    sigs, // for deposit blocks this is just a single sig
                    exitingTxIncBlock,
                    false
                ),
                "Not included in deposit block"
            );
        } else {
            require(
                checkBlockInclusion(
                    prevTxBytes, exitingTxBytes,
                    prevTxInclusionProof, exitingTxInclusionProof,
                    sigs,
                    prevTxIncBlock, exitingTxIncBlock,
                    false
                ), 
                "Not included in blocks"
            );
        }

        setChallenged(slot);
    }

    function setChallenged(uint64 slot) private {
        // Do not delete exit yet. Set its state as challenged and wait for the exitor's response
        coins[slot].state = State.CHALLENGED;
        // Save the challenger's address, for applying penalties
        challengers[slot] = msg.sender; 
        emit ChallengedExit(slot);
    }

    // If `challengeBefore` was successfully challenged, then set state to RESPONDED and allow the coin to be exited. No need to actually attach a bond when responding to a challenge
    function respondChallengeBefore(uint64 slot, uint challengingBlockNumber, bytes challengingTransaction, bytes proof) 
        external 
        isState(slot, State.CHALLENGED)
    {
        challengingTransaction;
        proof;

        // Mark exit as responded, which will allow it to be finalized once it has matured
        coins[slot].state = State.RESPONDED;
        emit RespondedExitChallenge(slot);
    }


    function challengeBetween(uint64 slot, uint challengingBlockNumber, bytes challengingTransaction, bytes proof) 
        external 
        payable isBonded
        isState(slot, State.EXITING) 
        cleanupExit(slot)
    {
        // Must challenge with a tx in between
        require( 
                coins[slot].exit.exitBlock > challengingBlockNumber && 
                coins[slot].exit.prevBlock < challengingBlockNumber,
                "Challenging transaction must have happened AFTER the attested exit's timestamp"
       );

        bytes32 txHash = keccak256(challengingTransaction); 
        bytes32 root = childChain[challengingBlockNumber].root;
        require(
            checkMembership(
                txHash,
                root, 
                slot, 
                proof
            ),
            "Exiting tx not included in claimed block"
        );

        // Apply penalties and change state
        slashBond(coins[slot].exit.owner, msg.sender);
        freeBond(msg.sender);
        coins[slot].state = State.DEPOSITED;
    }

    function challengeAfter(uint64 slot, uint challengingBlockNumber, bytes challengingTransaction, bytes proof) 
        external 
        payable isBonded
        isState(slot, State.EXITING) 
        cleanupExit(slot)
    {
        // Must challenge with a later transaction
        require(challengingBlockNumber > coins[slot].exit.exitBlock);
        bytes32 txHash = keccak256(challengingTransaction); 
        bytes32 root = childChain[challengingBlockNumber].root;
        require(
            checkMembership(
                txHash,
                root, 
                slot, 
                proof
            ),
            "Exiting tx not included in claimed block"
        );
        // Apply penalties and delete the exit
        slashBond(coins[slot].exit.owner, msg.sender);
        freeBond(msg.sender);
        // Reset coin state
        coins[slot].state = State.DEPOSITED;
    }

    /******************** BOND RELATED ********************/

    function slashBond(address from, address to) private {
        balances[from].bonded = balances[from].bonded.sub(BOND_AMOUNT);
        balances[to].withdrawable = balances[to].withdrawable.add(BOND_AMOUNT);
        emit SlashedBond(from, to, BOND_AMOUNT);
    }

    function freeBond(address from) private {
        balances[from].bonded = balances[from].bonded.sub(BOND_AMOUNT);
        balances[from].withdrawable = balances[from].withdrawable.add(BOND_AMOUNT);
        emit FreedBond(from, BOND_AMOUNT);
    }

    function withdrawBonds() external {
        // Can only withdraw bond if the msg.sender 
        uint amount = balances[msg.sender].withdrawable;
        balances[msg.sender].withdrawable = 0; // no reentrancy!

        msg.sender.transfer(amount);
        emit WithdrawedBonds(msg.sender, amount);
    }

    /******************** PROOF CHECKING ********************/

    function checkDepositBlockInclusion(
        bytes txBytes,
        bytes signature,
        uint txIncBlock,
        bool checkSender
    )
         private 
         view 
         returns (bool) 
    {
        Transaction.TX memory txData = txBytes.getTx();
        if (checkSender) require(txData.owner == msg.sender, "Invalid sender");

        bytes32 txHash = keccak256(txBytes); 
        require(txHash.ecverify(signature, txData.owner), "Invalid sig");
        require(
            txHash == childChain[txIncBlock].root, 
            "Deposit Tx not included in block"
        );

        return true;
    }

    function checkBlockInclusion(
            bytes prevTxBytes, bytes exitingTxBytes,
            bytes prevTxInclusionProof, bytes exitingTxInclusionProof,
            bytes sigs,
            uint prevTxIncBlock, uint exitingTxIncBlock, bool checkSender) 
            private
            view
            returns (bool)
    {
        Transaction.TX memory exitingTxData = exitingTxBytes.getTx();
        if (checkSender) require(exitingTxData.owner == msg.sender, "Invalid sender");

        Transaction.TX memory prevTxData = prevTxBytes.getTx();
        require(keccak256(exitingTxBytes).ecverify(getSig(sigs, 1), prevTxData.owner), "Invalid sig");

        checkTxIncluded(exitingTxBytes, exitingTxIncBlock, exitingTxInclusionProof);
        checkTxIncluded(prevTxBytes, prevTxIncBlock, prevTxInclusionProof);

        return true;
    }

    function checkTxIncluded(bytes txBytes, uint blockNumber, bytes proof) {
        Transaction.TX memory txData = txBytes.getTx();
        bytes32 txHash = keccak256(txBytes);
        bytes32 root = childChain[blockNumber].root;

        // If deposit block, just check the matching hash to the block's root. Simpler verification due to deposit mechanism
        if (blockNumber % childBlockInterval != 0) {
            require(txHash == root);
        } else {
            require(
                checkMembership(
                    txHash,
                    root, 
                    txData.slot,
                    proof
                ),
                "Tx not included in claimed block"
            );
        }
    }


    /******************** ERC721 ********************/

    function onERC721Received(address _from, uint256 _uid, bytes _data) 
        public 
        returns(bytes4) 
    {
        require(msg.sender == address(cryptoCards)); // can only be called by the associated cryptocards contract. 
        deposit(_from, uint64(_uid), uint32(1), _data);
        return ERC721_RECEIVED;
    }
    
    /******************** HELPERS ********************/

    function setCryptoCards(CryptoCards _cryptoCards) isAuthority public {
        cryptoCards = _cryptoCards;
    }

    function getIndex(uint64 slot) private view returns (uint) {
        uint len = exitSlots.length;
        for (uint i = 0; i < len; i++)
            if (exitSlots[i] == slot) return i;
        return 0;
    }

    function getDepositBlock() private view returns (uint256) {
        return currentChildBlock.sub(childBlockInterval).add(currentDepositBlock);
    }

    function getSig(bytes sigs, uint i) private pure returns(bytes) {
        return ByteUtils.slice(sigs, 66 * i,  66);
    }

}

