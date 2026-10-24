// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidon2} from "./interfaces.sol";

/*
  Incremental Poseidon Merkle tree, depth 20 (1,048,576 leaves), keeping the
  last 100 roots so a proof built against a slightly older root still works
  while new leaves land. Same layout as the circuit: at each level the current
  node is the left child when its index bit is 0. A pool keeps two of these:
  every deposit, and the deposits the screening operator approved.
*/
library PoseidonTree {
    uint256 internal constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// Empty leaf: keccak256("zhield") mod p, so no real commitment can equal it by accident.
    uint256 internal constant ZERO_VALUE = 18126080588273741620097476446158113792858343384868573834787317571051517601655;
    uint32 internal constant LEVELS = 20;
    uint32 internal constant ROOT_HISTORY_SIZE = 100;

    struct Tree {
        uint256[LEVELS] filledSubtrees;
        uint256[ROOT_HISTORY_SIZE] roots;
        uint32 currentRootIndex;
        uint32 nextIndex;
    }

    /// zeros[i] is the root of an empty subtree of height i; zeros[LEVELS] is the empty tree.
    function zeros(IPoseidon2 hasher) internal view returns (uint256[LEVELS + 1] memory z) {
        z[0] = ZERO_VALUE;
        for (uint32 i = 1; i <= LEVELS; i++) z[i] = hasher.poseidon([z[i - 1], z[i - 1]]);
    }

    function init(Tree storage t, uint256[LEVELS + 1] memory z) internal {
        for (uint32 i = 0; i < LEVELS; i++) t.filledSubtrees[i] = z[i];
        t.roots[0] = z[LEVELS];
    }

    function insert(Tree storage t, IPoseidon2 hasher, uint256[LEVELS] storage z, uint256 leaf) internal returns (uint32 index) {
        index = t.nextIndex;
        require(index != uint32(2) ** LEVELS, "Tree: full");
        uint32 currentIndex = index;
        uint256 current = leaf;
        for (uint32 i = 0; i < LEVELS; i++) {
            uint256 left;
            uint256 right;
            if (currentIndex % 2 == 0) {
                left = current;
                right = z[i];
                t.filledSubtrees[i] = current;
            } else {
                left = t.filledSubtrees[i];
                right = current;
            }
            current = hasher.poseidon([left, right]);
            currentIndex /= 2;
        }
        uint32 next = (t.currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        t.currentRootIndex = next;
        t.roots[next] = current;
        t.nextIndex = index + 1;
    }

    function isKnownRoot(Tree storage t, uint256 root) internal view returns (bool) {
        if (root == 0) return false;
        uint32 i = t.currentRootIndex;
        do {
            if (t.roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY_SIZE - 1 : i - 1;
        } while (i != t.currentRootIndex);
        return false;
    }

    function lastRoot(Tree storage t) internal view returns (uint256) {
        return t.roots[t.currentRootIndex];
    }
}
