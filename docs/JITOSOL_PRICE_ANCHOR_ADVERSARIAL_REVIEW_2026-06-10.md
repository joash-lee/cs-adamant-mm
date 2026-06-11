# JitoSOL Price Anchor - Adversarial Review

**Date:** 2026-06-10  
**Scope:** Review of `JITOSOL_PRICE_ANCHOR_CTO_REVIEW_2026-06-10.md` and the proposed local code changes  
**Mode:** Testing and adversarial validation only. No runtime code changed in this review.  
**Verdict:** Business idea is sound. Current implementation is not launch-safe until the fail-open cases are fixed.

---

## 1. Plain-English Summary

JitoSOL should trade close to:

```text
JitoSOL fair price = SOL price x JitoSOL/SOL exchange rate
```

The proposed plan uses Coinstore's live `SOL/USDT` price, multiplies it by a fixed coefficient, and tells the bot to keep JitoSOL orders inside that derived range.

That is a good idea. It is much safer than manually updating a static `78-105 USDT` range once or twice per week.

The problem is the current code can fail in dangerous ways:

- If the multiplier config disappears after the bot has already saved `SOL/USDT@Coinstore` as the watcher source, the bot can keep running with a multiplier of `1`.
- That would anchor JitoSOL near raw SOL price, around `63 USDT`, instead of fair JitoSOL price, around `81 USDT`.
- A bad or negative multiplier can also pass startup type validation because the code checks only "is this a number?", not "is this a safe positive number?"

For live funds, this needs to fail closed. If the bot cannot prove it has a valid coefficient for a cross-coin source, it should stop quoting instead of guessing.

---

## 2. Executive Summary

### Recommendation

Proceed with **Option 2: SOL peg via the existing Price Watcher**, but do not launch the current implementation unchanged.

### Why Option 2 is still the right strategy

- JitoSOL economically tracks SOL multiplied by the JitoSOL/SOL exchange rate.
- Coinstore's `SOL/USDT` book is live, liquid enough for this use case, and already available through the bot's existing Coinstore connector.
- It avoids new operational dependencies such as cron, an ADAMANT sender account, plaintext passphrases, and message-delivery risk.
- It reacts at bot-cycle speed instead of human-update speed.

### Why the current implementation is not launch-safe

The selected design depends on this invariant:

```text
If source base coin != traded base coin,
then a valid positive coefficient must be present,
or the bot must fail closed.
```

The current code enforces that invariant only when the user runs `/enable pw`. It does not enforce it every time the Price Watcher recalculates the range.

That gap matters because `tradeParams` persist across restarts.

---

## 3. Decision Map

```text
Problem:
  JitoSOL public launch exposes stale manual range risk.

Options:

  1. External updater
     CoinGecko -> cron/script -> ADAMANT command -> bot manual range
     Status: rejected as primary
     Reason: more moving parts, secrets, ADM fees, message delivery dependency

  2. SOL peg inside Price Watcher
     Coinstore SOL/USDT book -> bot PW -> multiply by coefficient -> JitoSOL range
     Status: selected, but implementation needs hardening
     Reason: fastest, simplest operationally, uses existing connector

  3. Manual weekly range
     Human updates range 1-2x/week
     Status: rejected as sole mechanism
     Reason: SOL can move faster than humans update; stale fence creates arb risk
```

---

## 4. Runtime Flow

Target production command:

```text
/enable pw SOL/USDT@Coinstore 3% smart prevent
```

Expected intended flow:

```text
Coinstore SOL/USDT order book
        |
        v
Bot reads bid/ask or smart bid/ask
        |
        v
Multiply by pw_source_coefficient
        |
        v
Expand by 3% deviation
        |
        v
Set JitoSOL/USDT allowed range
        |
        v
Other modules avoid placing orders outside that range
```

Current dangerous flow:

```text
Config key missing after restart
        |
        v
tradeParams still says source = SOL/USDT@Coinstore
        |
        v
Runtime defaults coefficient to 1
        |
        v
Bot anchors JitoSOL to raw SOL price
        |
        v
JitoSOL range is materially wrong
```

---

## 5. Live Market Evidence

Live checks performed during review:

```text
CoinGecko:
  JitoSOL/USD = 81.58
  SOL/USD     = 63.55
  Ratio       = 1.2837

Coinstore SOLUSDT ticker:
  Bid/ask around 63.50-63.58

Coinstore SOLUSDT depth:
  100 bid levels
  100 ask levels
  Strict spread observed around 0.07-0.09%

ADAMANT Infoservice:
  SOL/USD available
  JITOSOL/USD not available
```

