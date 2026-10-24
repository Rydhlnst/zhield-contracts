// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {AssociationRegistry} from "../src/AssociationRegistry.sol";
import {ZhieldPool} from "../src/ZhieldPool.sol";
import {ZhieldRewardsVault} from "../src/ZhieldRewardsVault.sol";
import {IAssociationRegistry, IPoseidon1, IPoseidon2, IWithdrawVerifier} from "../src/interfaces.sol";

/*
  End-to-end tests with real Groth16 proofs (snarkjs through FFI).
  Run on a local chain:          forge test -vv
  Run on a Robinhood Chain fork: forge test -vv --fork-url robinhood
*/
contract ZhieldPoolTest is Test {
    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256 assocRoot;
        uint256 nullifierHash;
    }

    IPoseidon2 hasher;
    IPoseidon1 hasher1;
    Groth16Verifier verifier;
    AssociationRegistry registry;
    ZhieldPool pool;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address payable vault = payable(makeAddr("vault"));
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address payable fresh = payable(makeAddr("fresh"));
    address payable relayer = payable(makeAddr("relayer"));

    uint256 constant ONE = 1 ether;
    uint256[] leaves; // deposit tree, in order
    uint256[] approvedList; // approved tree, in order

    function setUp() public {
        hasher = IPoseidon2(_deployHex("build/PoseidonT3.hex"));
        hasher1 = IPoseidon1(_deployHex("build/PoseidonT2.hex"));
        verifier = new Groth16Verifier();
        registry = new AssociationRegistry(owner, operator);
        pool = new ZhieldPool(IWithdrawVerifier(address(verifier)), hasher, hasher1, IAssociationRegistry(address(registry)), ONE, vault, owner);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
    }

    /* ---------- Helpers ---------- */

    function _deployHex(string memory path) internal returns (address addr) {
        bytes memory code = vm.parseBytes(vm.readFile(path));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "deploy failed");
    }

    function _note(string memory seed) internal pure returns (uint256 nullifier, uint256 secret) {
        nullifier = uint256(keccak256(abi.encode(seed, "nullifier"))) >> 8;
        secret = uint256(keccak256(abi.encode(seed, "secret"))) >> 8;
    }

    function _deposit(address from, string memory seed) internal returns (uint256 nullifier, uint256 secret, uint256 commitment) {
        (nullifier, secret) = _note(seed);
        commitment = hasher.poseidon([nullifier, secret]);
        vm.prank(from);
        pool.deposit{value: ONE}(commitment);
        leaves.push(commitment);
    }

    /// The operator approves these commitments, in this order.
    function _approve(uint256[] memory cs) internal {
        vm.prank(operator);
        pool.approve(cs);
        for (uint256 i = 0; i < cs.length; i++) approvedList.push(cs[i]);
    }

    /// The operator approves every deposit not approved yet.
    function _approveAll() internal {
        uint256 n;
        for (uint256 i = 0; i < leaves.length; i++) if (!pool.approved(leaves[i])) n++;
        uint256[] memory cs = new uint256[](n);
        n = 0;
        for (uint256 i = 0; i < leaves.length; i++) if (!pool.approved(leaves[i])) cs[n++] = leaves[i];
        _approve(cs);
    }

    function _one(uint256 x) internal pure returns (uint256[] memory xs) {
        xs = new uint256[](1);
        xs[0] = x;
    }

    function _csv(uint256[] memory xs) internal pure returns (string memory s) {
        for (uint256 i = 0; i < xs.length; i++) s = string.concat(s, i == 0 ? "" : ",", vm.toString(xs[i]));
    }

    function _proveWith(uint256 nullifier, uint256 secret, address to, address rel, uint256 fee, uint256[] memory assoc)
        internal
        returns (Proof memory p)
    {
        string[] memory cmd = new string[](9);
        cmd[0] = "node";
        cmd[1] = "scripts/ffi-prove.mjs";
        cmd[2] = vm.toString(nullifier);
        cmd[3] = vm.toString(secret);
        cmd[4] = vm.toString(to);
        cmd[5] = vm.toString(rel);
        cmd[6] = vm.toString(fee);
        cmd[7] = _csv(leaves);
        cmd[8] = _csv(assoc);
        (p.a, p.b, p.c, p.root, p.assocRoot, p.nullifierHash) =
            abi.decode(vm.ffi(cmd), (uint256[2], uint256[2][2], uint256[2], uint256, uint256, uint256));
    }

    function _prove(uint256 nullifier, uint256 secret, address to, address rel, uint256 fee) internal returns (Proof memory) {
        return _proveWith(nullifier, secret, to, rel, fee, approvedList);
    }

    function _withdraw(Proof memory p, address payable to, address payable rel, uint256 fee) internal {
        pool.withdraw(p.a, p.b, p.c, p.root, p.assocRoot, p.nullifierHash, to, rel, fee);
    }

    /* ---------- Trees ---------- */

    function test_TreeRootsMatchOffChain() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "a");
        _deposit(bob, "b");
        _deposit(carol, "c");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        assertEq(p.root, pool.depositRoot(), "deposit tree: on-chain == off-chain");
        assertEq(p.assocRoot, pool.approvedRoot(), "approved tree: on-chain == off-chain");
        assertEq(pool.depositCount(), 3);
        assertEq(pool.approvedCount(), 3);
    }

    /* ---------- Happy paths ---------- */

    function test_WithdrawThroughRelayer() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "alice-1");
        _deposit(bob, "bob-1");
        _deposit(carol, "carol-1");
        _approveAll();

        uint256 fee = (ONE * 10) / 10_000; // 0.10% relayer fee
        Proof memory p = _prove(n, s, fresh, relayer, fee);
        vm.prank(relayer); // the relayer sends it; the fresh address needs no ETH
        _withdraw(p, fresh, relayer, fee);

        assertEq(fresh.balance, ONE - 0.002 ether - fee, "fresh address gets 0.997");
        assertEq(vault.balance, 0.002 ether, "0.20% to the vault");
        assertEq(relayer.balance, fee, "relayer fee");
        assertTrue(pool.nullifierSpent(p.nullifierHash));
        assertEq(address(pool).balance, 2 ether, "the other two notes stay");
    }

    function test_WithdrawPayingOwnGas() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "alice-2");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        vm.prank(fresh);
        _withdraw(p, fresh, payable(address(0)), 0);
        assertEq(fresh.balance, ONE - 0.002 ether);
    }

    function test_WithdrawAgainstOlderRoots() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "old-1");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        // More deposits and approvals land after the proof was built; both roots are still in history.
        _deposit(bob, "old-2");
        _deposit(carol, "old-3");
        _approveAll();
        _withdraw(p, fresh, payable(address(0)), 0);
        assertEq(fresh.balance, ONE - 0.002 ether);
    }

    function test_ShieldFeeReachesRewardsVault() public {
        ZhieldRewardsVault rv = new ZhieldRewardsVault(owner, owner, address(0xBEEF), 0);
        ZhieldPool p2 = new ZhieldPool(
            IWithdrawVerifier(address(verifier)), hasher, hasher1, IAssociationRegistry(address(registry)), ONE, payable(address(rv)), owner
        );
        pool = p2; // the helpers act on `pool`
        (uint256 n, uint256 s, ) = _deposit(alice, "vault-fee");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        _withdraw(p, fresh, payable(address(0)), 0);
        assertEq(address(rv).balance, 0.002 ether, "0.20% landed in the RewardsVault");
        assertEq(rv.balanceOf(address(0)), 0.002 ether);
    }

    /* ---------- What must fail ---------- */

    function test_DoubleSpendReverts() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "ds");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        _withdraw(p, fresh, payable(address(0)), 0);
        vm.expectRevert("Pool: note already spent");
        _withdraw(p, fresh, payable(address(0)), 0);
    }

    function test_NotApprovedCannotWithdraw() public {
        (uint256 n, uint256 s, uint256 cAlice) = _deposit(alice, "flagged");
        (, , uint256 cBob) = _deposit(bob, "clean");
        _approve(_one(cBob)); // the operator approves Bob only

        // Alice can only build a proof against a set that includes her note; that root never existed on-chain.
        uint256[] memory fake = new uint256[](2);
        fake[0] = cBob;
        fake[1] = cAlice;
        Proof memory p = _proveWith(n, s, fresh, address(0), 0, fake);
        vm.expectRevert("Pool: unknown approved-set root");
        _withdraw(p, fresh, payable(address(0)), 0);
    }

    function test_ChangedRecipientInvalidatesProof() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "steal");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        vm.expectRevert("Pool: invalid proof");
        _withdraw(p, payable(makeAddr("thief")), payable(address(0)), 0);
    }

    function test_ChangedFeeInvalidatesProof() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "fee");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, relayer, 0.001 ether);
        vm.expectRevert("Pool: invalid proof");
        _withdraw(p, fresh, relayer, 0.002 ether);
    }

    function test_RelayerFeeCapped() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "cap");
        _approveAll();
        uint256 fee = 0.004 ether; // 0.40% > 0.30%
        Proof memory p = _prove(n, s, fresh, relayer, fee);
        vm.expectRevert("Pool: relayer fee too high");
        _withdraw(p, fresh, relayer, fee);
    }

    function test_UnknownDepositRootReverts() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "root");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        p.root = p.root + 1;
        vm.expectRevert("Pool: unknown root");
        _withdraw(p, fresh, payable(address(0)), 0);
    }

    /* ---------- Screening operator ---------- */

    function test_OnlyOperatorApproves() public {
        (, , uint256 c) = _deposit(alice, "op");
        vm.prank(alice);
        vm.expectRevert("Pool: not operator");
        pool.approve(_one(c));
    }

    function test_CannotApproveWhatWasNotDeposited() public {
        vm.prank(operator);
        vm.expectRevert("Pool: not deposited");
        pool.approve(_one(12345));
    }

    function test_CannotApproveTwice() public {
        (, , uint256 c) = _deposit(alice, "twice");
        _approve(_one(c));
        vm.prank(operator);
        vm.expectRevert("Pool: already approved");
        pool.approve(_one(c));
    }

    function test_OperatorChangeIsTimelocked() public {
        address next = makeAddr("nextOperator");
        vm.prank(owner);
        registry.proposeOperator(next);
        vm.expectRevert("Registry: timelock");
        registry.activateOperator();
        vm.warp(block.timestamp + 7 days);
        registry.activateOperator();
        assertEq(registry.operator(), next);
    }

    /* ---------- Ragequit ---------- */

    function test_RagequitReturnsToSource() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "rq");
        uint256 before = alice.balance;
        vm.prank(alice);
        pool.ragequit(n, s);
        assertEq(alice.balance, before + ONE, "full amount back, no fee");
    }

    function test_OnlyDepositorCanRagequit() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "rq2");
        vm.prank(bob);
        vm.expectRevert("Pool: only the depositor");
        pool.ragequit(n, s);
    }

    function test_NoWithdrawAfterRagequit() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "rq3");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        vm.prank(alice);
        pool.ragequit(n, s);
        vm.expectRevert("Pool: note already spent");
        _withdraw(p, fresh, payable(address(0)), 0);
    }

    function test_NoRagequitAfterWithdraw() public {
        (uint256 n, uint256 s, ) = _deposit(alice, "rq4");
        _approveAll();
        Proof memory p = _prove(n, s, fresh, address(0), 0);
        _withdraw(p, fresh, payable(address(0)), 0);
        vm.prank(alice);
        vm.expectRevert("Pool: note already spent");
        pool.ragequit(n, s);
    }

    /* ---------- Deposits and admin ---------- */

    function test_DepositRules() public {
        (uint256 n, uint256 s) = _note("rules");
        uint256 c = hasher.poseidon([n, s]);
        vm.prank(alice);
        vm.expectRevert("Pool: wrong amount");
        pool.deposit{value: 0.5 ether}(c);

        vm.prank(alice);
        pool.deposit{value: ONE}(c);
        vm.prank(bob);
        vm.expectRevert("Pool: duplicate commitment");
        pool.deposit{value: ONE}(c);

        vm.prank(owner);
        pool.setDepositsPaused(true);
        vm.prank(bob);
        vm.expectRevert("Pool: deposits paused");
        pool.deposit{value: ONE}(c + 1);

        vm.prank(owner);
        pool.setDepositsPaused(false);
        vm.prank(owner);
        pool.setDepositCap(1);
        vm.prank(bob);
        vm.expectRevert("Pool: cap reached");
        pool.deposit{value: ONE}(c + 1);
    }

    function test_OnlyOwnerAdmin() public {
        vm.expectRevert("Pool: not owner");
        pool.setDepositsPaused(true);
        vm.expectRevert("Registry: not owner");
        registry.proposeOperator(alice);
    }

    function test_FeeRecipientTimelock() public {
        address payable next = payable(makeAddr("newVault"));
        vm.prank(owner);
        pool.proposeFeeRecipient(next);
        vm.expectRevert("Pool: timelock");
        pool.activateFeeRecipient();
        vm.warp(block.timestamp + 7 days);
        pool.activateFeeRecipient();
        assertEq(pool.feeRecipient(), next);
    }
}
