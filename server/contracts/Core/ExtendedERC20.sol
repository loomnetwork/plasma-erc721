pragma solidity ^0.4.24;

import "openzeppelin-solidity/contracts/token/ERC20/StandardToken.sol";
import "openzeppelin-solidity/contracts/AddressUtils.sol";
import "./ERC20Receiver.sol";

// Extension on the StandardToken to also make a call
// on the receiving contract, ERC721 style.

contract ExtendedERC20 is StandardToken {

    bytes4 constant ERC20_RECEIVED = 0xbc04f0af;
    using AddressUtils for address;

    function safeTransferAndCall(address _to, uint256 amount) public {
        transfer(_to, amount);
        require(
            checkAndCallSafeTransfer(msg.sender, _to, amount),
           "Sent to a contract which is not an ERC20 receiver"
        );
    }

    function checkAndCallSafeTransfer(address _from, address _to, uint256 amount) internal returns (bool) {
        if (!_to.isContract()) {
            return true;
        }
        bytes4 retval = ERC20Receiver(_to).onERC20Received(_from, amount);
        return(retval == ERC20_RECEIVED);
    }

}
