# JitoSOL Price Anchor — Implementation Runbook

**Date:** 2026-06-11  
**Based on:** [JITOSOL_PRICE_ANCHOR_ADVERSARIAL_REVIEW_2026-06-10.md](./JITOSOL_PRICE_ANCHOR_ADVERSARIAL_REVIEW_2026-06-10.md)  
**Status:** Implementation in progress

---

## Executive Summary

The adversarial review identified two P0 safety issues in the JitoSOL price-anchor implementation:

1. **P0 — Unsafe default coefficient:** `+config.pw_source_coefficient || 1` silently defaults to `1` when the coefficient is absent, causing the bot to anchor JitoSOL at SOL price (≈5% undervalued at current exchange rates).
2. **P0 — No positive-value validation:** `0`, negative, `NaN`, and `Infinity` coefficient values all pass the existing guard in `commandTxs.js`.

Additionally, a better coefficient source was identified: the Jito stake-pool stats API (`https://kobe.mainnet.jito.network/api/v1/stake_pool_stats`) provides the on-chain redemption rate derived directly from stake-pool economics, making it tokenomically superior to any market price feed.

---

## Architecture Decision: Coefficient Source

### Selected: Jito Stake-Pool Stats API (Primary) + config fallback

| Source | Tokenomically Sound | Update Frequency | Single Endpoint | Verdict |
|---|---|---|---|---|
| Jito `stake_pool_stats` API | Yes — on-chain TVL/supply | ~2-3 day epoch cycles | Yes | **Primary** |
| Jupiter Price API | Market price only | Real-time (market noise) | Yes | Cross-check only |
| CoinGecko | Market price only | 1-5 min | Yes | Historical reference |
| Binance spot API | Not listed (JTO ≠ JitoSOL) | — | — | Not viable |
| `config.pw_source_coefficient` static | Operator-pinned, no auto-update | Manual | — | Fallback only |

### Formula

```
Exchange Rate = Total Pool Lamports / Pool Token Supply
coefficient   = stake_pool_stats.tvl[last].data / 1e9 / stake_pool_stats.supply[last].data
```

Jito docs confirm: the true on-chain exchange rate is the SPL stake-pool formula. JitoSOL started at 1:1 and increases by ~0.55%/month via staking + MEV rewards. Sane bounds: `[1.0, 1.6]` (generous 35-year headroom).

---

## Files Changed

| File | Change |
|---|---|
| `helpers/cryptos/jitoCoefficient.js` | **New** — Jito stats fetch, caching, validation, Jupiter cross-check |
| `trade/mm_price_watcher.js` | Harden coefficient logic: fail-closed for cross-base, use Jito helper |
| `modules/configReader.js` | Add positive-value validation for `pw_source_coefficient` |
| `modules/commandTxs.js` | Strengthen cross-base guard; reject zero/negative/NaN coefficients |
| `tests/jitosol-anchor-live.js` | New — live HTTP tests (no bot, no orders) |
| `tests/jitosol-anchor-logic.js` | New — mocked failure-mode and logic tests |

---

## Coefficient Helper: `helpers/cryptos/jitoCoefficient.js`

Responsibilities:
- Fetch `https://kobe.mainnet.jito.network/api/v1/stake_pool_stats`
- Extract the latest `tvl` (lamports) and `supply` entries
- Compute `coefficient = tvl_lamports / 1e9 / supply`
- Validate: must be finite, positive, within `[1.0, 1.6]`
- Cache the last-good value with a 6-hour refresh TTL
- Return structured status: `fresh | stale-usable | stale-expired | fetch-failed | missing`
- Expose Jupiter cross-check as a separate call (not on every PW cycle)

Caching rationale: The PW cycle for a same-exchange source runs every 3–7 seconds. Fetching Jito stats on every cycle would make harmless HTTP blips unnecessarily affect quoting. The coefficient changes at epoch speed (~2–3 days), so a 6-hour TTL gives 72–108 fetches per epoch — far more than needed while avoiding per-cycle fragility.

Fallback chain (runtime):
1. `jitoCoefficient.getCoefficient()` → live or cached Jito stats value
2. `config.pw_source_coefficient` → operator-pinned static value  
3. Fail closed via `errorSettingPriceRange()`

---

## Price Watcher Hardening: `mm_price_watcher.js`

