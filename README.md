# Zhield Cash: contracts, circuit and tests

The smart contracts and zero-knowledge circuit behind [zhield.cash](https://zhield.cash): private ETH on Robinhood Chain, with proof of clean funds, and hourly NVDA rewards for $ZHIELD holders.

Every deployed contract is an exact match to this source on [Sourcify](https://repo.sourcify.dev/4663/0x637E03b86798B46c0658eF09dF160a0ebb1516DF). The addresses are in `deployments/robinhood.json` and at [zhield.cash/docs#contracts](https://zhield.cash/docs#contracts).

## Run the tests yourself

Needs [Foundry](https://getfoundry.sh) and Node 18+.

```bash
npm install
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test
```

49 tests: 22 for the pools (with real Groth16 proofs built through FFI), 21 for the RewardsVault and 6 for the 2-day timelock that owns it. One vault test uses the real NVDA token and runs only on a fork: `forge test --fork-url robinhood`.

The proving key, the wasm and the verifier in `build/` are the ones the deployed verifier was generated from. Don't run `npm run circuit` to check them: it makes a fresh key, and proofs from it won't match the deployed verifier.

---

# Zhield contracts (phase 1)

The privacy core: Poseidon Merkle pools for 0.001, 0.01 and 0.1 ETH, each with an on-chain deposit tree and an on-chain approved tree, a Groth16 withdraw circuit that proves membership in both, the AssociationRegistry that names the screening operator, and ragequit. Anyone can rebuild both trees from the Deposit and Approved events. The RewardsVault and the ZHIELD token are phase 2.

## Setup

```bash
npm install
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
npm run circuit   # compile circuits/withdraw.circom, Groth16 setup, export the verifier and Poseidon bytecode
```

`npm run circuit` uses the Ethereum Foundation PSE Perpetual Powers of Tau (2^15) plus one random contribution. That zkey is for testing and a guarded launch; the public setup ceremony replaces it before caps lift.

## Test

```bash
forge test -vv                         # local chain, real proofs through FFI
forge test -vv --fork-url robinhood    # the same on a Robinhood Chain mainnet fork
```

## Launch in one command

Run this in PowerShell or Windows Terminal, from this folder:

```bash
node scripts/launch.mjs
```

It asks for one password. With that password it:

1. Creates a new wallet (keystore `zhield-launch`).
2. Waits for at least 0.003 ETH on Robinhood Chain.
3. Deploys and verifies every contract, with that wallet as owner, screening operator and rewards publisher.
4. Asks for the $ZHIELD address from Pons.
5. Publishes the hourly proofs as a public gist.
6. Creates the relayer wallet (keystore `zhield-relayer`) and offers to fund it with 0.002 ETH from the launch wallet.
7. Offers to set the addresses on Vercel, with the relayer key as a secret (`RELAYER_PRIVATE_KEY`, sent on stdin, never shown), and redeploy.
8. Keeps running: it approves clean deposits every 5 minutes and pays holders every hour.

### Relayer

zhield.cash/api/relay sends withdrawals for users and pays the gas, so nobody needs a funded wallet to unshield and no wallet of theirs appears on-chain. Its address and fee are inside the zero-knowledge proof, so it cannot redirect the ETH or take more. The fee covers the gas at the current price with a margin, between 0.10% and the pool's 0.30% cap; on the smallest pool the cap is below the gas cost, so the relayer adds a little. Every request is simulated first, so an invalid proof costs it nothing. Keep the relayer wallet topped up; the launcher shows its balance and warns when it runs low.

Run it again to resume; finished steps are skipped.

The password stays in the process and in a temporary file only your user can read, which is deleted on exit. Back up `~/.foundry/keystores/zhield-launch` and its password: that wallet owns the contracts.

Send NVDA to the vault yourself; the bot pays only what the vault holds.

## The bot on zhield.cash

`launch.mjs` screens and pays only while its window is open. The site runs the same jobs as two routes with a bot wallet of its own, so the laptop can be closed and the launch wallet (the owner) never sits on a server. An outside cron service calls them, because Vercel's own cron runs only once a day on the Hobby plan:

- `GET /api/bot/screen`, every 5 minutes: approves new deposits that pass [screening](#screening). Most runs only read two counters per pool.
- `GET /api/bot/payout`, every hour at minute 5: pays holders and publishes the proofs file at `/api/rewards/latest`, then checks the bot and relayer gas, the vault's NVDA and the operator handover, and alerts on Telegram.

Both need `Authorization: Bearer <BOT_CRON_SECRET>`. Their state (pending deposits, the rewards state, alert memory) lives in a private Vercel Blob store, written only when it changes. Code in `lib/bot/`. Its Merkle tree matches `holder-rewards.mjs`, and the whole flow (approve, flag, publish, claim, claimTo) was run on a fork of mainnet.

1. **Bot wallet.** `cast wallet new` prints a fresh address and key. Send the address about 0.002 ETH on Robinhood Chain, and put the key in Vercel as a sensitive variable (run from the site folder, paste the key when asked): `npx vercel env add BOT_PRIVATE_KEY production --sensitive`.
2. **Cron secret.** Make one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`, add it the same way as `BOT_CRON_SECRET`, and keep it for step 5.
3. **Telegram, alerts and screening.** One bot from @BotFather (`TELEGRAM_BOT_TOKEN`) does both jobs:
   - Team alerts go to `TELEGRAM_CHAT_ID` (a private group).
   - The public channel `TELEGRAM_PUBLIC_CHAT_ID` (`@yourchannel`, with the bot as an admin) gets every approval batch, every held-back deposit (never an address) and every hourly payout. Set `NEXT_PUBLIC_ZHIELD_TELEGRAM_URL` (`https://t.me/yourchannel`) to link it in the footer.
   - With `TELEGRAM_WEBHOOK_SECRET` (any random string) the bot also answers `/pools`, `/status`, `/contracts` and `/help` in any chat. The hourly payout run registers the webhook (`/api/telegram`) and the command list by itself. There is deliberately no command that takes an address.

   Optional: `CHAINALYSIS_API_KEY` (free at public.chainalysis.com) as a third screening source, `BOT_DENYLIST` for extra addresses (comma-separated), `BOT_EXCLUDE` for wallets that never earn rewards.
4. **Hand it the roles.** `node scripts/roles.mjs bot <bot address>` (asks for the launch wallet's password). The bot publishes rewards at once and takes over screening after the registry's 7-day timelock: then run `node scripts/roles.mjs activate` (the payout route reminds you). Until then keep `launch.mjs` running; it stops each job by itself once the bot holds that role. Set `NEXT_PUBLIC_ZHIELD_REWARDS_URL=https://zhield.cash/api/rewards/latest` and redeploy.
5. **Cron.** At cron-job.org (free), two jobs: `https://zhield.cash/api/bot/screen` every 5 minutes and `https://zhield.cash/api/bot/payout` every hour at minute 5, each with the header `Authorization: Bearer <BOT_CRON_SECRET>` (Advanced → Headers) and a 60-second timeout. Turn on its failure emails: they also catch the site being down.

Each route answers with what it did, as JSON, so a job's history at cron-job.org doubles as the bot's log.

## Roles

```bash
node scripts/roles.mjs status           # owner, operator, publisher of every contract
node scripts/roles.mjs bot <address>    # publisher now, operator after 7 days
node scripts/roles.mjs activate         # after the timelock
node scripts/roles.mjs owner <safe>     # hand ownership of all five contracts to a Safe
```

Ownership goes to a Safe (app.safe.global, network Robinhood Chain; the Safe v1.4.1 contracts are deployed there). `owner <safe>` only proposes it: the Safe then calls `acceptOwnership()` on the registry, the vault and the three pools in one batch (Transaction builder). Until it does, the launch wallet stays the owner. After that, owner actions (pause, cap, operator, publisher, vault withdrawals) need the Safe's signers.

## The vault's timelock

The RewardsVault is owned by `ZhieldTimelock` (OpenZeppelin's TimelockController, unchanged). Every owner action on the vault, a withdrawal, a new publisher, a new hourly cap or a new owner, is queued on-chain first and can only run two days later. Holders see it coming and can claim everything they earned before it runs. The owner can still withdraw, after the delay. Pools and the registry keep their owner, so deposits can be paused at once in an emergency; no pool function can move ETH.

Set it up once, as the vault's owner (asks for the launch wallet's password, costs about 0.0001 ETH):

```bash
forge script script/Timelock.s.sol --rpc-url robinhood --account zhield-launch --broadcast
```

It deploys the timelock, hands it the vault, sets the 2-day delay and renounces its admin role, all in one run, and records `timelock` in `deployments/robinhood.json`. Then set `NEXT_PUBLIC_ZHIELD_TIMELOCK` on Vercel and redeploy: the site, the docs and the rewards page switch to the timelock wording and list it among the contracts. Verify it like the others (`forge verify-contract <address> src/ZhieldTimelock.sol:ZhieldTimelock --chain 4663 --verifier sourcify --rpc-url robinhood --guess-constructor-args`).

Day to day:

```bash
node scripts/timelock.mjs status                        # the delay and every queued action
node scripts/timelock.mjs withdraw nvda <to> [amount]   # queue a withdrawal (all of it without an amount)
node scripts/timelock.mjs publisher <address>           # queue a new rewards publisher (the bot)
node scripts/timelock.mjs cap <amount>                  # queue a new hourly cap, in NVDA
node scripts/timelock.mjs execute <id>                  # run it once the 2 days have passed
node scripts/timelock.mjs cancel <id>                   # drop it
```

Tested in `test/ZhieldTimelock.t.sol` and end to end on a fork of mainnet with the real vault: a direct owner withdrawal reverts, a queued one fails before two days and pays out after them, and the publisher keeps posting roots.

## Screening

`scripts/screening.mjs`, used by `zhield-cli screen`, `launch.mjs` and the bot. A deposit is not approved when its source is on `screening/denylist.txt`, on the OFAC SDN list (fetched every 12 hours, cached in `screening/ofac-eth.txt`) or, with `CHAINALYSIS_API_KEY`, flagged by Chainalysis. It fails closed: when a source cannot answer, the deposit waits for the next run instead of being approved.

## Deploy by hand (the deployer signs, the key stays in an encrypted keystore)

```bash
cast wallet import nockpad-deployer --interactive
forge script script/Deploy.s.sol --rpc-url robinhood --account nockpad-deployer --broadcast
```

Set `ZHIELD_OWNER`, `ZHIELD_OPERATOR`, `ZHIELD_FEE_RECIPIENT` and `ZHIELD_DEPOSIT_CAP` first; see the header of `script/Deploy.s.sol`.

## EVM target

`evm_version = "cancun"`. Robinhood Chain runs Cancun opcodes: the NVDA token on mainnet uses them, and its code fails under an older target in fork tests. The live node verifies a real proof against the Cancun build of the verifier and accepts the pool and vault deployments (eth_call, no gas).

## Real test on mainnet (from this folder)

```bash
node scripts/zhield-cli.mjs status
node scripts/zhield-cli.mjs deposit 0.001                  # note saved in notes/ before anything is sent
node scripts/zhield-cli.mjs screen                         # operator approves deposits that pass screening
node scripts/zhield-cli.mjs withdraw notes/<file> 0xFresh  # real Groth16 proof, pays 0.000998 ETH
node scripts/zhield-cli.mjs ragequit notes/<file>          # depositor takes 0.001 ETH back
```

Every transaction is signed by `cast` with the keystore (`ZHIELD_ACCOUNT`, default `zhield-launch`, the wallet `scripts/launch.mjs` creates), which asks for its password in the terminal. Screening checks the sources listed under [Screening](#screening).

The whole flow was run on an anvil fork of Robinhood Chain mainnet before release.

## RewardsVault

`ZhieldRewardsVault` receives the 0.20% shield fee from every pool in ETH and can hold any ERC-20. It pays $ZHIELD holders in NVIDIA • Robinhood Token (NVDA, `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` on Robinhood Chain, verified on-chain: name, symbol, 18 decimals).

**The rule:** every wallet holding at least 3,000,000 $ZHIELD earns $0.01 of NVDA each hour.

$ZHIELD launches on Pons, so the vault cannot see its transfers. `scripts/holder-rewards.mjs` runs every hour:

1. It reads $ZHIELD balances from Transfer events.
2. It prices NVDA from its most liquid Robinhood Chain pool on DexScreener, or from `--price`.
3. It adds `hours × $0.01 / price` to each eligible wallet.
4. It posts a Merkle root of everyone's cumulative total with `publishRoot`.

```bash
node scripts/holder-rewards.mjs run --vault <vault> --holders <ZHIELD> --from-block <launch block> \n  [--usd-per-hour 0.01] [--min-hold 3000000] [--uri https://zhield.cash/rewards/latest.json]
```

The vault limits the bot:

- It accepts one root per clock hour.
- A root can add at most `hourlyCap` NVDA for each hour since the last root, and catch-up stops after 24 hours. The default cap is 0.05 NVDA, about $10, enough for about 1,000 eligible wallets.
- When the cap is too small for everyone, every wallet gets an equal smaller amount.
- The owner changes the cap with `setHourlyCap`; 0 pauses rewards.

Contracts never earn, so the Pons curve, Uniswap pools and lockers are skipped automatically. Wallets using EIP-7702 still earn. List any other address that must not earn in `rewards/exclude.txt`, such as team wallets. If the vault holds less NVDA than it owes, the bot publishes nothing, and the next run pays the missed hours (up to 24). The bot's state lives in `rewards/state.json`. Back it up, because the bot refuses to run if the state no longer matches the vault's `publishedTotal`. `rewards/latest.json` holds every holder's proof. Host it at a public URL that allows CORS, pass that URL as `--uri`, and set it as `NEXT_PUBLIC_ZHIELD_REWARDS_URL` on the site. The /rewards page reads the file, checks its root against the vault, and lets each holder claim. `NEXT_PUBLIC_ZHIELD_VAULT_BLOCK` (the vault's deploy block) turns on the claim history there.

Holders claim for themselves on zhield.cash/rewards, from the wallet that holds $ZHIELD: `claim` pays that wallet, `claimTo` pays a fresh address. Nobody else, the team included, can claim for a holder. One claim pays everything earned so far, and the previous root's proofs still work for an hour. **The owner can withdraw everything** with `withdraw` / `withdrawAll`, including amounts already published; each withdrawal emits `OwnerWithdrawal`.

NVDA is a beacon proxy controlled by its issuer. Its code has `adminBurn(address,uint256)` (the issuer can burn from any address, the vault included), `pause()`, an access-control registry, and a UI multiplier for corporate actions. Today a transfer from a holder to a fresh address succeeds (checked with eth_call), and Uniswap and Ramses pools hold it. It can be withdrawn or claimed only while the issuer allows transfers.

## Known limits

- Holder rewards are a snapshot each hour: a wallet that buys to 3M just before the bot runs earns that hour. A wallet that splits 30M into ten 3M wallets earns ten times as much.
- `ragequit` reveals the note's secret in calldata. It is meant for deposits that were not approved; for an approved note a front-runner could race it with a withdrawal. Robinhood Chain's sequencer has no public mempool, which makes this hard, but it is not impossible.
- No external audit. Contracts and circuit are tested end to end here and reviewed in-house.
