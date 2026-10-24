#!/usr/bin/env node
// Who controls Zhield, and handing the roles over. Run from contracts/:
//
//   node scripts/roles.mjs status                 every contract's owner, operator and publisher
//   node scripts/roles.mjs bot <address>          owner: make <address> the bot (publisher now,
//                                                 screening operator after the 7-day timelock)
//   node scripts/roles.mjs activate               anyone, 7 days later: the new operator takes over
//   node scripts/roles.mjs owner <safe>           owner: start moving ownership of all five
//                                                 contracts to a Safe (multisig)
//
// After `owner <safe>`, the Safe must call acceptOwnership() on the registry, the vault
// and the three pools (Safe{Wallet} → New transaction → Transaction builder, five calls in
// one batch). Until it does, the launch wallet stays the owner.
//
// Transactions are signed by `cast` with the launch keystore (ZHIELD_ACCOUNT, default
// zhield-launch), which asks for its password in the terminal.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.ZHIELD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const ACCOUNT = process.env.ZHIELD_ACCOUNT ?? "zhield-launch";
const CAST = process.env.CAST ?? join(homedir(), ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const ZERO = ethers.constants.AddressZero;

const provider = () => new ethers.providers.StaticJsonRpcProvider(RPC, 4663);

export function deployment() {
  const f = process.env.ZHIELD_DEPLOYMENT ?? join(ROOT, "deployments", "robinhood.json");
  if (!existsSync(f)) throw new Error("No deployments/robinhood.json yet.");
  return JSON.parse(readFileSync(f, "utf8"));
}

const ABI = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function operator() view returns (address)",
  "function nextOperator() view returns (address)",
  "function nextOperatorAt() view returns (uint256)",
  "function publisher() view returns (address)",
];

/** Owner, pending owner and the bot roles of every contract, read from the chain. */
export async function readRoles(d = deployment()) {
  const p = provider();
  const c = (a) => new ethers.Contract(a, ABI, p);
  const reg = c(d.registry);
  const vault = c(d.vault);
  const pools = { "Pool A": d.poolA, "Pool B": d.poolB, "Pool C": d.poolC };
  const [operator, nextOperator, nextOperatorAt, publisher] = await Promise.all([reg.operator(), reg.nextOperator(), reg.nextOperatorAt(), vault.publisher()]);
  const owners = {};
  for (const [name, a] of [["Registry", d.registry], ["Vault", d.vault], ...Object.entries(pools)]) {
    const [owner, pendingOwner] = await Promise.all([c(a).owner(), c(a).pendingOwner()]);
    owners[name] = { address: a, owner, pendingOwner: pendingOwner === ZERO ? null : pendingOwner };
  }
  return {
    operator,
    nextOperator: nextOperator === ZERO ? null : nextOperator,
    nextOperatorAt: nextOperator === ZERO ? null : Number(nextOperatorAt) * 1000,
    publisher,
    owners,
  };
}

function send(to, sig, args) {
  console.log(`\n→ ${sig.slice(0, sig.indexOf("("))} on ${to} (keystore "${ACCOUNT}" asks for its password)`);
  const out = execFileSync(CAST, ["send", to, sig, ...args, "--rpc-url", RPC, "--account", ACCOUNT, "--json"], { stdio: ["inherit", "pipe", "inherit"] }).toString();
  const r = JSON.parse(out);
  if (r.status !== "0x1" && r.status !== 1 && r.status !== "1") throw new Error(`reverted: ${r.transactionHash}`);
  console.log(`✓ ${EXPLORER}/tx/${r.transactionHash}`);
}

const when = (ms) => new Date(ms).toLocaleString();

async function status() {
  const r = await readRoles();
  console.log(`Screening operator  ${r.operator}`);
  if (r.nextOperator) console.log(`  next operator     ${r.nextOperator}, can be activated from ${when(r.nextOperatorAt)}`);
  console.log(`Rewards publisher   ${r.publisher}`);
  console.log("\nOwners");
  for (const [name, o] of Object.entries(r.owners)) {
    console.log(`  ${name.padEnd(9)} ${o.owner}${o.pendingOwner ? `  → pending ${o.pendingOwner} (must call acceptOwnership)` : ""}`);
  }
}

const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");

async function bot(address) {
  if (!isAddress(address)) throw new Error("Give the bot wallet's address: node scripts/roles.mjs bot 0x…");
  const d = deployment();
  const r = await readRoles(d);
  const a = ethers.utils.getAddress(address);
  if (r.publisher === a) console.log("The bot already publishes rewards.");
  else if (d.timelock && r.owners.Vault.owner === ethers.utils.getAddress(d.timelock)) {
    console.log(`The vault is owned by the timelock, so a new publisher waits 2 days in public:\n  node scripts/timelock.mjs publisher ${a}`);
  } else send(d.vault, "setPublisher(address)", [a]);
  if (r.operator === a) console.log("The bot is already the screening operator.");
  else if (r.nextOperator === a) console.log(`Already proposed; activate it from ${when(r.nextOperatorAt)} with: node scripts/roles.mjs activate`);
  else {
    send(d.registry, "proposeOperator(address)", [a]);
    console.log(`\nThe bot publishes rewards from now on. It takes over screening in 7 days:\n  node scripts/roles.mjs activate\nUntil then the launch wallet keeps screening (leave launch.mjs running, or run zhield-cli screen).`);
  }
}

async function activate() {
  const d = deployment();
  const r = await readRoles(d);
  if (!r.nextOperator) return console.log("No operator change is pending.");
  if (Date.now() < r.nextOperatorAt) return console.log(`Too early: ${r.nextOperator} can be activated from ${when(r.nextOperatorAt)}.`);
  send(d.registry, "activateOperator()", []);
}

async function owner(safe) {
  if (!isAddress(safe)) throw new Error("Give the Safe's address: node scripts/roles.mjs owner 0x…");
  const s = ethers.utils.getAddress(safe);
  const code = await provider().getCode(s);
  if (code === "0x") throw new Error(`${s} has no code on Robinhood Chain. Create the Safe first (app.safe.global, network Robinhood Chain).`);
  const r = await readRoles();
  const d = deployment();
  for (const [name, o] of Object.entries(r.owners)) {
    if (d.timelock && o.owner === ethers.utils.getAddress(d.timelock)) console.log(`${name}: owned by the 2-day timelock; give the Safe its proposer role through the timelock instead.`);
    else if (o.owner === s) console.log(`${name}: the Safe already owns it.`);
    else if (o.pendingOwner === s) console.log(`${name}: already pending, waiting for the Safe to accept.`);
    else send(o.address, "transferOwnership(address)", [s]);
  }
  console.log(`\nNow accept from the Safe: one batch of acceptOwnership() on\n${Object.entries(r.owners).map(([n, o]) => `  ${n.padEnd(9)} ${o.address}`).join("\n")}\nThen check with: node scripts/roles.mjs status`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const commands = { status, bot, activate, owner };
  if (!commands[cmd]) {
    console.log("Usage: node scripts/roles.mjs status | bot <address> | activate | owner <safe>");
    process.exit(cmd ? 1 : 0);
  }
  try {
    await commands[cmd](arg);
  } catch (e) {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();
