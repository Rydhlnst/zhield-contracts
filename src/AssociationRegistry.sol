// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAssociationRegistry} from "./interfaces.sol";

/*
  Who screens. The screening operator checks each deposit's source address
  against sanctions lists off-chain and approves the clean ones in the pool
  (ZhieldPool.approve), which adds them to the pool's on-chain approved set.
  Every pool asks this registry who the operator is, so one change here
  covers all pools.

  The owner (one team wallet at launch, a multisig later) cannot touch funds
  or approvals. It can only appoint
  the operator, and a new operator takes effect after OPERATOR_DELAY, so the
  change is public a week before it counts.
*/
contract AssociationRegistry is IAssociationRegistry {
    uint256 public constant OPERATOR_DELAY = 7 days;

    address public owner;
    address public pendingOwner;
    address public operator;
    address public nextOperator;
    uint256 public nextOperatorAt;

    event OperatorProposed(address indexed operator, uint256 activeAt);
    event OperatorChanged(address indexed operator);
    event OwnerProposed(address indexed owner);
    event OwnerChanged(address indexed owner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Registry: not owner");
        _;
    }

    constructor(address _owner, address _operator) {
        require(_owner != address(0) && _operator != address(0), "Registry: zero address");
        owner = _owner;
        operator = _operator;
        emit OwnerChanged(_owner);
        emit OperatorChanged(_operator);
    }

    function proposeOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "Registry: zero address");
        nextOperator = _operator;
        nextOperatorAt = block.timestamp + OPERATOR_DELAY;
        emit OperatorProposed(_operator, nextOperatorAt);
    }

    function activateOperator() external {
        require(nextOperator != address(0), "Registry: nothing proposed");
        require(block.timestamp >= nextOperatorAt, "Registry: timelock");
        operator = nextOperator;
        nextOperator = address(0);
        emit OperatorChanged(operator);
    }

    function transferOwnership(address _owner) external onlyOwner {
        pendingOwner = _owner;
        emit OwnerProposed(_owner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Registry: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }
}
