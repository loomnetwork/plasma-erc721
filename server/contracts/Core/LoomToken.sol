pragma solidity ^0.4.24;

import "./ExtendedERC20.sol";

contract LoomToken is ExtendedERC20 {
    string public name    = "LoomToken";
    string public symbol  = "LOOM";
    uint8 public decimals = 18;
    address plasma;

    // one billion in initial supply
    uint256 public constant INITIAL_SUPPLY = 1000000000;

    constructor(address _plasma) public {
        totalSupply_ = INITIAL_SUPPLY * (10 ** uint256(decimals));
        balances[msg.sender] = totalSupply_;
        plasma = _plasma;
    }

    // Additional functions for plasma interaction, influenced from Zeppelin ERC721 Impl.

    function depositToPlasma(uint256 amount) external {
        safeTransferAndCall(plasma, amount);
    }
}
