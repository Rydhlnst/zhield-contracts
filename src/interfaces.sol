// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Poseidon over BN254 with two inputs (circomlibjs bytecode, PoseidonT3).
interface IPoseidon2 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// Poseidon over BN254 with one input (circomlibjs bytecode, PoseidonT2).
interface IPoseidon1 {
    function poseidon(uint256[1] calldata inputs) external pure returns (uint256);
}

/// The Groth16 verifier exported by snarkjs for circuits/withdraw.circom.
/// Public signals: [root, assocRoot, nullifierHash, recipient, relayer, fee].
interface IWithdrawVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[6] calldata publicSignals
    ) external view returns (bool);
}

/// Names the screening operator that may approve deposits in every pool.
interface IAssociationRegistry {
    function operator() external view returns (address);
}
