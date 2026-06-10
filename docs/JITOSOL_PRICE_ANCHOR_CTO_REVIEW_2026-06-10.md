# JITOSOL/USDT Price Anchoring — Design Review

**Date:** 2026-06-10 · **Author:** Engineering (AI-assisted) · **Audience:** CTO / technical reviewer
**Status:** Implemented locally, pending adversarial review; production launch planned 2026-06-11

Companion documents: `COINSTORE_DEBUG_PRIMER.md` (auth/listing debugging history), `JITOSOL_PAIR_DIAGNOSIS_2026-06-10.md` (pair-discovery and decimals diagnosis).

---

## 1. Problem statement

We market-make JITOSOL/USDT on Coinstore using the ADAMANT tradebot (Node.js, this repo). The pair is currently in **pre-market** (whitelist-only — we are the sole participant); it goes **public on 2026-06-11**.

The bot's Price Watcher (PW) module is the only mechanism that constrains the prices at which the bot quotes. It supports two source modes:

1. **Manual range** — static low/high in USDT, set by command (current configuration: 78–105, set ~2026-06-03).
2. **Pair@Exchange** — live range derived from another exchange's order book for the *same base coin* (e.g., `ADM/USDT@Azbit`).

Neither works for us out of the box:

- The manual range goes stale. **Empirically:** the range mid was set at 91.5 around June 3; JitoSOL traded at **81.60 on June 10** — ~12% drift in one week, tracking SOL's decline.
- Mode 2 requires an exchange that (a) the bot has a connector for and (b) lists JITOSOL. **No such exchange exists** (verified §4.2).

### Why a stale anchor is the top financial risk at public launch

JitoSOL has an externally-determined fair value (it is a Solana liquid-staking token; see §3). Once public, any gap between our quotes and fair value is risk-free profit for arbitrageurs, extracted from our standing orders:

- **Fair price inside a stale range but away from our book:** arbs sweep mispriced standing orders (~20 JITOSOL ask-side + ~1,500 USDT bid-side exposed at any moment) until the book converges. Bounded, one-time loss per drift event.
- **Fair price outside a stale range (the catastrophic mode):** PW `prevent` action forbids the bot from quoting beyond the range, so the bot *perpetually* re-lists orders at off-market prices and arbs farm it continuously. Bounded only by total account balance (~5,000 USDT + 45 JITOSOL).

The June 3 → June 10 drift demonstrates this is not theoretical: had we gone public with the June 3 range and SOL kept falling another ~12%, we would have entered the catastrophic mode within ~2 weeks of a "fresh" manual range.

---

## 2. Options assessed

### Option 1 — External price-updater service ("simplified price watcher")

A standalone script (cron or pm2) fetches the JitoSOL price from a public API (CoinGecko `jito-staked-sol`) and periodically pushes an updated manual range to the bot.

**Feasibility findings (verified against the codebase):**

- CoinGecko's free tier comfortably supports the needed cadence (1 call / 5–15 min); price data confirmed available (returned $81.60 with 24h-change on 2026-06-10).
- **The bot has no inbound command API.** Its Express server (`routes/`) exposes only a health ping and an optional DB-debug read (`routes/init.js`, `routes/health.js`, `routes/debug.js`). Verified by reading all three route files.
- The only command channel is ADAMANT messenger. An external updater must therefore ship with: `adamant-console` (or js-api) installed on the VPS, a *dedicated* ADAMANT account funded with ADM for message fees, that account's passphrase stored in plaintext on the VPS, the account added to `admin_accounts` in config, plus cron, message formatting, and failure alerting.
- Editing `trade/settings/tradeParams_coinstore.*` directly was rejected: the bot holds tradeParams in memory and rewrites the file on its own schedule, so external writes race with the bot and are silently lost without a restart per update.

**Verdict: rejected as the primary mechanism.** The delivery channel (ADAMANT messaging infrastructure, which is observably flaky — see node health-check noise in production logs) becomes a hard dependency of the safety system. More moving parts than the bot itself. **Retained as a periodic cross-check** (§6, weekly one-liner).

### Option 2 — Peg to SOL via the bot's own Price Watcher (SELECTED)

JitoSOL's fair value is `SOL price × redemption rate` (§3). SOL/USDT is listed on Coinstore itself with a tight, well-arbitraged book. Patch the PW to watch `SOL/USDT@Coinstore` and multiply the derived range by a configurable coefficient (the redemption rate, currently ≈ 1.2842).

**Why this won:**

