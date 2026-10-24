#!/usr/bin/env node
// Hourly $ZHIELD holder rewards: the publisher bot for ZhieldRewardsVault.
//
//   node scripts/holder-rewards.mjs run --vault <vault> --holders <ZHIELD> --from-block <ZHIELD launch block>
//
// Every wallet holding at least --min-hold $ZHIELD (default 3,000,000) earns
// --usd-per-hour (default $0.01) of the vault's reward token (NVDA) each hour.
//
// Each run:
//   1. reads $ZHIELD Transfer events since the last run and updates every balance,
//   2. counts the full hours since its last run (at most 24) and prices the reward
//      token in USD (DexScreener's most liquid pool, or --price),
//   3. adds hours × usd-per-hour worth of the token to every eligible wallet. Contracts
//      never earn (the Pons curve, Uniswap pools, lockers; EIP-7702 wallets still do),
//      nor do the addresses in rewards/exclude.txt. If that is more than the vault's
//      hourly cap allows, every wallet gets an equal smaller amount; if the vault does
//      not hold enough to pay it, nothing is published and the next run catches up,
//   4. publishes a Merkle root of every holder's cumulative entitlement,
//   5. writes rewards/latest.json (root + each holder's proof, for the app) and
//      saves its state only after the root is on-chain.
//
// Schedule it hourly (cron, a CI job, a small server). It signs with the publisher
// keystore: ZHIELD_ACCOUNT, or ZHIELD_KEYSTORE + ZHIELD_PASSWORD_FILE when unattended.
// The vault refuses a root that adds more than hourlyCap per hour.
//
// Leaves match the vault: keccak256(bytes.concat(keccak256(abi.encode(account, cumulative)))).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.ZHIELD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const CAST = process.env.CAST ?? join(homedir(), ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");
const TRANSFER = ethers.utils.id("Transfer(address,address,uint256)");
const ZERO = ethers.constants.AddressZero;
const HOUR = 3600;
const MAX_CATCHUP_HOURS = 24; // same as the vault

/* ---------- Merkle, matching the vault ---------- */

export function leafOf(account, cumulative) {
  const inner = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [account, cumulative]));
  return ethers.utils.keccak256(inner);
}

const hashPair = (a, b) =>
  a.toLowerCase() < b.toLowerCase() ? ethers.utils.keccak256(ethers.utils.concat([a, b])) : ethers.utils.keccak256(ethers.utils.concat([b, a]));

/** Tree over the given leaves; an odd node at the end of a level moves up unchanged. */
export function merkle(leaves) {
  const levels = [[...leaves].sort()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const proof = (leaf) => {
    let idx = levels[0].indexOf(leaf);
    if (idx < 0) throw new Error("leaf not in tree");
    const out = [];
    for (let l = 0; l < levels.length - 1; l++) {
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < levels[l].length) out.push(levels[l][sib]);
      idx = Math.floor(idx / 2);
    }
    return out;
  };
  return { root: levels[levels.length - 1][0], proof };
}

/** Root and proofs over cumulative entitlements. */
export function buildRoot(cumulative) {
  const accounts = Object.keys(cumulative).filter((a) => cumulative[a] > 0n);
  const tree = merkle(accounts.map((a) => leafOf(a, cumulative[a])));
  const claims = {};
  let total = 0n;
  for (const a of accounts) {
    claims[a] = { cumulative: cumulative[a].toString(), proof: tree.proof(leafOf(a, cumulative[a])) };
    total += cumulative[a];
  }
  return { root: tree.root, total, claims };
}

/**
 * Reward per eligible wallet for this run, in token wei: hours × usd / price,
 * lowered so the sum stays within `allowance`.
 */
export function perWallet({ usdPerHour, price, decimals, hours, wallets, allowance }) {
  const micro = (x) => BigInt(Math.round(Number(x) * 1e6));
  if (wallets === 0 || hours === 0) return { each: 0n, capped: false };
  let each = (micro(usdPerHour) * 10n ** BigInt(decimals) * BigInt(hours)) / micro(price);
  const capped = each * BigInt(wallets) > allowance;
  if (capped) each = allowance / BigInt(wallets);
  return { each, capped };
}

/* ---------- Chain ---------- */

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const call = async (to, sig, args = []) => {
  const iface = new ethers.utils.Interface([`function ${sig}`]);
  const name = sig.slice(0, sig.indexOf("("));
  const data = iface.encodeFunctionData(name, args);
  const out = iface.decodeFunctionResult(name, await rpc("eth_call", [{ to, data }, "latest"]))[0];
  return ethers.BigNumber.isBigNumber(out) ? out.toBigInt() : out;
};