### Current (P0 unsafe)

```js
// Line 946 — UNSAFE: defaults to 1 if coefficient is absent
const pwSourceCoefficient = +config.pw_source_coefficient || 1;
if (pwSourceCoefficient !== 1) {
  l = l * pwSourceCoefficient;
  h = h * pwSourceCoefficient;
}
```

### Replacement (fail-closed)

For cross-base sources (source coin1 ≠ traded coin1):
1. Call `jitoCoefficient.getCoefficient()` — primary source
2. If unavailable, try `config.pw_source_coefficient` as fallback (with positive check)
3. If neither: `errorSettingPriceRange()` — stop the cycle, do not use coefficient=1
4. Apply valid coefficient and log source, value, freshness, and derived range

For same-base sources (source coin1 === traded coin1):
- If `config.pw_source_coefficient` is explicitly set and positive: apply it (existing behaviour)
- Otherwise: coefficient is implicitly 1 — no action, preserves current same-base behaviour

---

## Config Validation Hardening: `modules/configReader.js`

Current schema entry for `pw_source_coefficient`:
```js
pw_source_coefficient: {
  type: Number,
  isRequired: false,
}
```

Needs added explicit validation after config load:
- Reject `0`, negative, `NaN`, or `Infinity` values with a clear startup error
- Log the validated value at startup when present

---

## Command Validation Hardening: `modules/commandTxs.js`

Current guard (line 693):
```js
if (pairObj.coin1 !== config.coin1 && !+config.pw_source_coefficient) {
  // reject if cross-base and no static coefficient
}
```

With the Jito helper in place, static `config.pw_source_coefficient` is no longer the only valid coefficient path. The command guard should:
- Warn if a cross-base source is set but neither `pw_source_coefficient` nor a live Jito stats fetch succeeds
- Still reject if both paths fail (early validation)

In practice: the new runtime fail-closed in `mm_price_watcher.js` is the safety net. The `commandTxs.js` check is the early gate that prevents a mis-configured source from being persisted to `tradeParams`.

---

## Test Plan

### Live HTTP tests (`tests/jitosol-anchor-live.js`)

No bot process, no orders, no VPS mutations.

1. **Jito stats source** — fetch and validate structure, non-empty arrays, positive TVL/supply, coefficient in `[1.0, 1.6]`
2. **Jupiter cross-check** — fetch JitoSOL and SOL prices, verify ratio within 1% of Jito stats coefficient  
3. **Coinstore SOL source** — fetch SOLUSDT ticker and depth, verify bid/ask are positive and ordered
4. **Binance clarification** — verify JTOUSDT exists and JITOSOLUSDT does not on Binance spot, document that JTO ≠ JitoSOL

### Logic and failure-mode tests (`tests/jitosol-anchor-logic.js`)

These use injected state and do not require live HTTP.

1. **Good coefficient** — `computeFromStatsResponse()` returns correct value from valid data
2. **Empty arrays** — returns null
3. **Zero supply** — returns null  
4. **Negative TVL** — returns null
5. **Out-of-bounds coefficient** — returns null (below 1.0 or above 1.6)
6. **NaN/Infinity** — returns null
7. **Cache fresh** — `getCoefficient()` returns fresh status and does not refetch within TTL
8. **Cache stale-usable** — triggers background refresh, returns last-good value
9. **Cache expired** — blocks on live fetch
10. **Never fetched + fetch fails** — returns `missing` status with null coefficient

---

## VPS Transfer and Deployment Runbook

### Prerequisites

- You have SSH access to the VPS as the bot user (typically `adamant`)
- Your patched local branch has passing tests
- You have a private GitHub/GitLab repo that can serve as the remote for your fork

### Step 1: Prepare local changes

```bash
# Local machine: ensure you are on the branch with the changes
git status
git log --oneline -5

# Run live HTTP tests first (no bot needed, just internet)
node tests/jitosol-anchor-live.js

# Run logic tests
node tests/jitosol-anchor-logic.js
```

### Step 2: Push to your private remote

```bash
# If you haven't set up a private remote yet:
git remote add myfork git@github.com:YOUR_USERNAME/YOUR_FORK.git

# Push the branch
git push myfork HEAD

# Or push to main if you're merging:
git push myfork main
```

### Step 3: SSH into the VPS and backup live-only files

