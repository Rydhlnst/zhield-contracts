#!/usr/bin/env node
// The RewardsVault's owner is ZhieldTimelock (script/Timelock.s.sol). Every owner
// action is queued here, public on-chain, and runs only after the delay (2 days).
// Run from contracts/:
//
//   node scripts/timelock.mjs status                          delay, and every queued action
//   node scripts/timelock.mjs withdraw <nvda|eth|0xToken> <to> [amount]
//                                                             queue a vault withdrawal (all of it
//                                                             without an amount; amount in whole units)
//   node scripts/timelock.mjs publisher <address>             queue a new rewards publisher
//   node scripts/timelock.mjs cap <amount>                    queue a new hourly cap, in whole NVDA
//   node scripts/timelock.mjs execute <id>                    run a queued action once it is ready
//   node scripts/timelock.mjs cancel <id>                     drop a queued action
//
// Queue, execute and cancel are signed by `cast` with the launch keystore
// (ZHIELD_ACCOUNT, default zhield-launch), which asks for its password. Anyone may
// execute a ready action; the proposer is the only one who can queue or cancel.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { deployment } from "./roles.mjs";

const RPC = process.env.ZHIELD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const ACCOUNT = process.env.ZHIELD_ACCOUNT ?? "zhield-launch";
const CAST = process.env.CAST ?? join(homedir(), ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const ZERO32 = ethers.constants.HashZero;

const provider = new ethers.providers.StaticJsonRpcProvider(RPC, 4663);
const TL_ABI = [
  "function getMinDelay() view returns (uint256)",
  "function getTimestamp(bytes32) view returns (uint256)",
  "function isOperationPending(bytes32) view returns (bool)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
];
const VAULT = new ethers.utils.Interface([
  "function acceptOwnership()",
  "function updateDelay(uint256 newDelay)",
  "function withdraw(address token, address to, uint256 amount)",
  "function withdrawAll(address token, address to)",
  "function setPublisher(address publisher)",
  "function setHourlyCap(uint256 hourlyCap)",
  "function transferOwnership(address owner)",
]);

function setup() {
  const d = deployment();
  if (!d.timelock) throw new Error("No timelock in deployments/robinhood.json. Run script/Timelock.s.sol first.");
  return { d, tl: new ethers.Contract(d.timelock, TL_ABI, provider) };
}

// For fork tests only: ZHIELD_UNLOCKED_FROM signs with an unlocked anvil account instead of the keystore.
const wallet = () => (process.env.ZHIELD_UNLOCKED_FROM ? ["--from", process.env.ZHIELD_UNLOCKED_FROM, "--unlocked"] : ["--account", ACCOUNT]);

function send(to, sig, args) {
  console.log(`\n→ ${sig.slice(0, sig.indexOf("("))} on the timelock${process.env.ZHIELD_UNLOCKED_FROM ? "" : ` (keystore "${ACCOUNT}" asks for its password)`}`);
  const r = JSON.parse(execFileSync(CAST, ["send", to, sig, ...args, "--rpc-url", RPC, ...wallet(), "--json"], { stdio: ["inherit", "pipe", "inherit"] }).toString());
  if (r.status !== "0x1" && r.status !== 1 && r.status !== "1") throw new Error(`reverted: ${r.transactionHash}`);
  console.log(`✓ ${EXPLORER}/tx/${r.transactionHash}`);
}

/** getLogs in the 10M-block ranges the public RPC accepts for one address and topic. */
async function logs(filter, from) {
  const head = await provider.getBlockNumber();
  const out = [];
  for (let a = from; a <= head; a += 10_000_000) out.push(...(await provider.getLogs({ ...filter, fromBlock: a, toBlock: Math.min(a + 9_999_999, head) })));
  return out;
}

/** Every call the timelock queued, with its state, decoded when it targets the vault. */
async function queued(d, tl) {
  const out = [];
  for (const l of await logs({ address: d.timelock, topics: [tl.interface.getEventTopic("CallScheduled")] }, d.deployBlock)) {
    const e = tl.interface.parseLog(l).args;
    const [ready, done, pending, at] = await Promise.all([tl.isOperationReady(e.id), tl.isOperationDone(e.id), tl.isOperationPending(e.id), tl.getTimestamp(e.id)]);
    let what = e.data;
    try {
      const f = VAULT.parseTransaction({ data: e.data });
      what = `${f.name}(${f.args.map(String).join(", ")})`;
    } catch {}
    out.push({ id: e.id, target: e.target, data: e.data, what, at: at.toNumber(), state: done ? "done" : ready ? "ready" : pending ? "queued" : "cancelled" });
  }
  return out;
}

const when = (s) => new Date(s * 1000).toUTCString();

async function status() {
  const { d, tl } = setup();
  const delay = (await tl.getMinDelay()).toNumber();
  console.log(`ZhieldTimelock ${d.timelock} · owns the RewardsVault ${d.vault}`);
  console.log(`Delay: ${delay / 86400} days\n`);
  const ops = await queued(d, tl);
  if (!ops.length) return console.log("Nothing queued.");
  for (const o of ops) console.log(`${o.state.padEnd(9)} ${o.id}\n          ${o.what}${o.state === "queued" ? `\n          runs from ${when(o.at)}` : ""}`);
}

async function schedule(data, label) {
  const { d, tl } = setup();
  const delay = (await tl.getMinDelay()).toString();
  const salt = "0x" + randomBytes(32).toString("hex");
  send(d.timelock, "schedule(address,uint256,bytes,bytes32,bytes32,uint256)", [d.vault, "0", data, ZERO32, salt, delay]);
  const id = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256", "bytes", "bytes32", "bytes32"], [d.vault, 0, data, ZERO32, salt]));
  console.log(`\nQueued: ${label}\nid ${id}\nIt can run from ${when(Math.floor(Date.now() / 1000) + Number(delay))}: node scripts/timelock.mjs execute ${id}`);
}

const tokenOf = (t) => (t === "nvda" ? NVDA : t === "eth" ? ethers.constants.AddressZero : ethers.utils.getAddress(t));
const addr = (a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? "")) throw new Error("Give an address (0x…).");
  return ethers.utils.getAddress(a);
};