/** Apply Transfer logs in [from, to] to the balances, halving the range when the node refuses it. */
async function applyTransfers(token, balances, from, to) {
  let step = 200_000;
  while (from <= to) {
    const end = Math.min(from + step - 1, to);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: "0x" + from.toString(16), toBlock: "0x" + end.toString(16) }]);
    } catch (e) {
      if (step <= 500) throw e;
      step = Math.floor(step / 2);
      continue;
    }
    for (const l of logs) {
      const f = ethers.utils.getAddress("0x" + l.topics[1].slice(26));
      const t = ethers.utils.getAddress("0x" + l.topics[2].slice(26));
      const v = BigInt(l.data);
      if (f !== ZERO) balances[f] = (balances[f] ?? 0n) - v;
      if (t !== ZERO) balances[t] = (balances[t] ?? 0n) + v;
    }
    from = end + 1;
  }
}

/** USD price of one whole token from its most liquid DexScreener pair. */
async function priceUsd(token) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
  const pairs = ((await r.json()).pairs ?? []).filter((p) => p.chainId === "robinhood" && p.baseToken.address.toLowerCase() === token.toLowerCase() && p.priceUsd);
  if (pairs.length === 0) throw new Error("no DexScreener price for the reward token; pass --price");
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return { price: Number(pairs[0].priceUsd), source: pairs[0].url };
}

function send(to, sig, args) {
  const wallet = process.env.ZHIELD_KEYSTORE
    ? ["--keystore", process.env.ZHIELD_KEYSTORE, "--password-file", process.env.ZHIELD_PASSWORD_FILE ?? ""]
    : ["--account", process.env.ZHIELD_ACCOUNT ?? "zhield-launch"];
  try {
    return JSON.parse(execFileSync(CAST, ["send", to, sig, ...args, "--rpc-url", RPC, ...wallet, "--json"], { stdio: ["inherit", "pipe", "inherit"] }).toString());
  } catch (e) {
    const msg = `${e.stdout ?? ""}`;
    throw new Error(/execution reverted:?\s*([^,"\\\n]+)/i.exec(msg)?.[1] ?? "cast send failed");
  }
}

/* ---------- State ---------- */

const big = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));
const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));

function loadState(file, fromBlock) {
  if (!existsSync(file)) return { lastBlock: fromBlock - 1, lastHour: null, balances: {}, cumulative: {}, contracts: {} };
  const s = JSON.parse(readFileSync(file, "utf8"));
  return { lastBlock: s.lastBlock, lastHour: s.lastHour, balances: big(s.balances), cumulative: big(s.cumulative), contracts: s.contracts ?? {} };
}

const saveState = (file, s) =>
  writeFileSync(
    file,
    JSON.stringify({ lastBlock: s.lastBlock, lastHour: s.lastHour, balances: str(s.balances), cumulative: str(s.cumulative), contracts: s.contracts }, null, 1),
  );

function readList(file) {
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^0x[0-9a-fA-F]{40}$/.test(l))
      .map((a) => ethers.utils.getAddress(a)),
  );
}

/* ---------- Run ---------- */

function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}

