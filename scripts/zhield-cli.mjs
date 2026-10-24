#!/usr/bin/env node
// Zhield on Robinhood Chain mainnet, from the terminal.
//
//   node scripts/zhield-cli.mjs status
//   node scripts/zhield-cli.mjs deposit 0.001                shield 0.001 ETH; the note is saved in notes/
//   node scripts/zhield-cli.mjs screen                       operator: approve deposits that pass screening
//   node scripts/zhield-cli.mjs withdraw <note|file> <to>    prove and withdraw to a fresh address
//   node scripts/zhield-cli.mjs ragequit <note|file>         depositor: take the deposit back to its source
//
// Every transaction is signed by `cast` with an encrypted Foundry keystore, so the
// private key never reaches this script; cast asks for the keystore password in the
// terminal. Account name: ZHIELD_ACCOUNT (default zhield-launch, the wallet scripts/launch.mjs creates).
// For automated local runs only: ZHIELD_KEYSTORE (file) + ZHIELD_PASSWORD_FILE.
// Reads: deployments/robinhood.json (or ZHIELD_DEPLOYMENT), RPC from ZHIELD_RPC (default the public mainnet RPC).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultArtifacts, poseidon, proveWithdraw } from "./zhield.mjs";
import { loadScreening } from "./screening.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.ZHIELD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const ACCOUNT = process.env.ZHIELD_ACCOUNT ?? "zhield-launch";
const CAST = process.env.CAST ?? join(homedir(), ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");
const EXPLORER = "https://robinhoodchain.blockscout.com";

const TOPIC = {
  Deposit: "0x90e9c021de092ced915ba783260374f129aeeedec753ab3fb564631601ff9589",
  Approved: "0xa9758f643c50d15f4fb6af3345f42e504f6a74b14e4dd7a42fca661f89fe6dd0",
  Ragequit: "0x429567f82388a835aba2897e5e7712bb5c019aeab23b78baab5e9c3f1489470e",
};
const POOLS = { "0.001": "poolA", "0.01": "poolB", "0.1": "poolC" };
const ORDER = ["0.001", "0.01", "0.1"];
const TAG = { "0.001": "0.001eth", "0.01": "0.01eth", "0.1": "0.1eth" };
const WEI = { "0.001": 10n ** 15n, "0.01": 10n ** 16n, "0.1": 10n ** 17n };

/* ---------- Plumbing ---------- */

function deployment() {
  const f = process.env.ZHIELD_DEPLOYMENT ?? join(ROOT, "deployments", "robinhood.json");
  if (!existsSync(f)) die("No deployments/robinhood.json yet. Run the deploy script first.");
  return JSON.parse(readFileSync(f, "utf8"));
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** eth_getLogs in chunks, halving the range when the node refuses a large one. */
async function logs(address, topic0, fromBlock) {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  const out = [];
  let from = fromBlock;
  let step = 200_000;
  while (from <= latest) {
    const to = Math.min(from + step - 1, latest);
    try {
      out.push(...(await rpc("eth_getLogs", [{ address, topics: [topic0], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }])));
      from = to + 1;
    } catch (e) {
      if (step <= 500) throw e;
      step = Math.floor(step / 2);
    }
  }
  return out;
}

const word = (data, i) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const addr = (topic) => "0x" + topic.slice(26);

/**
 * First block where the registry has code. On Arbitrum chains block.number inside a
 * contract is the L1 number, so the deploy script cannot record this itself.
 */
let startBlock;
async function deployBlock(d) {
  if (startBlock !== undefined) return startBlock;
  if (d.deployBlock) return (startBlock = d.deployBlock);
  let lo = 0;
  let hi = Number(BigInt(await rpc("eth_blockNumber", [])));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await rpc("eth_getCode", [d.registry, "0x" + mid.toString(16)]).catch(() => "0x");
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1;
  }
  return (startBlock = lo);
}

/** Both trees of a pool, rebuilt from its events, in leaf order. */
async function poolState(pool, fromBlock) {
  const deps = (await logs(pool, TOPIC.Deposit, fromBlock))
    .map((l) => ({ commitment: BigInt(l.topics[1]), depositor: addr(l.topics[2]).toLowerCase(), index: Number(word(l.data, 0)), tx: l.transactionHash }))
    .sort((a, b) => a.index - b.index);
  const apps = (await logs(pool, TOPIC.Approved, fromBlock))
    .map((l) => ({ commitment: BigInt(l.topics[1]), index: Number(word(l.data, 0)) }))
    .sort((a, b) => a.index - b.index);
  return { deposits: deps, approved: apps };
}

/** Run cast with the keystore; the password prompt goes to this terminal. */
function send(to, sig, args, value) {
  const wallet = process.env.ZHIELD_KEYSTORE
    ? ["--keystore", process.env.ZHIELD_KEYSTORE, "--password-file", process.env.ZHIELD_PASSWORD_FILE ?? ""]
    : ["--account", ACCOUNT];
  const cmd = ["send", to, sig, ...args, "--rpc-url", RPC, ...wallet, "--json"];
  if (value) cmd.push("--value", value.toString());
  console.log(`\n→ cast send ${to} "${sig}" …` + (process.env.ZHIELD_KEYSTORE ? "" : ` (keystore "${ACCOUNT}" will ask for its password)`));
  // stderr stays on the terminal so cast's password prompt and any revert reason show up there.
  let out;
  try {
    out = execFileSync(CAST, cmd, { stdio: ["inherit", "pipe", "inherit"] }).toString();
  } catch (e) {
    // With --json, cast reports errors on stdout.
    const msg = `${e.stdout ?? ""}`;
    const reason = /execution reverted:?\s*([^,"\\\n]+)/i.exec(msg)?.[1] ?? /"message"\s*:\s*"([^"]+)"/.exec(msg)?.[1] ?? "see cast's message above";
    die(`Not sent: ${reason.trim()}. Nothing was spent.`);
  }
  const receipt = JSON.parse(out);
  if (receipt.status !== "0x1" && receipt.status !== "1" && receipt.status !== 1) die(`Transaction reverted: ${receipt.transactionHash}`);
  console.log(`✓ ${EXPLORER}/tx/${receipt.transactionHash}`);
  return receipt;
}

/* ---------- Notes, same format as the app: zhield-0.01eth-0x<nullifier><secret> ---------- */

const NOTE_RE = /^zhield-(0\.001|0\.01|0\.1)eth-0x([0-9a-f]{62})([0-9a-f]{62})$/;

function readNote(arg) {
  const text = (existsSync(arg) ? readFileSync(arg, "utf8") : arg).trim().toLowerCase();
  const m = NOTE_RE.exec(text);
  if (!m) die("That is not a Zhield note (zhield-<size>eth-0x followed by 124 hex characters).");
  return { size: m[1], nullifier: BigInt("0x" + m[2]), secret: BigInt("0x" + m[3]), text };
}

/* ---------- Commands ---------- */

async function status() {
  const d = deployment();
  console.log(`Robinhood Chain (chain ${d.chainId}) · registry ${d.registry}`);
  const operator = await rpc("eth_call", [{ to: d.registry, data: "0x570ca735" }, "latest"]); // operator()
  console.log(`operator ${addr(operator)}`);
  for (const size of ORDER) {
    const key = POOLS[size];
    const pool = d[key];
    const bal = BigInt(await rpc("eth_getBalance", [pool, "latest"]));
    const s = await poolState(pool, await deployBlock(d));
    console.log(`${size.padEnd(4)} ETH pool ${pool}  balance ${Number(bal) / 1e18} ETH  deposits ${s.deposits.length}  approved ${s.approved.length}`);
  }
}

async function deposit(size) {
  if (!POOLS[size]) die("Pool size must be 0.001, 0.01 or 0.1.");
  const d = deployment();
  const hex = () => randomBytes(31).toString("hex");
  const [n, s] = [hex(), hex()];
  const note = `zhield-${TAG[size]}-0x${n}${s}`;
  const commitment = await poseidon([BigInt("0x" + n), BigInt("0x" + s)]);

  // Save the note before anything is sent: it is the only key to the deposit.
  mkdirSync(join(ROOT, "notes"), { recursive: true });
  const file = join(ROOT, "notes", `${TAG[size]}-${commitment.toString(16).slice(0, 10)}.txt`);
  writeFileSync(file, note + "\n");
  console.log(`Note saved to ${file}\nKeep it: whoever holds it can withdraw the deposit.`);

  send(d[POOLS[size]], "deposit(uint256)", [commitment.toString()], WEI[size]);
}

/**
 * Screening: approve every pending deposit whose source passes scripts/screening.mjs
 * (our denylist, the OFAC list, Chainalysis). Flagged deposits stay out and can ragequit;
 * ones a source could not check stay pending until the next run.
 * With ZHIELD_SUMMARY_FILE set, a JSON summary of the run is written there (for the bot).
 */
async function screen() {
  const d = deployment();
  const { check, notes } = await loadScreening();
  for (const n of notes) console.log(`(${n})`);
  const summary = { approved: [], flagged: [], unknown: [], notes };
  const report = () => process.env.ZHIELD_SUMMARY_FILE && writeFileSync(process.env.ZHIELD_SUMMARY_FILE, JSON.stringify(summary));

  for (const size of ORDER) {
    const k = POOLS[size];
    const pool = d[k];
    const s = await poolState(pool, await deployBlock(d));
    const done = new Set(s.approved.map((x) => x.commitment));
    // Deposits that already went back to their source need no approval.
    for (const l of await logs(pool, TOPIC.Ragequit, await deployBlock(d))) done.add(BigInt(l.topics[1]));
    const pending = s.deposits.filter((x) => !done.has(x.commitment));
    const clean = [];
    for (const x of pending) {
      const r = await check(x.depositor);
      const item = { pool: size, index: x.index, depositor: x.depositor, tx: x.tx, source: r.source };
      if (r.verdict === "clean") clean.push(x);
      else if (r.verdict === "flagged") {
        summary.flagged.push(item);
        console.log(`  ✗ ${size} ETH leaf #${x.index} from ${x.depositor}: flagged by ${r.source}, not approved (it can ragequit)`);
      } else {
        summary.unknown.push(item);
        console.log(`  … ${size} ETH leaf #${x.index} from ${x.depositor}: not checked (${r.source}), left pending`);
      }
    }
    if (!clean.length) {
      console.log(`${size} ETH: nothing to approve`);
      continue;
    }
    console.log(`${size} ETH: approving ${clean.length} deposit(s): ${clean.map((x) => "#" + x.index).join(" ")}`);
    report();
    send(pool, "approve(uint256[])", [`[${clean.map((x) => x.commitment.toString()).join(",")}]`]);
    summary.approved.push(...clean.map((x) => ({ pool: size, index: x.index })));
  }
  report();
}

async function withdraw(noteArg, to) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? "")) die("Give the fresh address to pay, e.g. withdraw notes/0.001eth-….txt 0xYourFreshAddress");
  const d = deployment();
  const note = readNote(noteArg);
  const pool = d[POOLS[note.size]];
  const s = await poolState(pool, await deployBlock(d));
  const commitment = await poseidon([note.nullifier, note.secret]);
  const mine = s.deposits.find((x) => x.commitment === commitment);
  if (!mine) die("No deposit with this note in the pool.");
  if (mine.depositor === to.toLowerCase()) die("That address made the deposit. Withdrawing to it would link the two; use a fresh address.");
  if (!s.approved.some((x) => x.commitment === commitment)) die("Not approved by screening yet. Run `screen` (operator) or ragequit it.");
  const nullifierHash = await poseidon([note.nullifier]);
  const spent = await rpc("eth_call", [{ to: pool, data: "0x69aa8088" + nullifierHash.toString(16).padStart(64, "0") }, "latest"]); // nullifierSpent(uint256)
  if (BigInt(spent) === 1n) die("This note was already withdrawn or ragequit. Each note can be spent once.");

  console.log(`Building the proof (pool ${s.deposits.length} notes, approved set ${s.approved.length})…`);
  const t0 = Date.now();
  const p = await proveWithdraw({
    nullifier: note.nullifier,
    secret: note.secret,
    leaves: s.deposits.map((x) => x.commitment),
    assocLeaves: s.approved.map((x) => x.commitment),
    recipient: to,
    relayer: "0x0000000000000000000000000000000000000000",
    fee: 0,
    ...defaultArtifacts(ROOT),
  });
  console.log(`Proof ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const list = (xs) => `[${xs.map((x) => BigInt(x).toString()).join(",")}]`;
  send(
    pool,
    "withdraw(uint256[2],uint256[2][2],uint256[2],uint256,uint256,uint256,address,address,uint256)",
    [list(p.a), `[${list(p.b[0])},${list(p.b[1])}]`, list(p.c), p.root.toString(), p.assocRoot.toString(), p.nullifierHash.toString(), to, "0x0000000000000000000000000000000000000000", "0"],
  );
  const net = WEI[note.size] - (WEI[note.size] * 20n) / 10_000n;
  console.log(`${to} receives ${Number(net) / 1e18} ETH (0.20% shield fee to the fee recipient).`);
}

async function ragequit(noteArg) {
  const d = deployment();
  const note = readNote(noteArg);
  console.log("Ragequit reveals this note on-chain and sends the full amount back to the address that deposited it.");
  send(d[POOLS[note.size]], "ragequit(uint256,uint256)", [note.nullifier.toString(), note.secret.toString()]);
}

/* ---------- Main ---------- */

const [cmd, ...args] = process.argv.slice(2);
const commands = { status, deposit, screen, withdraw, ragequit };
if (!commands[cmd]) {
  console.log("Usage: node scripts/zhield-cli.mjs status | deposit <0.001|0.01|0.1> | screen | withdraw <note|file> <freshAddress> | ragequit <note|file>");
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](...args);
process.exit(0);
