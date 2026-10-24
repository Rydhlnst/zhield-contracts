// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/*
  Owner of the RewardsVault. Every owner action on the vault (a withdrawal, a new
  publisher, a new hourly cap, a new owner) is scheduled here first, in public,
  and can only run after the delay: two days once script/Timelock.s.sol is done.
  Holders see it coming and can claim everything they earned before it runs.

  OpenZeppelin's TimelockController, unchanged. Proposers schedule and cancel;
  anyone may execute a call whose delay has passed; nobody holds the admin role,
  so roles and the delay can only change through the timelock itself.
*/
contract ZhieldTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