async function run(f) {
  for (const k of ["vault", "holders", "from-block"]) if (!f[k]) throw new Error(`--${k} is required`);
  const vault = ethers.utils.getAddress(f.vault);
  const holders = ethers.utils.getAddress(f.holders);
  const usdPerHour = f["usd-per-hour"] ?? "0.01";
  const minHold = BigInt(f["min-hold"] ?? "3000000");
  const dir = f.dir ?? join(ROOT, "rewards");
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "state.json");
  const state = loadState(stateFile, Number(f["from-block"]));

  // 1. balances
  const head = Number(BigInt(await rpc("eth_blockNumber", [])));
  const { timestamp } = await rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false]);
  const hourNow = Math.floor(Number(BigInt(timestamp)) / HOUR) * HOUR;
  await applyTransfers(holders, state.balances, state.lastBlock + 1, head);

  // 2. hours, price and what the vault allows
  const published = await call(vault, "publishedTotal() view returns (uint256)");
  const already = Object.values(state.cumulative).reduce((s, v) => s + v, 0n);
  if (already !== published) throw new Error(`state (${already}) does not match the vault's publishedTotal (${published}); restore rewards/state.json`);
  const hours = state.lastHour == null ? 1 : Math.min(MAX_CATCHUP_HOURS, (hourNow - state.lastHour) / HOUR);
  if (hours <= 0) {
    console.log("Already ran this hour.");
    return;
  }
  const rewardToken = await call(vault, "rewardToken() view returns (address)");
  const decimals = Number(await call(rewardToken, "decimals() view returns (uint8)"));
  const holdDecimals = Number(await call(holders, "decimals() view returns (uint8)"));
  const allowance = await call(vault, "allowance() view returns (uint256)");
  const { price, source } = f.price ? { price: Number(f.price), source: "--price" } : await priceUsd(rewardToken);
  if (!(price > 0)) throw new Error("bad price");

  // 3. eligible wallets and their reward
  const excluded = readList(join(dir, "exclude.txt"));
  excluded.add(vault);
  const threshold = minHold * 10n ** BigInt(holdDecimals);
  const candidates = Object.entries(state.balances)
    .filter(([a, b]) => b >= threshold && !excluded.has(a))
    .map(([a]) => a);
  for (const a of candidates) {
    if (a in state.contracts) continue;
    const code = await rpc("eth_getCode", [a, "latest"]);
    state.contracts[a] = code !== "0x" && !code.startsWith("0xef0100"); // 0xef0100… is an EIP-7702 wallet
  }
  const eligible = candidates.filter((a) => !state.contracts[a]);
  if (allowance === 0n) {
    state.lastBlock = head;
    state.lastHour = hourNow;
    saveState(stateFile, state);
    console.log("The vault allows no payout this hour (its first hour, or the owner set the cap to 0). Next run pays.");
    return;
  }
  const { each, capped } = perWallet({ usdPerHour, price, decimals, hours, wallets: eligible.length, allowance });
  console.log(
    `block ${head} · ${hours}h · price $${price} (${source}) · ${eligible.length} wallets ≥ ${minHold} · ` +
      `${ethers.utils.formatUnits(each, decimals)} each${capped ? " (lowered to fit the hourly cap)" : ""}`,
  );

  state.lastBlock = head;
  if (each === 0n) {
    state.lastHour = hourNow;
    saveState(stateFile, state);
    console.log("Nothing to publish this hour.");
    return;
  }
  const owed = await call(vault, "owed() view returns (uint256)");
  const held = await call(rewardToken, "balanceOf(address) view returns (uint256)", [vault]);
  const due = owed + each * BigInt(eligible.length);
  if (held < due) {
    saveState(stateFile, state); // balances move on; the unpaid hours are paid on the next run (up to 24)
    console.log(`✗ The vault holds ${ethers.utils.formatUnits(held, decimals)} but needs ${ethers.utils.formatUnits(due, decimals)} to pay this hour. Send NVDA to ${vault}.`);
    return;
  }
  const cumulative = { ...state.cumulative };
  for (const a of eligible) cumulative[a] = (cumulative[a] ?? 0n) + each;

  // 4. publish
  const r = buildRoot(cumulative);
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify(
      { vault, holdersToken: holders, rewardToken, block: head, hour: hourNow, priceUsd: price, usdPerHour, minHold: minHold.toString(), root: r.root, total: r.total.toString(), claims: r.claims },
      null,
      1,
    ),
  );
  const receipt = send(vault, "publishRoot(bytes32,uint256,string)", [r.root, r.total.toString(), f.uri ?? ""]);
  console.log(`root ${r.root} · total ${ethers.utils.formatUnits(r.total, decimals)} · tx ${receipt.transactionHash}`);

  // 5. state, only once the root is on-chain
  saveState(stateFile, { ...state, lastHour: hourNow, cumulative });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // For the Foundry tests: `proof <addr:cumulative,…> <account>` prints abi.encode(root, cumulative, proof[]).
  if (cmd === "proof") {
    const [list, account] = rest;
    const cumulative = Object.fromEntries(list.split(",").map((p) => p.split(":")).map(([a, w]) => [ethers.utils.getAddress(a), BigInt(w)]));
    const r = buildRoot(cumulative);
    const c = r.claims[ethers.utils.getAddress(account)];
    process.stdout.write(ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256", "bytes32[]"], [r.root, c.cumulative, c.proof]));
    return;
  }
  if (cmd === "run") return run(flags(rest));
  console.log(
    "Usage: node scripts/holder-rewards.mjs run --vault <vault> --holders <ZHIELD> --from-block <n>\n" +
      "         [--usd-per-hour 0.01] [--min-hold 3000000] [--price <usd>] [--dir rewards] [--uri https://…]",
  );
  process.exit(1);
}

// Run main only when executed directly, not when imported (case-insensitive for Windows paths).
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();