Computed range using coefficient `1.2842` and 3% deviation:

```text
Strict Coinstore SOL range:
  SOL bid/ask                 ~= 63.50-63.56
  After JitoSOL coefficient   ~= 81.55-81.63
  Final range with 3% buffer  ~= 79.11-84.07

Smart depth simulation:
  Smart SOL bid/ask           ~= 63.394-63.727
  After JitoSOL coefficient   ~= 81.41-81.84
  Final range with 3% buffer  ~= 78.97-84.29
```

This supports the business premise: the selected peg produces a plausible JitoSOL range near current fair value.

---

## 6. Adversarial Findings

### P0 - Runtime coefficient default is unsafe

The code currently defaults to coefficient `1`:

```js
const pwSourceCoefficient = +config.pw_source_coefficient || 1;
```

That is safe only when source base coin equals traded base coin. It is unsafe for `SOL/USDT` while trading `JITOSOL/USDT`.

Why it matters:

- `/enable pw` validation only runs when the command is issued.
- The persisted watcher source can survive restarts.
- If the config key is later removed, missing, typoed, or not deployed, runtime keeps operating with coefficient `1`.
- That makes the bot's safety fence wrong while still looking "active."

Required behavior:

```text
if source base coin != traded base coin:
  if coefficient is not a positive number:
    fail closed and mark price not actual
  else:
    apply coefficient
```

### P0 - Coefficient has no positive-value validation

`modules/configReader.js` validates `pw_source_coefficient` as a `Number`, but not as a positive number.

Bad examples that should be rejected:

```jsonc
"pw_source_coefficient": -1.2842
"pw_source_coefficient": 0
```

The `/enable pw` gate rejects `0`, but a negative number is truthy and can pass the gate. Runtime then applies it after the existing positive-range check.

Required behavior:

```text
coefficient must be finite and > 0
optional: coefficient should be within a sane range for this pair, e.g. 1.0-1.6
```

### P1 - Coefficient is global, not source-scoped

Once set in config, the coefficient applies to any Pair@Exchange source.

That creates a future operator hazard:

```text
Operator changes watcher source later
        |
        v
Coefficient remains in config
        |
        v
New source gets multiplied accidentally
```

Required behavior:

Prefer a source-scoped config shape, or at minimum validate the intended source:

```text
coefficient mode allowed only for:
  traded pair: JITOSOL/USDT
  source: SOL/USDT@Coinstore
```

### P1 - The anomaly check does not protect this peg

The existing anomaly check compares the source-derived range to a global conversion. For `USDT -> USDT`, that conversion is identity, so the check does not detect whether Coinstore SOL is far from global SOL.

This is already acknowledged in the original plan, but should not be deferred for live funds.

Recommended hardening:

```text
Coinstore SOL/USDT price
        |
        v
Compare against ADAMANT Infoservice SOL/USD adjusted by USDT/USD
        |
        v
If deviation > threshold, mark price anomaly and stop new quotes
```

This is practical because ADAMANT Infoservice already returned `SOL/USD`.

### P2 - Operational docs need to distinguish gate tests from runtime tests

The proposed negative test says:

```text
remove config key + restart -> /enable pw SOL/USDT@Coinstore must be rejected
```

That is necessary but incomplete.

The more important negative test is:

```text
1. Enable SOL/USDT@Coinstore while coefficient exists.
2. Confirm tradeParams persist the source.
3. Remove coefficient.
4. Restart.
5. Confirm runtime fails closed before setting any SOL-priced JitoSOL range.
```

---

## 7. Business Logic Review

### What is sound

- JitoSOL should track SOL multiplied by the stake-pool exchange rate.
- The coefficient changes slowly compared with SOL price.
- Anchoring to Coinstore SOL avoids needing a brand-new JitoSOL connector or external command service.
- Manual weekly updates are too slow for public launch risk.

### What needs more care

The plan uses CoinGecko `JitoSOL / SOL` ratio as the coefficient. That is a market ratio, not necessarily the official on-chain redemption rate.

For launch, this may be acceptable because the 3% deviation buffer is wide. For better long-term correctness, use an official Jito/Sanctum/on-chain redemption-rate source if available, and use CoinGecko only as a cross-check.

### Failure mode comparison

```text
Manual range stale:
  Risk speed: fast
  Human burden: recurring
  Failure mode: public arbs farm stale quotes

External updater:
  Risk speed: medium
  Human burden: setup and monitoring
  Failure mode: cron/message/API silently dies

SOL peg:
  Risk speed: low after hardening
  Human burden: monthly coefficient check
  Failure mode: source manipulation or bad config
```