- The PW already supports watching a pair on the *same* exchange (`mm_price_watcher.js` explicitly handles `pwExchange === config.exchange`) and already handles "source pair ≠ traded pair" (cross-quote conversion branch). Only two gaps existed: a validation gate requiring the same base coin, and the absence of a multiplier. Total change: **3 files, ~20 lines** (§5).
- Range updates every PW cycle (~1 minute) with zero external dependencies, zero new accounts, zero new secrets.
- The coefficient is near-constant: it rises ~+0.5%/month (staking yield) and never falls. With a 3% deviation setting, a monthly coefficient refresh keeps months of safety margin.

**Verdict: selected.** Implementation and verification in §5.

### Option 3 — Manual range, adjusted 1–2× per week

**Verdict: rejected as the sole mechanism** on empirical grounds — the production account itself demonstrated ~12% drift within one week (§1), and SOL routinely moves 15–25% within a week. A `prevent`-action fence must move at market speed or it becomes a bleed mechanism (§1). **Retained, right-sized,** as the *human* layer: a monthly coefficient update plus a weekly cross-check (§6) — which is exactly the 1–2×/week effort budget originally proposed, applied where slow change actually happens (the redemption rate) instead of where fast change happens (SOL price).

### Decision matrix

| Criterion | Opt 1: external updater | Opt 2: SOL peg (selected) | Opt 3: manual weekly |
|---|---|---|---|
| Reaction time to SOL move | 5–15 min (cron cadence) | ~1 min (PW cycle) | days |
| New infrastructure | console + funded ADM acct + cron + secrets | none | none |
| Code changes to bot | none | 3 files, ~20 lines | none |
| New failure dependencies | ADAMANT msg delivery, CoinGecko, cron | Coinstore SOL book (already a dependency) | human discipline |
| Catastrophic-stale-range risk | low-medium (if updater dies silently) | low | **high** (demonstrated) |
| Ongoing human effort | monitor the updater | ~1 command/month | 1–2×/week forever |

---

## 3. JitoSOL pricing research (basis for the peg)

- JitoSOL is Jito's Solana liquid-staking token. Holders own a pro-rata claim on a stake pool; the **JitoSOL/SOL redemption rate** is computed on-chain and **monotonically increases** as staking + MEV rewards accrue (~7%/yr ⇒ ≈ +0.55%/month). It does not decrease in normal operation (slashing is the theoretical exception — rare, and would be major public news).
- Market price on liquid venues tracks this NAV within a few tenths of a percent (arbitrage via instant stake-pool mint and pool swaps; unstake arbitrage bounds the downside).
- **Live evidence collected 2026-06-10 (CoinGecko):** JitoSOL $81.60 (−3.80%/24h), SOL $63.54 (−3.92%/24h). The near-identical 24h changes confirm short-horizon lockstep; the ratio 81.60/63.54 = **1.2842** is the current redemption-rate estimate.
- **Coinstore's own SOL/USDT is a valid proxy for global SOL:** its ticker read 63.548 (bid 63.554 / ask 63.561, ~0.01% spread) vs CoinGecko global 63.54 — within cents. Verified 2026-06-10.
- ⚠️ **JTO ≠ JitoSOL.** JTO is Jito's governance token, widely listed, and has no peg to SOL. Any future source-pair change must not confuse the two.

---

## 4. Evidence & tests performed (all 2026-06-10 unless noted)

### 4.1 Live API verification

| Test | Result |
|---|---|
| CoinGecko `simple/price` for jito-staked-sol + solana | $81.60 / $63.54, 24h changes −3.80% / −3.92% |
| Coinstore public ticker SOLUSDT | close 63.548, bid 63.554, ask 63.561 |
| Coinstore symbol-config catalog (`POST /api/v2/public/config/spot/symbols`) | SOLUSDT present (tickSz 3, lotSz 3); JITOSOLUSDT **absent** (still pre-market) |

### 4.2 Connector-exchange JITOSOL listing check (rules out unpatched Pair@Exchange)

The bot can only use PW sources on exchanges it has connectors for: Azbit, Coinstore, FameEX, NonKYC, P2PB2B, StakeCube, XeggeX (`trade/trader_*.js`). Queried public market endpoints of XeggeX, NonKYC, Azbit, P2PB2B, FameEX for any JITOSOL market: **none list it** (StakeCube not queried; micro-exchange, no Solana LST support). Hence watching JITOSOL itself elsewhere is impossible without writing a new connector (see §7, future work).

