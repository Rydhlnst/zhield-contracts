#!/usr/bin/env node
// Launch day in one command. Run it in PowerShell or Windows Terminal:
//
//   node scripts/launch.mjs
//
// It asks for one password and does the rest:
//   1. creates the launch wallet (Foundry keystore "zhield-launch") the first time,
//      or unlocks it with the password,
//   2. waits until the wallet holds enough ETH on Robinhood Chain,
//   3. deploys every contract (pools, registry, RewardsVault paying NVDA) with that
//      wallet as owner, screening operator and rewards publisher, and verifies them,
//   4. asks for the $ZHIELD address once it is live on Pons, and where to host the
//      hourly proofs (a public GitHub gist),
//   5. sets up the relayer wallet (keystore "zhield-relayer") that pays gas for
//      withdrawals on zhield.cash, and offers to fund it from the launch wallet,
//   6. offers to set the addresses and the relayer key on Vercel and redeploy zhield.cash,
//   7. keeps running: approves clean deposits every 5 minutes and pays holders every hour.
//
// Ctrl+C stops it. Run the same command again to resume; finished steps are skipped.
// The password lives only in this process and in a temporary file that only this
// user can read, deleted when it exits. The private key never leaves the keystore.
//
// Settings: ZHIELD_LAUNCH_ACCOUNT (keystore name, default zhield-launch), ZHIELD_RPC,
// CHAINALYSIS_API_KEY (screening), and for local test runs ZHIELD_KEYSTORE_DIR,
// ZHIELD_DEPLOYMENT (inside deployments/), ZHIELD_REWARDS_DIR. `--once` runs the
// screening and rewards one time and exits.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { readRoles } from "./roles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "..");
const RPC = process.env.ZHIELD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const BIN = join(homedir(), ".foundry", "bin");
const exe = (n) => join(BIN, process.platform === "win32" ? `${n}.exe` : n);
const CAST = process.env.CAST ?? exe("cast");
const FORGE = process.env.FORGE ?? exe("forge");
const ACCOUNT = process.env.ZHIELD_LAUNCH_ACCOUNT ?? "zhield-launch";
const KEYDIR = process.env.ZHIELD_KEYSTORE_DIR ?? join(homedir(), ".foundry", "keystores");
const KEYSTORE = join(KEYDIR, ACCOUNT);
const RELAYER = process.env.ZHIELD_RELAYER_ACCOUNT ?? "zhield-relayer";
const RELAYER_KEYSTORE = join(KEYDIR, RELAYER);
const RELAYER_FUND = 2n * 10n ** 15n; // 0.002 ETH: gas for a few hundred withdrawals
const DEPLOY_REL = process.env.ZHIELD_DEPLOYMENT ?? "deployments/robinhood.json";
const DEPLOY = join(ROOT, DEPLOY_REL);
const REWARDS = process.env.ZHIELD_REWARDS_DIR ?? join(ROOT, "rewards");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const LOCAL = /127\.0\.0\.1|localhost/.test(RPC);
const ONCE = process.argv.includes("--once");

const MIN_ETH = 3n * 10n ** 15n; // 0.003 ETH: deploy is ~0.001, the rest pays approvals and hourly roots
const LOW_ETH = 5n * 10n ** 14n;

/* ---------- Terminal ---------- */

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
const queued = [];
const waiting = [];
let ended = false;
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : queued.push(l)));
// With no more input (piped runs), every question takes its default.
rl.on("close", () => {
  ended = true;
  while (waiting.length) waiting.shift()("");
});
let muted = false;
rl._writeToOutput = (s) => !muted && rl.output.write(s);

