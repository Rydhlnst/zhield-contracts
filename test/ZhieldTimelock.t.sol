// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZhieldRewardsVault} from "../src/ZhieldRewardsVault.sol";
import {ZhieldTimelock} from "../src/ZhieldTimelock.sol";
import {MockToken} from "./ZhieldRewardsVault.t.sol";

/*
  The RewardsVault behind ZhieldTimelock, set up exactly as script/Timelock.s.sol
  does it: the old owner loses every direct power, a withdrawal waits two days
  in public and can be cancelled, holders claim meanwhile, the publisher keeps
  posting roots, and nobody can shorten the delay or grant roles outside it.
*/
contract ZhieldTimelockTest is Test {
    ZhieldRewardsVault vault;
    ZhieldTimelock tl;
    MockToken token;

    address owner = makeAddr("owner");
    address publisher = makeAddr("publisher");
    address stranger = makeAddr("stranger");
    uint256 constant DELAY = 2 days;
    uint256 constant FUND = 1_000 ether;

    function setUp() public {
        vm.warp(500_000 hours + 123);
        token = new MockToken();
        vault = new ZhieldRewardsVault(owner, publisher, address(token), 100 ether);
        token.mint(address(vault), FUND);

        // The same steps as script/Timelock.s.sol, signed by the owner.
        vm.startPrank(owner);
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        tl = new ZhieldTimelock(0, proposers, executors, owner);
        vault.transferOwnership(address(tl));
        bytes memory accept = abi.encodeCall(ZhieldRewardsVault.acceptOwnership, ());
        tl.schedule(address(vault), 0, accept, bytes32(0), keccak256("zhield.accept"), 0);
        tl.execute(address(vault), 0, accept, bytes32(0), keccak256("zhield.accept"));
        bytes memory setDelay = abi.encodeCall(tl.updateDelay, (DELAY));
        tl.schedule(address(tl), 0, setDelay, bytes32(0), keccak256("zhield.delay"), 0);
        tl.execute(address(tl), 0, setDelay, bytes32(0), keccak256("zhield.delay"));
        tl.renounceRole(tl.DEFAULT_ADMIN_ROLE(), owner);
        vm.stopPrank();
    }

    function _withdrawAll() internal view returns (bytes memory) {
        return abi.encodeCall(ZhieldRewardsVault.withdrawAll, (address(token), owner));
    }

    function test_SetupHandsTheVaultToTheTimelock() public view {
        assertEq(vault.owner(), address(tl));
        assertEq(vault.pendingOwner(), address(0));
        assertEq(tl.getMinDelay(), DELAY);
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), owner));
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), owner));
    }

    function test_OldOwnerCannotActDirectly() public {
        vm.startPrank(owner);
        vm.expectRevert("Vault: not owner");
        vault.withdrawAll(address(token), owner);
        vm.expectRevert("Vault: not owner");
        vault.setHourlyCap(0);
        vm.expectRevert("Vault: not owner");
        vault.setPublisher(owner);
        vm.stopPrank();
    }

    function test_WithdrawalWaitsSevenDaysThenWorks() public {
        vm.prank(owner);
        vm.expectRevert(); // shorter than the minimum delay
        tl.schedule(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"), DELAY - 1);

        vm.prank(owner);
        tl.schedule(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"), DELAY);

        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(); // not ready yet
        tl.execute(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"));

        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // anyone may execute once it is ready
        tl.execute(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"));
        assertEq(token.balanceOf(owner), FUND);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_ProposerCanCancelAQueuedWithdrawal() public {
        vm.prank(owner);
        tl.schedule(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"), DELAY);
        bytes32 id = tl.hashOperation(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"));
        vm.prank(owner);
        tl.cancel(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        tl.execute(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"));
        assertEq(token.balanceOf(address(vault)), FUND);
    }

    function test_StrangersCannotScheduleOrChangeRoles() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        tl.schedule(address(vault), 0, _withdrawAll(), bytes32(0), bytes32("w"), DELAY);
        bytes32 proposer = tl.PROPOSER_ROLE();
        vm.expectRevert();
        tl.grantRole(proposer, stranger);
        vm.expectRevert();
        tl.updateDelay(0);
        vm.stopPrank();

        // Even the proposer can't skip the delay or grant roles directly.
        vm.startPrank(owner);
        vm.expectRevert();
        tl.updateDelay(0);
        vm.expectRevert();
        tl.grantRole(proposer, stranger);
        vm.stopPrank();
    }

    function test_PublisherKeepsPostingRoots() public {
        vm.warp((block.timestamp / 1 hours + 1) * 1 hours + 5 minutes);
        vm.prank(publisher);
        vault.publishRoot(keccak256("root"), 1 ether, "");
        assertEq(vault.root(), keccak256("root"));
    }
}
