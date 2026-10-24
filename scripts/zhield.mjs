// Off-chain side of Zhield, shared by the tests (through FFI), the relayer and
// the app: the Poseidon Merkle tree laid out exactly like MerkleTreeWithHistory,
// and Groth16 proof generation for circuits/withdraw.circom.
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { join } from "node:path";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// keccak256("zhield") mod p, same as MerkleTreeWithHistory.ZERO_VALUE
export const ZERO_VALUE = 18126080588273741620097476446158113792858343384868573834787317571051517601655n;
export const LEVELS = 20;

let poseidonP;
export async function poseidon(inputs) {
  poseidonP ??= buildPoseidon();
  const p = await poseidonP;
  return p.F.toObject(p(inputs.map(BigInt)));
}

/** Every level of the tree for the given leaves; levels[0] are the leaves. */
export async function buildTree(leaves) {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= LEVELS; i++) zeros.push(await poseidon([zeros[i - 1], zeros[i - 1]]));
  const levels = [leaves.map(BigInt)];
  for (let l = 0; l < LEVELS; l++) {
    const cur = levels[l];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(await poseidon([cur[i], i + 1 < cur.length ? cur[i + 1] : zeros[l]]));
    }
    levels.push(next);
  }
  const root = levels[LEVELS][0] ?? zeros[LEVELS];
  const path = (index) => {
    const pathElements = [];
    const pathIndices = [];
    let idx = index;
    for (let l = 0; l < LEVELS; l++) {
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(levels[l][sibling] ?? zeros[l]);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  };
  return { root, path };
}

/**
 * Build a withdraw proof. `leaves` is the pool tree in insertion order,
 * `assocLeaves` the screening operator's approved commitments.
 */
export async function proveWithdraw({ nullifier, secret, leaves, assocLeaves, recipient, relayer, fee, wasm, zkey }) {
  const commitment = await poseidon([nullifier, secret]);
  const nullifierHash = await poseidon([nullifier]);
  const pool = await buildTree(leaves);
  const assoc = await buildTree(assocLeaves);
  const i = leaves.map(BigInt).indexOf(commitment);
  const j = assocLeaves.map(BigInt).indexOf(commitment);
  if (i < 0) throw new Error("commitment not in the pool tree");
  if (j < 0) throw new Error("commitment not in the approved set");
  const p = pool.path(i);
  const q = assoc.path(j);
  const input = {
    root: pool.root,
    assocRoot: assoc.root,
    nullifierHash,
    recipient: BigInt(recipient),
    relayer: BigInt(relayer),
    fee: BigInt(fee),
    nullifier: BigInt(nullifier),
    secret: BigInt(secret),
    pathElements: p.pathElements,
    pathIndices: p.pathIndices,
    assocPathElements: q.pathElements,
    assocPathIndices: q.pathIndices,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const calldata = JSON.parse("[" + (await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)) + "]");
  const [a, b, c] = calldata;
  return { a, b, c, root: pool.root, assocRoot: assoc.root, nullifierHash, publicSignals };
}

export const defaultArtifacts = (root) => ({
  wasm: join(root, "build/withdraw_js/withdraw.wasm"),
  zkey: join(root, "build/withdraw.zkey"),
});
