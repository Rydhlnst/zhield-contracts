// Prints calldata for verifyProof(...) from a fresh, real proof, for checking the
// verifier against a live node with eth_call (no transaction, no gas).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { defaultArtifacts, poseidon, proveWithdraw } from "./zhield.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rand = () => BigInt("0x" + randomBytes(31).toString("hex"));
const [n, s] = [rand(), rand()];
const mine = await poseidon([n, s]);
const others = [await poseidon([rand(), rand()]), await poseidon([rand(), rand()])];
const leaves = [others[0], mine, others[1]];

const r = await proveWithdraw({
  nullifier: n,
  secret: s,
  leaves,
  assocLeaves: leaves,
  recipient: "0x000000000000000000000000000000000000dEaD",
  relayer: "0x0000000000000000000000000000000000000000",
  fee: 0,
  ...defaultArtifacts(root),
});
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const args = [...r.a, ...r.b[0], ...r.b[1], ...r.c, ...r.publicSignals].map(word).join("");
// ABI-encoded arguments of verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6]); prepend the selector.
console.log(JSON.stringify({ args: "0x" + args, publicSignals: r.publicSignals }));
process.exit(0);