function ask(q, { hidden = false } = {}) {
  process.stdout.write(q);
  muted = hidden;
  return new Promise((res) => {
    const done = (l) => {
      muted = false;
      if (hidden && process.stdin.isTTY) process.stdout.write("\n");
      res(l.trim());
    };
    queued.length ? done(queued.shift()) : ended ? done("") : waiting.push(done);
  });
}
const yes = async (q, dflt) => {
  const a = (await ask(`${q} ${dflt ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a.startsWith("y") : dflt;
};

const say = (s = "") => console.log(s);
const step = (n, s) => say(`\n━━ ${n} · ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Password: one prompt, a private temp file for cast and forge ---------- */

const tmp = mkdtempSync(join(tmpdir(), "zhield-launch-"));
const PWFILE = join(tmp, "pw");
const cleanup = () => rmSync(tmp, { recursive: true, force: true });
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
rl.on("SIGINT", () => {
  say("\nStopped. Run `node scripts/launch.mjs` to resume.");
  process.exit(130);
});

const savePassword = (pw) => writeFileSync(PWFILE, pw, { mode: 0o600 });
const walletArgs = () => ["--keystore", KEYSTORE, "--password-file", PWFILE];

/* ---------- Chain ---------- */

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const balance = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const eth = (wei, d = 5) => (Number(wei / 10n ** 12n) / 1e6).toFixed(d);

/** First block where `address` has code. */
async function createdAt(address) {
  let lo = 0;
  let hi = Number(BigInt(await rpc("eth_blockNumber", [])));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await rpc("eth_getCode", [address, "0x" + mid.toString(16)]).catch(() => "0x");
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function nvdaOf(a) {
  const data = "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(await rpc("eth_call", [{ to: NVDA, data }, "latest"]));
}

/* ---------- State: the deployment file carries everything the launch learns ---------- */

const load = () => (existsSync(DEPLOY) ? JSON.parse(readFileSync(DEPLOY, "utf8")) : null);
const save = (d) => writeFileSync(DEPLOY, JSON.stringify(d, null, 2) + "\n");

/* ---------- Steps ---------- */

async function unlock() {
  step(1, "Launch wallet");
  if (!existsSync(KEYSTORE)) {
    say(`Creating a new wallet, saved encrypted as "${ACCOUNT}" in ${KEYDIR}.`);
    for (;;) {
      const pw = await ask("Choose a password (8+ characters): ", { hidden: true });
      const again = await ask("Type it again: ", { hidden: true });
      if (pw.length < 8) say("  ✗ Too short.");
      else if (pw !== again) say("  ✗ The two passwords differ.");
      else {
        mkdirSync(KEYDIR, { recursive: true });
        // CAST_PASSWORD is cast's --unsafe-password, passed in this child's environment only.
        const r = spawnSync(CAST, ["wallet", "new", KEYDIR, ACCOUNT], { env: { ...process.env, CAST_PASSWORD: pw }, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`cast wallet new failed: ${r.stderr}`);
        savePassword(pw);
        break;
      }
    }
    say(`  ✓ Created. Back up ${KEYSTORE} and the password together: this wallet owns the contracts.`);
  } else {
    for (let tries = 0; ; tries++) {
      savePassword(await ask(`Password for "${ACCOUNT}": `, { hidden: true }));
      const r = spawnSync(CAST, ["wallet", "address", ...walletArgs()], { encoding: "utf8" });
      if (r.status === 0) break;
      say("  ✗ Wrong password.");
      if (tries === 2) process.exit(1);
    }
  }
  const address = execFileSync(CAST, ["wallet", "address", ...walletArgs()], { encoding: "utf8" }).trim();
  say(`  Address: ${address}`);
  return address;
}

async function fund(address, d) {
  let bal = await balance(address);
  if (d || bal >= MIN_ETH) return say(`  ETH: ${eth(bal)}`);
  step(2, "Fund the wallet");
  say(`Send at least ${eth(MIN_ETH, 3)} ETH on Robinhood Chain (chain 4663) to:\n\n    ${address}\n`);
  while (bal < MIN_ETH) {
    process.stdout.write(`\r  Waiting for ETH… ${eth(bal)} ETH  `);
    await sleep(5000);
    bal = await balance(address);
  }
  say(`\r  ✓ Received ${eth(bal)} ETH.            `);
}

async function deploy(address) {
  step(3, "Deploy the contracts");
  say("PoseidonT3, PoseidonT2, Groth16Verifier, AssociationRegistry, RewardsVault (NVDA every hour) and the 0.001, 0.01 and 0.1 ETH pools.");
  const verify = LOCAL ? [] : ["--verify", "--verifier", "blockscout", "--verifier-url", `${EXPLORER}/api/`];
  const r = spawnSync(FORGE, ["script", "script/Deploy.s.sol", "--rpc-url", RPC, ...walletArgs(), "--sender", address, "--broadcast", ...verify], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ZHIELD_DEPLOYMENT_FILE: DEPLOY_REL },
  });
  const d = load();
  if (!d) {
    say("\n✗ The deploy did not finish; nothing was recorded. Fix the error above and run this again.");
    process.exit(1);
  }
  if (r.status !== 0) say("\n! The contracts are deployed, but source verification reported an error. You can verify them later on the explorer.");
  d.deployBlock = await createdAt(d.registry);
  save(d);
  say(`  ✓ Deployed at block ${d.deployBlock}. Addresses saved in contracts/${DEPLOY_REL}.`);
  return d;
}

async function token(d) {
  if (d.zhield) return;
  step(4, "$ZHIELD on Pons");
  for (;;) {
    const a = await ask("Paste the $ZHIELD token address (Enter to skip until it is live on Pons): ");
    if (!a) return say("  Skipped. Holder rewards start once you run this again with the address.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
      say("  ✗ That is not an address.");
      continue;
    }
    const code = await rpc("eth_getCode", [a, "latest"]);
    if (code === "0x") {
      say("  ✗ No contract at that address on Robinhood Chain.");
      continue;
    }
    d.zhield = a;
    d.zhieldBlock = await createdAt(a);
    save(d);
    return say(`  ✓ $ZHIELD ${a}, created at block ${d.zhieldBlock}.`);
  }
}

async function proofsHost(d) {
  if (!d.zhield || d.proofsUrl || LOCAL) return;
  step(5, "Where holders get their proofs");
  mkdirSync(REWARDS, { recursive: true });
  const file = join(REWARDS, "latest.json");
  if (!existsSync(file)) writeFileSync(file, "{}\n");
  const login = spawnSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8", shell: process.platform === "win32" }).stdout?.trim();
  if (login && (await yes(`Publish the hourly proofs file as a public GitHub gist on @${login}? (holder addresses and amounts, already public on-chain)`, true))) {
    const out = spawnSync("gh", ["gist", "create", "--public", "--desc", "Zhield holder rewards proofs", file], { encoding: "utf8", shell: process.platform === "win32" });
    const id = /gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]+)/.exec(out.stdout ?? "")?.[1];
    if (id) {
      d.gistId = id;
      d.proofsUrl = `https://gist.githubusercontent.com/${login}/${id}/raw/latest.json`;
      save(d);
      return say(`  ✓ ${d.proofsUrl}`);
    }
    say(`  ✗ gh did not create the gist: ${(out.stderr ?? "").trim()}`);
  }
  if (ended) return;
  const url = await ask("Or paste a public URL that will serve rewards/latest.json with CORS (Enter to skip): ");
  if (/^https:\/\//.test(url)) {
    d.proofsUrl = url;
    save(d);
  }
}

function siteEnv(d) {
  const env = {
    NEXT_PUBLIC_ZHIELD_POOL_A: d.poolA,
    NEXT_PUBLIC_ZHIELD_POOL_B: d.poolB,
    NEXT_PUBLIC_ZHIELD_POOL_C: d.poolC,
    NEXT_PUBLIC_ZHIELD_REGISTRY: d.registry,
    NEXT_PUBLIC_ZHIELD_VAULT: d.vault,
    NEXT_PUBLIC_ZHIELD_VAULT_BLOCK: String(d.deployBlock),
  };
  if (d.zhield) env.NEXT_PUBLIC_ZHIELD_TOKEN = d.zhield;
  if (d.proofsUrl) env.NEXT_PUBLIC_ZHIELD_REWARDS_URL = d.proofsUrl;
  return env;
}

/* The relayer: a separate hot wallet that only holds gas. Its key goes to Vercel as a secret. */
async function relayer(d) {
  step("5b", "Relayer");
  if (!existsSync(RELAYER_KEYSTORE)) {
    const pw = readFileSync(PWFILE, "utf8");
    const r = spawnSync(CAST, ["wallet", "new", KEYDIR, RELAYER], { env: { ...process.env, CAST_PASSWORD: pw }, encoding: "utf8" });
    if (r.status !== 0) return say(`  ✗ Could not create the relayer wallet: ${r.stderr}`);
    say(`  ✓ Created the relayer wallet "${RELAYER}" (same password as the launch wallet).`);
  }
  const address = execFileSync(CAST, ["wallet", "address", "--keystore", RELAYER_KEYSTORE, "--password-file", PWFILE], { encoding: "utf8" }).trim();
  if (d.relayer !== address) {
    d.relayer = address;
    save(d);
  }
  const bal = await balance(address);
  say(`  Address: ${address} · ${eth(bal)} ETH`);
  if (bal < LOW_ETH && (await yes(`Send ${eth(RELAYER_FUND, 3)} ETH from the launch wallet to the relayer for gas?`, true))) {
    const r = spawnSync(CAST, ["send", address, "--value", RELAYER_FUND.toString(), "--rpc-url", RPC, ...walletArgs()], { stdio: ["ignore", "ignore", "inherit"] });
    say(r.status === 0 ? "  ✓ Funded." : "  ✗ Could not fund it; send a little ETH to it yourself.");
  }
}

/** The relayer's private key, decrypted for one moment to hand to Vercel; never printed. */
function relayerKey() {
  const r = spawnSync(CAST, ["wallet", "decrypt-keystore", RELAYER, "-k", KEYDIR], {
    env: { ...process.env, CAST_UNSAFE_PASSWORD: readFileSync(PWFILE, "utf8") },
    encoding: "utf8",
  });
  return /0x[0-9a-fA-F]{64}/.exec(r.stdout ?? "")?.[0] ?? null;
}

async function website(d) {
  const env = siteEnv(d);
  const key = JSON.stringify({ ...env, relayer: d.relayer ?? null });
  if (d.vercelSynced === key) return;
  step(6, "zhield.cash");
  for (const [k, v] of Object.entries(env)) say(`  ${k}=${v}`);
  if (d.relayer) say(`  RELAYER_PRIVATE_KEY=(secret of ${d.relayer})`);
  if (LOCAL || !(await yes("Set these on Vercel (production) and redeploy zhield.cash from this folder now?", false))) {
    return say("  Not changed. Set them in Vercel → Settings → Environment Variables, then redeploy.");
  }
  const npx = (args) => spawnSync("npx", ["--yes", "vercel", ...args], { cwd: SITE, stdio: "inherit", shell: process.platform === "win32" });
  for (const [k, v] of Object.entries(env)) {
    if (npx(["env", "add", k, "-e", "production", "--value", v, "--force", "--yes", "--no-sensitive"]).status !== 0) return say(`  ✗ Could not set ${k}. Nothing else was changed.`);
  }
  if (d.relayer) {
    const secret = relayerKey();
    // The key goes in on stdin, as a Vercel secret: never on a command line or the screen.
    const r = secret
      ? spawnSync("npx", ["--yes", "vercel", "env", "add", "RELAYER_PRIVATE_KEY", "-e", "production", "--force", "--yes", "--sensitive"], {
          cwd: SITE,
          input: secret,
          stdio: ["pipe", "ignore", "inherit"],
          shell: process.platform === "win32",
        })
      : { status: 1 };
    if (r.status !== 0) say("  ✗ Could not set the relayer key; withdrawals still work with the user's own wallet paying gas.");
  }
  if (npx(["deploy", "--prod", "--yes"]).status !== 0) return say("  ✗ The redeploy failed. The variables are set; redeploy from the Vercel dashboard.");
  d.vercelSynced = key;
  save(d);
  say("  ✓ zhield.cash redeployed with the live addresses.");
}

/* ---------- Keep running ---------- */

function node(script, args) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ZHIELD_RPC: RPC, ZHIELD_KEYSTORE: KEYSTORE, ZHIELD_PASSWORD_FILE: PWFILE, ZHIELD_DEPLOYMENT: DEPLOY },
  });
  return r.status === 0;
}

