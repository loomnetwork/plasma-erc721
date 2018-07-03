pragma solidity ^0.4.24;

/**
 * @title ERC20 token receiver interface
 * @dev Interface for any contract that wants to support safeTransfers
 *  from ERC20 asset contracts.
 */

contract ERC20Receiver {
    /**
     * @dev Magic value to be returned upon successful reception of an NFT
     *  Equals to `bytes4(keccak256("onERC20Received(address,uint256)"))`,
     *  which can be also obtained as `ERC20Receiver(0).onERC20Received.selector`
     */
    bytes4 constant ERC20_RECEIVED = 0xbc04f0af;

    function onERC20Received(address _from, uint256 amount) public returns(bytes4);

}
