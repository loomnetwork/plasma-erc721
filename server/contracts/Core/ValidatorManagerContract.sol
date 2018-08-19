pragma solidity ^0.4.24;

import "openzeppelin-solidity/contracts/ownership/Ownable.sol";


contract ValidatorManagerContract is Ownable {

    mapping (address => bool) public validators;
    mapping (address => bool) public allowedTokens;

    /// @param The address to check if the owner is calling it
    function checkValidator(address _address) public view returns (bool) {
        // owner is a permanent validator
        if (_address == owner)
            return true;
        return validators[_address];
    }

    function toggleValidator(address _address) public onlyOwner {
        validators[_address] = !validators[_address];
    }

    function toggleToken(address _token) public {
        require(checkValidator(msg.sender), "not a validator");
        allowedTokens[_token] = !allowedTokens[_token];
    }

}