async function withdraw(token, to, amount) {
  const t = tokenOf((token ?? "").toLowerCase());
  const a = addr(to);
  const data = amount ? VAULT.encodeFunctionData("withdraw", [t, a, ethers.utils.parseUnits(amount, 18)]) : VAULT.encodeFunctionData("withdrawAll", [t, a]);
  await schedule(data, `withdraw ${amount ?? "everything"} of ${token} from the vault to ${a}`);
}

async function execute(id) {
  const { d, tl } = setup();
  const op = (await queued(d, tl)).find((o) => o.id.toLowerCase() === (id ?? "").toLowerCase());
  if (!op) throw new Error("No queued action with that id. See: node scripts/timelock.mjs status");
  if (op.state !== "ready") throw new Error(op.state === "queued" ? `Not ready: it can run from ${when(op.at)}.` : `It is ${op.state}.`);
  // The salt is not in the event; read it from the schedule transaction.
  const log = (await logs({ address: d.timelock, topics: [tl.interface.getEventTopic("CallScheduled"), op.id] }, d.deployBlock)).at(-1);
  const tx = await provider.getTransaction(log.transactionHash);
  const parsed = new ethers.utils.Interface(["function schedule(address,uint256,bytes,bytes32,bytes32,uint256)"]).parseTransaction({ data: tx.data });
  send(d.timelock, "execute(address,uint256,bytes,bytes32,bytes32)", [op.target, "0", op.data, ZERO32, parsed.args[4]]);
}

async function cancel(id) {
  const { d } = setup();
  send(d.timelock, "cancel(bytes32)", [id]);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const commands = {
    status,
    withdraw,
    publisher: (a) => schedule(VAULT.encodeFunctionData("setPublisher", [addr(a)]), `set the rewards publisher to ${a}`),
    cap: (n) => schedule(VAULT.encodeFunctionData("setHourlyCap", [ethers.utils.parseUnits(n, 18)]), `set the hourly cap to ${n} NVDA`),
    execute,
    cancel,
  };
  if (!commands[cmd]) {
    console.log("Usage: node scripts/timelock.mjs status | withdraw <nvda|eth|0xToken> <to> [amount] | publisher <address> | cap <amount> | execute <id> | cancel <id>");
    process.exit(cmd ? 1 : 0);
  }
  try {
    await commands[cmd](...args);
  } catch (e) {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(1);
  }
}

await main();
