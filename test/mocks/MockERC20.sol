// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ERC20 standing in for $ZHIELD in local and fork runs of the rewards bot.
contract MockERC20 {
    string public name = "Zhield";
    string public symbol = "ZHIELD";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
