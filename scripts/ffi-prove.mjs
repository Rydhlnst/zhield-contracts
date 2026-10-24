// FFI entry for the Foundry tests. Prints one ABI-encoded tuple:
//   (uint256[2] a, uint256[2][2] b, uint256[2] c, uint256 root, uint256 assocRoot, uint256 nullifierHash)
// Args: nullifier secret recipient relayer fee leavesCsv assocLeavesCsv
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultArtifacts, proveWithdraw } from "./zhield.mjs";

const [nullifier, secret, recipient, relayer, fee, leavesCsv, assocCsv] = process.argv.slice(2);
const split = (s) => (s ? s.split(",").filter(Boolean) : []);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const r = await proveWithdraw({
  nullifier,
  secret,
  recipient,
  relayer,
  fee,
  leaves: split(leavesCsv),
  assocLeaves: split(assocCsv),
  ...defaultArtifacts(root),
});

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = [...r.a, ...r.b[0], ...r.b[1], ...r.c, r.root, r.assocRoot, r.nullifierHash];
process.stdout.write("0x" + words.map(word).join(""));
process.exit(0);