function payHolders(d) {
  const ok = node("holder-rewards.mjs", ["run", "--vault", d.vault, "--holders", d.zhield, "--from-block", String(d.zhieldBlock), "--dir", REWARDS, "--uri", d.proofsUrl ?? ""]);
  if (ok && d.gistId) {
    const r = spawnSync("gh", ["gist", "edit", d.gistId, "--filename", "latest.json", join(REWARDS, "latest.json")], { stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) say("  ✗ Could not update the gist; holders see the previous hour until the next run.");
  }
}

async function status(address, d) {
  const [bal, held] = await Promise.all([balance(address), nvdaOf(d.vault)]);
  say(`\n[${new Date().toLocaleTimeString()}] wallet ${eth(bal)} ETH · vault ${(Number(held / 10n ** 12n) / 1e6).toFixed(4)} NVDA`);
  if (bal < LOW_ETH) say(`  ! Low on ETH. Send a little more to ${address}.`);
  if (d.relayer) {
    const rb = await balance(d.relayer);
    say(`  relayer ${eth(rb)} ETH`);
    if (rb < LOW_ETH / 2n) say(`  ! The relayer is low on gas. Send a little ETH to ${d.relayer}.`);
  }
  if (d.zhield && held === 0n) say(`  ! The vault has no NVDA yet. Send NVDA to ${d.vault} so holders can be paid.`);
}

async function main() {
  say("Zhield launch · Robinhood Chain mainnet" + (LOCAL ? " (local fork)" : ""));
  const address = await unlock();
  let d = load();
  await fund(address, d);
  if (!d) d = await deploy(address);
  else say(`  Contracts already deployed (contracts/${DEPLOY_REL}).`);
  await token(d);
  await proofsHost(d);
  await relayer(d);
  await website(d);

  step(7, "Running");
  say("Approves clean deposits every 5 minutes and pays holders at the top of every hour.");
  say("Leave this window open. Ctrl+C stops it; run the same command to resume.");
  let lastScreen = 0;
  let lastHour = -1;
  // Once the bot (zhield.cash/api/bot/*) holds a role, this wallet stops doing that job.
  let roles = { operator: true, publisher: true };
  for (;;) {
    if (Date.now() - lastScreen >= 5 * 60_000) {
      await status(address, d);
      roles = await readRoles(d)
        .then((r) => ({ operator: r.operator === address, publisher: r.publisher === address }))
        .catch(() => roles);
      if (roles.operator) node("zhield-cli.mjs", ["screen"]);
      else say("  The bot is the screening operator now; this wallet no longer screens.");
      if (!roles.publisher && d.zhield) say("  The bot publishes rewards now; this wallet no longer pays holders.");
      lastScreen = Date.now();
    }
    const hour = Math.floor(Date.now() / 3_600_000);
    if (d.zhield && roles.publisher && hour !== lastHour && (ONCE || Date.now() % 3_600_000 >= 60_000)) {
      payHolders(d);
      lastHour = hour;
    }
    if (ONCE) break;
    await sleep(20_000);
  }
  rl.close();
  process.exit(0);
}

await main();