### 4.3 Code-path verification for the cross-coin source (line refs on branch `dev`)

Traced the full `SOL/USDT@Coinstore` path through `mm_price_watcher.js` `setLowHighPrices` flow:

1. Order book fetched via `orderUtils.getOrderBookCached` for same-exchange sources (`mm_price_watcher.js:820-824`) — SOLUSDT book exists and is liquid. ✅
2. Source pair ≠ traded pair → cross-quote branch (`mm_price_watcher.js:865-911`): tries cross-market `USDT/USDT` (doesn't exist) → falls back to global conversion `convertCryptos('USDT','USDT', price)`.
3. `exchanger.js:50`: `getRate(from, to)` short-circuits `from === to → 1`. **Verified by reading the implementation** — the conversion is an exact identity, no Infoservice dependency, cannot return NaN for this path. ✅
4. Infoservice anomaly check (`mm_price_watcher.js:923-942`) compares source-derived range vs globally-converted range — for this path both sides are computed identically, so the check passes (see §7 for the honest implication). ✅
5. Coefficient applied **after** the anomaly check and **before** the deviation expansion (placement matters: applying before the check would trip the >% difference alarm). ✅
6. `/enable pw` front-door validation (`modules/commandTxs.js`): the only blocker for a different base coin was the single check at ~line 691; subsequent validations (same-pair guard, order-book availability probe, deviation %, policy, action) all pass for `SOL/USDT@Coinstore 3% smart prevent`. **Each validation read and confirmed.** ✅
7. `modules/configReader.js` validates known fields by type and does not reject unknown keys; a typed schema entry was still added for `pw_source_coefficient` so a malformed value (e.g., a quoted string) fails fast at startup. ✅

### 4.4 Syntax verification

`node --check` passes on all three modified files. (Runtime behavior testing happens on the VPS in pre-market — see §6 "Soak test"; pre-market is a zero-risk sandbox since no external party can trade.)

---

## 5. Implementation (the change under review)

**Design principle: dormant by default.** Every behavior change is gated on `pw_source_coefficient` being present and non-zero in `config.jsonc`. With the key absent, all three files behave byte-for-byte identically to upstream — verifiable by inspection.

### 5.1 `modules/configReader.js`

New optional config field:

```js
pw_source_coefficient: {
  type: Number,
  isRequired: false,
},
```

### 5.2 `modules/commandTxs.js` (~line 691, `/enable pw` validation)

```js
// A different base currency is allowed for pegged assets when pw_source_coefficient is set in the config,
// e.g., watch SOL/USDT while trading JITOSOL/USDT with price = SOL price * coefficient
if (pairObj.coin1 !== config.coin1 && !+config.pw_source_coefficient) {
```

(previously: `if (pairObj.coin1 !== config.coin1) {`)

### 5.3 `trade/mm_price_watcher.js` (after the Infoservice anomaly check, before deviation expansion)

```js
// Apply a fixed price coefficient for pegged assets, e.g., JITOSOL = SOL * exchange rate.
// Allows watching a source pair with a different base currency, as SOL/USDT@Coinstore while trading JITOSOL/USDT.
const pwSourceCoefficient = +config.pw_source_coefficient || 1;
if (pwSourceCoefficient !== 1) {
  l = l * pwSourceCoefficient;
  h = h * pwSourceCoefficient;
  log.log(`Price watcher: Applied the pw_source_coefficient of ${pwSourceCoefficient}: the range is from ${l.toFixed(coin2Decimals)} to ${h.toFixed(coin2Decimals)} ${config.coin2} now.`);
}
```

### 5.4 Related production change already live (context for reviewers)

`trade/trader_coinstore.js` `getMarkets()` carries a pre-market override for JITOSOLUSDT (decimals 2/2, precision 0.01, min order 0.01) because the pair's all-zero pre-market ticker breaks the connector's derive-decimals-from-ticker-digits heuristic. Deployed to production 2026-06-10; mirrored in this repo. Removable once the pair has live public trading data.

### 5.5 Activation (production)

```jsonc
// config.jsonc
"pw_source_coefficient": 1.2842,
```

```
/enable pw SOL/USDT@Coinstore 3% smart prevent
```

Expected log line each PW cycle: `Applied the pw_source_coefficient of 1.2842: the range is from ~79 to ~84 USDT` (at SOL ≈ 63.5).

---

## 6. Test & operations plan

**Soak test (today, pre-market — zero risk, no external participants):**
1. Deploy patches (anchor-asserted insert script; refuses to half-apply), `node --check` × 3, `pm2 restart`.
2. Add config key; `/enable pw SOL/USDT@Coinstore 3% smart prevent`.
3. Watch `pm2 logs` for ≥1–2 h: coefficient log line each cycle; range tracks Coinstore SOL × 1.2842; no `errorSettingPriceRange` / `isPriceActual=false` events beyond transient API blips.
4. Negative test: temporarily remove the config key + restart → `/enable pw SOL/USDT@Coinstore …` must be **rejected** (gate restored); re-add key.

**Launch-day checklist (2026-06-11):**
- Re-anchor the book to live fair value before opening (book was seeded near 91.5; fair ≈ 81.6 — `/clear JITOSOL/USDT all`, re-seed at market, let MM re-form inside the pegged range).
- Confirm fee exemption on self-trades (at 0.2%+0.2% the configured volume costs ~$4k/day; two `/balances` snapshots minutes apart must match to the cent).
- Confirm PW active and pegged in logs at open.

**Ongoing:**
- **Monthly** (or on staking-rate news): recompute coefficient — `curl CoinGecko jito-staked-sol,solana → ratio` — if it differs from config by >1%, update `config.jsonc` + `pm2 restart`. The +0.55%/month drift means even a skipped month stays well inside the 3% deviation.
- **Weekly cross-check** (Option 1, right-sized): compare CoinGecko JitoSOL price vs (Coinstore SOL × coefficient); >2% divergence ⇒ investigate before touching anything.

---

## 7. Known limitations & recommended hardening (adversarial reviewers: start here)

1. **The Infoservice anomaly check is inert for this source.** `mm_price_watcher.js:925-926` computes the "global" comparison range with the *same* identity conversion as the primary range, so the two always match for a cross-coin USDT-quoted source. Consequence: **if Coinstore's SOL/USDT book itself is manipulated, the pegged range follows it** and no internal alarm fires. Mitigations now: `smart` policy filters dust-order spoofing; manipulating SOL on a real exchange against professional arb flow is expensive and self-correcting. Recommended hardening (post-launch): compare the source's SOL price against the Infoservice's global SOL/USDT rate (the Infoservice *does* track SOL, unlike JITOSOL) and set `isPriceAnomaly` on >X% divergence — ~10 lines in the same function.
2. **The coefficient is a static config value.** If unmaintained for ~6+ months, drift exceeds the deviation margin and the fence sits slightly below NAV (bot sells marginally cheap). Fails *slow and soft*, not catastrophically — but put the monthly refresh on a calendar. Future: fetch the redemption rate from Jito/Sanctum APIs at PW-cycle time (adds an external dependency back; deliberately deferred).
3. **Coefficient is global, not per-source.** If someone later changes the PW source to a different pair while the key is set, the multiplier still applies. Acceptable for a single-pair bot; documented in the config comment. Hardening: scope the key per source-pair.
4. **`prevent` does not quote *for* you.** PW stops bad quotes; the MM/liquidity modules still derive prices from our own book. A sharp SOL drop means our standing orders get arbed during convergence (normal MM adverse selection, bounded per event by standing-order size). The peg bounds the *tail* risk, not routine MM risk.
5. **If the SOL/USDT order-book fetch fails repeatedly,** the PW marks the price not-actual and pauses MM order placement (existing bot behavior, by design — fail-closed). Watch logs for `Unable to get the order book for SOL/USDT` during the soak.
6. **Restart persistence relies on tradeParams**, which the bot persists itself (`mm_priceWatcherSource` etc. survive `pm2 restart`). The config key must exist before `/enable pw` is run; the negative test in §6 covers the gate.

---

## 8. File inventory for review

| File | Status | Change |
|---|---|---|
| `modules/configReader.js` | modified | +4 lines: `pw_source_coefficient` schema entry |
| `modules/commandTxs.js` | modified | 1 condition relaxed (gated on the config key) + comment |
| `trade/mm_price_watcher.js` | modified | +9 lines: coefficient application + log |
| `trade/trader_coinstore.js` | modified (already in production) | pre-market JITOSOLUSDT market-info override |
| `docs/COINSTORE_DEBUG_PRIMER.md` | moved from repo root | debugging history (auth, IPv6, listing gates) |
| `docs/JITOSOL_PAIR_DIAGNOSIS_2026-06-10.md` | moved from repo root | pair-discovery + decimals diagnosis |
| `docs/Screenshot 2026-05-13 *.png` | moved from repo root | Coinstore API-key dashboard evidence |