```bash
ssh YOUR_VPS_USER@YOUR_VPS_IP

cd /path/to/your/tradebot

# Backup config and tradeParams before touching code
cp config.jsonc config.jsonc.bak.$(date +%Y%m%d%H%M%S)
cp trade/settings/tradeParams_coinstore.js trade/settings/tradeParams_coinstore.js.bak.$(date +%Y%m%d%H%M%S)
```

### Step 4: Update the code on the VPS

**Option A: Your VPS bot folder is already tracking your fork (preferred)**

```bash
git status                         # Check current state
git remote -v                      # Verify remote URL points to your fork
git pull origin main               # Or whatever branch name
npm i                              # Install any new dependencies
```

**Option B: VPS bot folder tracks the original upstream (first migration)**

```bash
# Add your fork as a new remote
git remote add myfork git@github.com:YOUR_USERNAME/YOUR_FORK.git
git fetch myfork main

# Create a local tracking branch and switch to it
git checkout -b myfork-main myfork/main
npm i
```

**Option C: git is awkward — manual patch approach (fallback, not recommended long-term)**

```bash
# On local machine: generate a patch
git diff origin/main HEAD > ~/jitosol-anchor.patch

# Transfer to VPS
scp ~/jitosol-anchor.patch YOUR_VPS_USER@YOUR_VPS_IP:/tmp/

# On VPS
cd /path/to/your/tradebot
git apply /tmp/jitosol-anchor.patch
npm i
```

### Step 5: Verify on VPS before restarting

```bash
# Syntax check the new files
node --check helpers/cryptos/jitoCoefficient.js
node --check trade/mm_price_watcher.js
node --check modules/configReader.js
node --check modules/commandTxs.js

# Run live HTTP tests on VPS (requires internet)
node tests/jitosol-anchor-live.js

# Run logic tests
node tests/jitosol-anchor-logic.js
```

### Step 6: Restart via PM2

```bash
pm2 stop tradebot

# Optional: restore backed-up config if needed
# cp config.jsonc.bak.TIMESTAMP config.jsonc

pm2 restart tradebot
pm2 logs tradebot --lines 100
```

Look for:
- No startup errors
- `Config reader: pw_source_coefficient` validation messages (if coefficient is in config)
- No `failed to fetch Jito` errors on first boot (live connection should succeed)

### Step 7: Enable the price watcher via ADAMANT

Send to your bot's ADAMANT address:

```
/enable pw SOL/USDT@Coinstore 3% smart prevent
```

Check logs for:
- `JitoCoefficient: Updated JitoSOL/SOL coefficient to 1.XXXXXX from Jito stake_pool_stats.`
- `Price watcher: Applied cross-base coefficient 1.XXXXXX → range X.XX–X.XX USDT.`
- Verify the range is centered near `SOL_price × coefficient`, not raw SOL price

### Step 8: Validate the range

A quick sanity check: if SOL is $180 and the coefficient is ~1.18, JitoSOL should be anchored near $212, not $180.

```
/info pw
```

Confirm the displayed range is above raw SOL price by approximately the coefficient percentage.

---

## Rollback Plan

If the bot behaves incorrectly after the update:

```bash
# On VPS
pm2 stop tradebot

# Restore code
git checkout HEAD~1  # or git stash, or git revert

# Restore config
cp config.jsonc.bak.TIMESTAMP config.jsonc
cp trade/settings/tradeParams_coinstore.js.bak.TIMESTAMP trade/settings/tradeParams_coinstore.js

npm i
pm2 restart tradebot
```

---

## Acceptance Criteria

- [ ] `jitoCoefficient.getCoefficient()` returns a fresh value within `[1.0, 1.6]` from Jito API
- [ ] Cross-base PW source fails closed (no quoting) when both Jito API and config coefficient are unavailable
- [ ] Cross-base PW source never silently applies coefficient = 1
- [ ] `config.pw_source_coefficient = 0` or negative is rejected at startup with a clear error message
- [ ] Live HTTP tests pass: Jito stats, Jupiter cross-check, Coinstore SOL
- [ ] Logic tests cover all failure modes: missing, stale, malformed, out-of-bounds data
- [ ] VPS runbook provides step-by-step transfer and rollback instructions
- [ ] No production orders are placed during testing phase
