pragma solidity ^0.4.24;

/**
 * @title ERC20 token receiver interface
 * @dev Interface for any contract that wants to support safeTransfers
 *  from ERC20 contracts.
 */

contract ERC20Receiver {
    /**
     * @dev Magic value to be returned upon successful reception of an amount of ERC20 tokens
     *  Equals to `bytes4(keccak256("onERC20Received(address,uint256,bytes)"))`,
     *  which can be also obtained as `ERC20Receiver(0).onERC20Received.selector`
     */
    bytes4 constant ERC20_RECEIVED = 0x65d83056;

    function onERC20Received(address _from, uint256 amount, bytes data) public returns(bytes4);

}
