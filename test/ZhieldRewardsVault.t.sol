// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ZhieldRewardsVault} from "../src/ZhieldRewardsVault.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/*
  RewardsVault tests. Proofs come from scripts/holder-rewards.mjs through FFI,
  the same code the hourly bot uses. test_Fork_NVDA uses the real
  NVIDIA • Robinhood Token and only runs on a Robinhood Chain fork:
    forge test --match-contract ZhieldRewardsVaultTest --fork-url robinhood -vv
*/
contract ZhieldRewardsVaultTest is Test {
    ZhieldRewardsVault vault;
    MockToken token;

    address owner = makeAddr("owner");
    address publisher = makeAddr("publisher");
    address alice = 0x1111111111111111111111111111111111111111;
    address bob = 0x2222222222222222222222222222222222222222;
    address carol = 0x3333333333333333333333333333333333333333;
    address fresh = makeAddr("fresh");

    uint256 constant FUND = 1_000 ether;
    uint256 constant CAP = 100 ether; // per hour
    uint256 constant HOUR = 1 hours;

    // Hour 1: alice 10, bob 20, carol 70 (100, the full cap).
    string constant HOUR1 = "0x1111111111111111111111111111111111111111:10000000000000000000,0x2222222222222222222222222222222222222222:20000000000000000000,0x3333333333333333333333333333333333333333:70000000000000000000";
    // Cumulative after hour 2: alice 30, bob 40, carol 129 (99 added).
    string constant HOUR2 = "0x1111111111111111111111111111111111111111:30000000000000000000,0x2222222222222222222222222222222222222222:40000000000000000000,0x3333333333333333333333333333333333333333:129000000000000000000";

    event OwnerWithdrawal(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        vm.warp(500_000 * HOUR + 123); // mid-hour, like a real deploy
        token = new MockToken();
        vault = new ZhieldRewardsVault(owner, publisher, address(token), CAP);
        token.mint(address(vault), FUND);
    }

    function _proof(string memory list, address account) internal returns (bytes32 root, uint256 cumulative, bytes32[] memory proof) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "scripts/holder-rewards.mjs";
        cmd[2] = "proof";
        cmd[3] = list;
        cmd[4] = vm.toString(account);
        (root, cumulative, proof) = abi.decode(vm.ffi(cmd), (bytes32, uint256, bytes32[]));
    }

    function _publish(string memory list, uint256 total) internal {
        (bytes32 root, , ) = _proof(list, alice);
        vm.prank(publisher);
        vault.publishRoot(root, total, "");
    }

    /// Move into the n-th clock hour after the last root.
    function _nextHour(uint256 n) internal {
        vm.warp(vault.lastPublishHour() + n * HOUR + 5 minutes);
    }

    /* ---------- Hourly cap ---------- */

    function test_AllowanceGrowsByTheHour() public {
        assertEq(vault.allowance(), 0, "nothing in the deploy hour");
        _nextHour(1);
        assertEq(vault.allowance(), CAP);
        _nextHour(3);
        assertEq(vault.allowance(), 3 * CAP);
        _nextHour(100);
        assertEq(vault.allowance(), 24 * CAP, "catch-up stops at 24 hours");
    }

    function test_PublishCannotExceedTheCap() public {
        _nextHour(1);
        (bytes32 root, , ) = _proof(HOUR1, alice);
        vm.prank(publisher);
        vm.expectRevert("Vault: over the hourly cap");
        vault.publishRoot(root, CAP + 1, "");
    }

    function test_OneRootPerHour() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        (bytes32 root, , ) = _proof(HOUR2, alice);
        vm.prank(publisher);
        vm.expectRevert("Vault: already published this hour");
        vault.publishRoot(root, 100 ether, "");
    }

    function test_UnusedCapDoesNotPileUp() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        _nextHour(1);
        _publish(HOUR1, 100 ether); // a quiet hour: nothing added
        _nextHour(1);
        // The quiet hour's unused cap is gone: only one hour's worth is allowed.
        (bytes32 root, , ) = _proof(HOUR2, alice);
        vm.prank(publisher);
        vm.expectRevert("Vault: over the hourly cap");
        vault.publishRoot(root, 100 ether + CAP + 1, "");
    }

    function test_PublishTotalCannotGoDown() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        _nextHour(1);
        (bytes32 root, , ) = _proof(HOUR1, alice);
        vm.prank(publisher);
        vm.expectRevert("Vault: total went down");
        vault.publishRoot(root, 99 ether, "");
    }

    function test_OnlyPublisherPublishes() public {
        _nextHour(1);
        vm.prank(owner);
        vm.expectRevert("Vault: not publisher");
        vault.publishRoot(bytes32(uint256(1)), 1, "");
    }

    /* ---------- Holders ---------- */

    function test_HoldersClaimTheirShare() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        address[3] memory who = [alice, bob, carol];
        uint256[3] memory want = [uint256(10 ether), 20 ether, 70 ether];
        for (uint256 i = 0; i < 3; i++) {
            (, uint256 cumulative, bytes32[] memory proof) = _proof(HOUR1, who[i]);
            vm.prank(who[i]); // each holder claims for itself
            vault.claim(cumulative, proof);
            assertEq(token.balanceOf(who[i]), want[i]);
        }
        assertEq(vault.totalClaimed(), 100 ether);
        assertEq(vault.owed(), 0);
        assertEq(token.balanceOf(address(vault)), FUND - 100 ether);
    }

    function test_CumulativeClaimPaysOnlyTheNewPart() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        (, uint256 c1, bytes32[] memory p1) = _proof(HOUR1, alice);
        vm.prank(alice);
        vault.claim(c1, p1);

        _nextHour(1);
        _publish(HOUR2, 199 ether);
        (, uint256 c2, bytes32[] memory p2) = _proof(HOUR2, alice);
        vm.prank(alice);
        vault.claim(c2, p2);
        assertEq(token.balanceOf(alice), 30 ether, "10 + 20 more");

        vm.prank(alice);
        vm.expectRevert("Vault: nothing to claim");
        vault.claim(c2, p2);
    }

    function test_PreviousRootStillWorks() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        _nextHour(1);
        _publish(HOUR2, 199 ether);

        // A proof built just before the new root landed.
        (, uint256 c1, bytes32[] memory p1) = _proof(HOUR1, bob);
        vm.prank(bob);
        vault.claim(c1, p1);
        assertEq(token.balanceOf(bob), 20 ether);

        // A third root retires the first one.
        _nextHour(1);
        _publish(HOUR2, 199 ether);
        (, uint256 c1c, bytes32[] memory p1c) = _proof(HOUR1, carol);
        vm.prank(carol);
        vm.expectRevert("Vault: invalid proof");
        vault.claim(c1c, p1c);
    }

    function test_CannotClaimMoreThanEntitled() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        (, uint256 cumulative, bytes32[] memory proof) = _proof(HOUR1, alice);
        vm.prank(alice);
        vm.expectRevert("Vault: invalid proof");
        vault.claim(cumulative + 1, proof);
    }

    function test_NobodyElseCanClaimForAHolder() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        (, uint256 cumulative, bytes32[] memory proof) = _proof(HOUR1, alice);
        // Not the publisher, not the owner: the proof only works from alice's own wallet.
        address[2] memory others = [publisher, owner];
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(others[i]);
            vm.expectRevert("Vault: invalid proof");
            vault.claim(cumulative, proof);
        }
        assertEq(token.balanceOf(alice), 0);
        assertEq(vault.claimed(alice), 0);
    }

    function test_ClaimToFreshAddress() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        (, uint256 cumulative, bytes32[] memory proof) = _proof(HOUR1, bob);
        vm.prank(bob);
        vault.claimTo(fresh, cumulative, proof);
        assertEq(token.balanceOf(fresh), 20 ether);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_CannotClaimSomeoneElsesShareToYourself() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        (, uint256 cumulative, bytes32[] memory proof) = _proof(HOUR1, carol);
        address thief = makeAddr("thief");
        vm.prank(thief);
        vm.expectRevert("Vault: invalid proof"); // claimTo uses msg.sender as the account
        vault.claimTo(thief, cumulative, proof);
    }

    /* ---------- Owner ---------- */

    function test_OwnerWithdrawsEverything() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        vm.deal(address(vault), 2 ether); // shield fees
        address treasury = makeAddr("treasury");

        vm.expectEmit(true, true, false, true);
        emit OwnerWithdrawal(address(token), treasury, FUND);
        vm.prank(owner);
        vault.withdrawAll(address(token), treasury);
        vm.prank(owner);
        vault.withdrawAll(address(0), treasury);

        assertEq(token.balanceOf(treasury), FUND, "published and unclaimed included");
        assertEq(treasury.balance, 2 ether);
        assertEq(vault.balanceOf(address(token)), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_OwnerWithdrawsPart() public {
        vm.prank(owner);
        vault.withdraw(address(token), owner, 4 ether);
        assertEq(token.balanceOf(owner), 4 ether);
        assertEq(vault.balanceOf(address(token)), FUND - 4 ether);
    }

    function test_ClaimsFailAfterOwnerDrains() public {
        _nextHour(1);
        _publish(HOUR1, 100 ether);
        vm.prank(owner);
        vault.withdrawAll(address(token), owner);
        (, uint256 cumulative, bytes32[] memory proof) = _proof(HOUR1, alice);
        vm.prank(alice);
        vm.expectRevert("Vault: token transfer failed");
        vault.claim(cumulative, proof);
    }

    function test_OwnerSetsTheCap() public {
        vm.prank(owner);
        vault.setHourlyCap(0); // pauses rewards
        _nextHour(1);
        assertEq(vault.allowance(), 0);
        vm.prank(owner);
        vault.setHourlyCap(5 ether);
        assertEq(vault.allowance(), 5 ether);
    }

    function test_OnlyOwner() public {
        vm.expectRevert("Vault: not owner");
        vault.withdrawAll(address(token), address(this));
        vm.expectRevert("Vault: not owner");
        vault.setHourlyCap(1);
        vm.expectRevert("Vault: not owner");
        vault.setPublisher(address(this));
    }

    function test_OwnerChangesPublisher() public {
        address bot = makeAddr("bot");
        vm.prank(owner);
        vault.setPublisher(bot);
        _nextHour(1);
        (bytes32 root, , ) = _proof(HOUR1, alice);
        vm.prank(publisher);
        vm.expectRevert("Vault: not publisher");
        vault.publishRoot(root, 100 ether, "");
        vm.prank(bot);
        vault.publishRoot(root, 100 ether, "");
        assertEq(vault.root(), root);
    }

    function test_TwoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.owner(), owner);
        vm.prank(next);
        vault.acceptOwnership();
        assertEq(vault.owner(), next);
    }

    /* ---------- Real NVDA on a Robinhood Chain fork ---------- */

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_HOLDER = 0xBc6426CdBCE142dfbff33303dc0923509f61eedc;

    function test_Fork_NVDA() public {
        if (block.chainid != 4663 || NVDA.code.length == 0) {
            vm.skip(true);
            return;
        }
        ZhieldRewardsVault v = new ZhieldRewardsVault(owner, publisher, NVDA, 0.05 ether);
        // A real holder funds the vault with 6 NVDA.
        vm.prank(NVDA_HOLDER);
        assertTrue(IERC20(NVDA).transfer(address(v), 6 ether));

        // One hour later the bot posts two eligible holders, $0.01 each at $213.55.
        uint256 each = uint256(0.01e18) * 1e18 / 213.55e18; // 0.0000468 NVDA
        string memory list = string.concat(
            "0x1111111111111111111111111111111111111111:", vm.toString(each), ",0x2222222222222222222222222222222222222222:", vm.toString(each)
        );
        vm.warp(v.lastPublishHour() + HOUR);
        (bytes32 root, , ) = _proof(list, alice);
        vm.prank(publisher);
        v.publishRoot(root, 2 * each, "");

        (, uint256 a, bytes32[] memory pa) = _proof(list, alice);
        uint256 aliceBefore = IERC20(NVDA).balanceOf(alice);
        vm.prank(alice);
        v.claim(a, pa);
        assertEq(IERC20(NVDA).balanceOf(alice) - aliceBefore, each, "alice got $0.01 of NVDA");

        (, uint256 b, bytes32[] memory pb) = _proof(list, bob);
        vm.prank(bob);
        v.claimTo(fresh, b, pb);
        assertEq(IERC20(NVDA).balanceOf(fresh), each, "bob's share went to a fresh address");

        // The owner takes back everything left.
        vm.prank(owner);
        v.withdrawAll(NVDA, owner);
        assertEq(IERC20(NVDA).balanceOf(owner), 6 ether - 2 * each);
        assertEq(IERC20(NVDA).balanceOf(address(v)), 0);
    }
}
