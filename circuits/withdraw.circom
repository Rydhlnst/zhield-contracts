pragma circom 2.1.9;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

/*
  Zhield withdraw circuit.

  Proves, without saying which deposit it is:
  1. the prover knows (nullifier, secret) for a commitment Poseidon(nullifier, secret),
  2. that commitment is a leaf of the pool's deposit tree (root),
  3. the same commitment is a leaf of the screening operator's approved set (assocRoot),
  4. nullifierHash = Poseidon(nullifier), so the note can be spent once.
  recipient, relayer and fee are public and bound to the proof, so nobody can
  swap the payout address or the fee after the proof is built.
*/

// Root of a binary Poseidon Merkle tree from a leaf and its path.
// pathIndices[i] = 0: the current node is the left child at level i.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component mux[levels];
    component hashers[levels];
    signal hashes[levels + 1];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== hashes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== hashes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[levels];
}

template Withdraw(levels) {
    // Public
    signal input root;
    signal input assocRoot;
    signal input nullifierHash;
    signal input recipient;
    signal input relayer;
    signal input fee;

    // Private
    signal input nullifier;
    signal input secret;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input assocPathElements[levels];
    signal input assocPathIndices[levels];

    // Notes carry 31-byte values; keep both inside 248 bits.
    component nullifierBits = Num2Bits(248);
    nullifierBits.in <== nullifier;
    component secretBits = Num2Bits(248);
    secretBits.in <== secret;

    component commitment = Poseidon(2);
    commitment.inputs[0] <== nullifier;
    commitment.inputs[1] <== secret;

    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHasher.out === nullifierHash;

    component tree = MerkleProof(levels);
    tree.leaf <== commitment.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    component assoc = MerkleProof(levels);
    assoc.leaf <== commitment.out;
    for (var i = 0; i < levels; i++) {
        assoc.pathElements[i] <== assocPathElements[i];
        assoc.pathIndices[i] <== assocPathIndices[i];
    }
    assoc.root === assocRoot;

    // Bind the public payout fields into the proof.
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
    signal relayerSquare;
    relayerSquare <== relayer * relayer;
    signal feeSquare;
    feeSquare <== fee * fee;
}

component main {public [root, assocRoot, nullifierHash, recipient, relayer, fee]} = Withdraw(20);