---

## 8. Code Execution Review

### What matched the plan

- Coefficient is applied after the existing anomaly check.
- Coefficient is applied before the 3% deviation expansion.
- `USDT -> USDT` conversion short-circuits to identity in the exchanger.
- Coinstore public ticker and depth endpoints return live `SOLUSDT` data.
- `JITOSOLUSDT` appears in Coinstore tickers but still has all-zero pre-market values.

### What did not match the safety claim

The plan says behavior is "dormant by default" when `pw_source_coefficient` is absent.

That is true for the `/enable pw` command path. It is not true for the runtime path after the source has already been persisted.

The runtime code should not infer "missing coefficient means coefficient 1" when the source base differs from the traded base.

---

## 9. Test Evidence

### Passed

```text
node --check modules/configReader.js
node --check modules/commandTxs.js
node --check trade/mm_price_watcher.js
node --check trade/trader_coinstore.js
```

All four syntax checks passed.

### Live API checks passed

```text
CoinGecko simple price:
  jito-staked-sol and solana returned live USD prices

Coinstore ticker:
  SOLUSDT returned live bid/ask
  JITOSOLUSDT returned present but all-zero pre-market ticker

Coinstore depth:
  SOLUSDT returned live 100-level book

ADAMANT Infoservice:
  SOL/USD returned
```

### Blocked or failed

```text
npm test -- --runInBand
```

Failed because Jest could not load:

```text
Cannot find module '@babel/runtime/helpers/interopRequireDefault'
```

Focused helper import was also blocked before dependency installation because `jsonminify` was missing. After dependency install, Jest still failed on the Babel runtime helper.

ESLint on touched files reported existing style/lint problems unrelated to the new coefficient lines:

```text
modules/commandTxs.js:
  prefer-const / no-unused-vars

trade/mm_price_watcher.js:
  no-unused-vars

trade/trader_coinstore.js:
  unused eslint-disable directive
```

Firecrawl web search for an official Jito redemption-rate API failed with `401`, so this review did not verify an official redemption-rate endpoint.

---

## 10. Required Fixes Before Live Funds

### Must fix

1. Add runtime fail-closed validation in `mm_price_watcher.js`.
   - If source base coin differs from traded base coin, require a finite positive coefficient.
   - If missing or invalid, call the same error path used for failed order-book/rate setup.

2. Validate coefficient value, not just type.
   - Reject negative, zero, `NaN`, and infinite values.
   - Consider a sanity range for JitoSOL, such as `1.0 <= coefficient <= 1.6`.

3. Add a runtime negative test.
   - Enable source with coefficient.
   - Persist source.
   - Remove coefficient.
   - Restart.
   - Confirm bot fails closed and does not set a raw-SOL JitoSOL range.

### Strongly recommended

4. Scope coefficient to the intended source.
   - Avoid a global multiplier that can accidentally affect future watcher sources.

5. Add SOL source anomaly check.
   - Compare Coinstore SOL against global SOL from ADAMANT Infoservice.
   - Block if divergence exceeds a threshold.

6. Add a launch runbook step to verify the actual runtime range.
   - Expected live range should be near CoinGecko JitoSOL.
   - It should not be near raw SOL.

---

## 11. Human Launch Checklist

Before public launch:

```text
[ ] Code has runtime fail-closed guard for cross-base watcher source.
[ ] Coefficient is validated as positive and sane.
[ ] Negative restart test passes.
[ ] Coinstore SOL price is close to global SOL.
[ ] Runtime JitoSOL range is close to live JitoSOL fair value.
[ ] Existing stale JitoSOL orders are cleared or re-anchored.
[ ] Fee-exemption/self-trade cost is confirmed with balance snapshots.
[ ] Logs show the coefficient-applied range every PW cycle.
[ ] Alerts/watch procedure exists for "price not actual" and "price anomaly."
```

Expected sanity check:

```text
If SOL ~= 63.55
and coefficient ~= 1.2842
then center JitoSOL ~= 81.60
and 3% range ~= 79.15-84.05
```

If the bot shows a range centered near `63`, stop immediately.

---

## 12. Final Verdict

```text
Business logic:
  Sound. SOL peg is the best of the three options.

Code execution:
  Not launch-safe yet. Current runtime can fail open after restart/config drift.

Launch decision:
  Do not launch unchanged.
  Fix fail-closed runtime validation first.
```

The plan is directionally right. The current code needs one safety invariant enforced in the runtime path, not only in the command path:

```text
Cross-base price watcher source + missing/invalid coefficient = stop quoting.
```

