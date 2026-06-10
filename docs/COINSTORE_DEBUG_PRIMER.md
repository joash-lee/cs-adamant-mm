# Coinstore Tradebot Debugging Primer

> Context document for debugging the ADAMANT tradebot's Coinstore exchange integration.
> Last updated: **2026-05-13** — auth resolved; pair-listing remains the blocker.
>
> ⚠️ **UPDATE 2026-06-10**: Gate B has partially opened — `JITOSOLUSDT` now appears in Coinstore's public tickers (instrumentId 1906) and `JITOSOL` in public assets, but the pair is still absent from the open-for-trade symbol catalog (pre-market state). The bot's "pair not found" errors are caused by its **never-refreshed startup market cache** — fix is `pm2 restart tradebot`. Gate C is also resolved (wallet funded). See **`JITOSOL_PAIR_DIAGNOSIS_2026-06-10.md`** for the full diagnosis, the "decimals trap" that hits after restart, and the step-by-step plan.

---

## 0. Where We Stand Right Now (2026-05-13)

**Three functional gates. Status:**

| Gate | Status | Owner |
|---|---|---|
| (A) Authentication / signature | ✅ **WORKING** | Resolved 2026-05-13 |
| (B) JITOSOL/USDT listed on Coinstore | ❌ **Not listed** | Coinstore / company backend team |
| (C) Wallet funded with working capital | ❌ **Effectively zero** (1e-7 USDT) | User, after Gate B opens |

**Root cause of the August 2025 `1401 Unauthorized` failures — now resolved:**

The VPS (`srv935443`) is **dual-stack** (has both IPv4 and IPv6). Node.js / axios default to IPv6 when AAAA records are available. The Coinstore API key whitelist contained only the IPv4 address (`31.97.71.71`), but the bot's outbound traffic to Coinstore was leaving on the **IPv6** address (`2a02:4780:5e:64b::1`). Public Coinstore endpoints don't check source IP (so tickers/markets/currencies worked), but every authenticated call was rejected with `1401`.

**Fix applied**: the IPv6 address was added to the Coinstore API key's IP whitelist alongside the IPv4. No code change, no Node flag, no system change. `/balances` now returns successfully.

**Next blocker**: JITOSOL/USDT is not a tradable market on Coinstore yet. Bot startup logs still print `orderUtils/parseMarket: Cannot get info about the JITOSOL/USDT market/contract`. Until Coinstore lists the pair, every pair-specific call will either return `3011 Symbol not found` (authenticated calls like `placeOrder`, `getOpenOrders`) or `undefined` / NaN (public lookups like `getRates`). This is **not fixable bot-side** — it requires Coinstore to enable spot trading for the asset.

**Suggestive signal worth noting**: a `/balances` response on 2026-05-13 returned **two** account entries: `1e-7 USDT` and one logged as `0 undefined`. The "undefined" entry is likely JITOSOL — Coinstore appears to have an internal asset record for it (suggesting deposit-side infrastructure exists), but it's not in the public `/v3/public/assets` list, so the bot can't name it. This is consistent with a partial listing-in-progress state. Re-verify after Coinstore announces the listing.

---

## 1. The Setup

- **Repo**: https://github.com/Adamant-im/adamant-tradebot (cloned locally)
- **Exchange**: Coinstore (https://www.coinstore.com)
- **Trading pair (current)**: JITOSOL/USDT (was ODOS/USDT in the August 2025 run)
- **Bot version**: 7.0.1 (repo dev branch)
- **Deployment**: VPS `srv935443` (Hostinger or similar), managed via pm2 (`pm2 start --name tradebot app.js`)
- **VPS IPs**: IPv4 `31.97.71.71`, IPv6 `2a02:4780:5e:64b::1` (both must be in Coinstore whitelist)
- **Installation guide**: https://marketmaking.app/cex-mm/installation/
- **Quick start guide**: https://marketmaking.app/cex-mm/quick-start/
- **Coinstore API docs**: https://coinstore-openapi.github.io/en/#introduction

---

## 2. History of Failures and Fixes

### Run 1 — August 2025 (pair: ODOS/USDT)
All authenticated calls failed with `1401 Unauthorized`. Public calls worked. Diagnosed at the time as "auth failure of unknown cause." **Root cause was IPv6 leak (see Section 0 / Section 5)** — not understood until the 2026-05-13 session.

### Run 2 — 2026-05-13 (pair: JITOSOL/USDT)
- Same VPS, same code, new pair.
- Initial run: `/balances` still returned `1401 Unauthorized`. Public endpoints worked. Same August symptom.
- Diagnostic `curl -4 / -6 / ifconfig.me / icanhazip.com` revealed the VPS's default outbound was IPv6.
- User added the IPv6 address `2a02:4780:5e:64b::1` to the Coinstore API key whitelist.
- Restart (`pm2 restart tradebot`): `/balances` now succeeds. Auth fully resolved.
- JITOSOL/USDT remains unlisted on Coinstore — `parseMarket` warnings persist as expected. MM cannot run meaningfully until listed.

---

## 3. The Three-Gate Mental Model

Every Coinstore call goes through two independent gates inside the exchange, plus a third real-world gate for actually trading:

**Gate A — Auth/Signature**: Does the request carry a valid `X-CS-APIKEY` + `X-CS-SIGN` + `X-CS-EXPIRES` from a whitelisted IP, with `read`/`trade` permissions?
- Failure code: `1401` (whitelist/expiry) or `401` (key/signature) or `3005` (signature generation)
- Affects: every authenticated endpoint (`/balances`, `/orders`, `placeOrder`, `cancelOrder`)

**Gate B — Symbol/Asset Existence**: Does the symbol or asset exist in Coinstore's spot trading catalog?
- Failure code: `3011 Symbol not found`, or for public calls: missing entry in tickers / `/v3/public/assets` → `undefined` / NaN downstream
- Affects: anything pair-specific (`getRates`, `getMarkets`, `getCurrencies`, `getFees`, `placeOrder`, `getOpenOrders(pair)`)
- **Pair-agnostic authenticated calls (`/balances`) are NOT affected by Gate B** — this is why `/balances` is the cleanest auth canary

**Gate C — Wallet Funded**: Even with A and B green, the bot can't quote orders without working capital.

| Call | Gate A | Gate B | Gate C |
|---|---|---|---|
| Public ticker / markets / assets | — | — | — |
| `/balances` | required | not required | not required |
| `/orders JITOSOL/USDT` | required | required | not required |
| `placeOrder` | required | required | required |
| `/account` (fees) | required | partially (USDT side works, JITOSOL row missing) | not required |

---

## 4. Key Files in the Repo

### API client (low-level HTTP calls)
**`trade/api/coinstore_api.js`**

- `protectedRequest(type, path, data)` — authenticated calls. Builds signature, sets headers `X-CS-APIKEY`, `X-CS-EXPIRES`, `X-CS-SIGN`.
- `publicRequest(type, path, params)` — unauthenticated calls.
- `getSignature(secret, timestamp, payload)` — HMAC-SHA256 two-step signature (lines 159–168).
- `handleResponse(...)` — parses API responses, success = `httpCode === 200 && data.code === 0`.

**Endpoints called:**

| Method | Code path | Endpoint | Auth | Status |
|---|---|---|---|---|
| `getBalances()` | line 195 | `POST /api/spot/accountList` | Private | ✅ Working (2026-05-13) |
| `getOrders(symbol)` | line 209 | `GET /api/v2/trade/order/active` | Private | Untested with listed pair |
| `getOrder(orderId)` | line 223 | `GET /api/v2/trade/order/orderInfo` | Private | Untested |
| `addOrder(...)` | line 252 | `POST /api/trade/order/place` | Private | Blocked by Gate B |
| `cancelOrder(orderId, symbol)` | line 268 | `POST /api/trade/order/cancel` | Private | Untested |
| `cancelAllOrders(symbol)` | line 282 | `POST /api/trade/order/cancelAll` | Private | **DEAD** — endpoint removed. Never called from prod code |
| `currencies()` | line 292 | `GET /v3/public/assets` | Public | ✅ Alive 2026-05-13 (1643 currencies returned) |
| `ticker()` | line 301 | `GET /api/v1/market/tickers` | Public | ✅ Working (484 markets) |
| `orderBook(symbol)` | line 315 | `GET /api/v1/market/depth/{symbol}` | Public | Works for listed pairs only |
| `getTradesHistory(symbol)` | line 329 | `GET /api/v1/market/trade/{symbol}` | Public | Works for listed pairs only |

### Trader adapter (high-level business logic)
**`trade/trader_coinstore.js`**

- `getBalances()` (line 234)
- `getOpenOrders(pair)` (line 282)
- `placeOrder(side, pair, price, coin1Amount, limit, coin2Amount)` (line 420)
- `cancelOrder(orderId, side, pair)` (line 563)
- `getMarkets(pair)` (line 103) — builds market info from tickers at startup. Returns null-y fields for unlisted pairs (see Section 7).
- `getCurrencies(coin)` (line 41) — loads currency info from `/v3/public/assets`
- `getFees(coinOrPair)` (line 773) — loads fee data from `/v3/public/assets`
- `getRates(pair)` (line 638) — throws / returns undefined if pair not in tickers
- `getOrderBook(pair)` (line 674)
- `formatPairName(pair)` (line 824) — `"JITOSOL/USDT"` → `{coin1: "JITOSOL", coin2: "USDT", pairPlain: "JITOSOLUSDT"}`

---

## 5. Root Causes — Ranked by Real-World Frequency

### Priority 0 — Dual-stack IPv6 leak (THE one that caught us)

**Symptom**: All authenticated calls return `1401 Unauthorized`. Public calls work. Looks identical to a wrong-key or wrong-whitelist failure.

**Cause**: VPS has both IPv4 and IPv6. Node.js (and `curl` without flags) prefer IPv6 when AAAA records exist. Coinstore's whitelist UI typically only stores IPv4 entries. Outbound bot traffic exits on IPv6 → Coinstore sees an un-whitelisted source IP → `1401`.

**Diagnostic recipe** (single fastest way to detect):
```bash
curl -s -4 https://api.ipify.org && echo            # your IPv4
curl -s -6 https://api.ipify.org && echo            # blank if no v6
curl -s https://ifconfig.me && echo                 # what the internet ACTUALLY sees
curl -s https://icanhazip.com                       # second opinion
curl -s -4 https://api.coinstore.com/api/v1/market/tickers -o /dev/null -w "v4 HTTP %{http_code}\n"
curl -s -6 https://api.coinstore.com/api/v1/market/tickers -o /dev/null -w "v6 HTTP %{http_code}\n"
```
If `ifconfig.me` returns a v6 address but your Coinstore whitelist has only v4 → this is the bug.

**Fixes (in order of preference):**
1. **Add the IPv6 to Coinstore whitelist** alongside the v4. (This is what we did 2026-05-13.) No code/system change needed.
2. **Force Node to prefer IPv4**: `pm2 delete tradebot && pm2 start app.js --name tradebot --node-args="--dns-result-order=ipv4first" && pm2 save`. This makes Node resolve A records first.
3. **Patch axios to use `family: 4`** in `coinstore_api.js`. Code change but explicit.
4. **Disable IPv6 system-wide** (`sysctl net.ipv6.conf.all.disable_ipv6=1`). Heavy hammer; affects everything on the VPS.

### Priority 1 — Other authentication causes (only if Priority 0 ruled out)

1. **API key/secret mismatch** in `config.jsonc`. Eyeball for whitespace/smart quotes. Must remain quoted strings in JSONC.
2. **API key permissions**: must have `read` + `trade`. Disable `withdraw`.
3. **Clock skew**: signature rotates every 30 seconds (`floor(timestamp / 30000)`). If VPS clock is off > 30s, signatures invalid. Check with `timedatectl status` and `date -u`.
4. **Key revoked/disabled on Coinstore dashboard.** Regenerate fresh key as a last resort.

### Priority 2 — Symbol/asset not listed (CURRENT BLOCKER for JITOSOL/USDT)

**Canonical signal in logs:**
```
orderUtils/parseMarket: Cannot get info about the JITOSOL/USDT market/contract on the Coinstore exchange. Returning default values for decimal places.
```
This warning fires every time anything touches the pair (typically twice at startup; once per `/balances` or `/orders` invocation).

**Behavior with unlisted pair:**
- `getMarkets()` falls back to defaults, bot starts but with broken market metadata.
- `getRates()` returns undefined → NaN in `/amount` and `/interval` outputs.
- `getCurrencies('JITOSOL')` and `getFees('JITOSOL')` silently return nothing — `/balances` log line will show the coin name as `undefined`.
- `placeOrder` returns `3011 Symbol not found`.

**Resolution**: not fixable bot-side. Requires Coinstore to enable spot trading for the asset. Coordinate with the company backend / Coinstore listings contact.

### Priority 3 — `/v3/public/assets` endpoint health

Confirmed **alive** 2026-05-13 (returned 1643 currencies). The Aug 2025 concern that it might be dead has not materialized.

If it ever dies, the replacement is `POST /api/v2/public/config/spot/symbols` (requires auth). A code change in `coinstore_api.js` + `trader_coinstore.js` would be needed.

### Priority 4 — Dead `cancelAll` endpoint (not urgent)

`POST /api/trade/order/cancelAll` has been removed from Coinstore's API but is **never called from production code**. The `/clear all` bot command uses `orderCollector.clearAllOrders()` which cancels orders one-by-one via `cancelOrder()`. No immediate impact.

---

## 6. Auth-Failure Cascade Signature (so you recognize it instantly)

A single `1401` causes a chain of three log lines (because the connector code assumes a successful array response):

```
warn ... Coinstore processed a request to .../api/spot/accountList with data { No parameters }, but with error: 200 OK, [1401] Unauthorized. Resolving…
warn ... Error while processing getBalances(nonzero: false) request results: {"message":"Unauthorized","code":1401,...}. TypeError: balances.filter is not a function
error ... Error in balanceHelper() of utils.js module: TypeError: Cannot read properties of undefined (reading 'find')
error ... Error in getBalancesCached() of commandTxs.js module: TypeError: Cannot read properties of undefined (reading 'coin1s')
```

All three errors are symptoms of the same `1401`. Don't chase them as separate bugs — fix Gate A and they all vanish together.

---

## 7. Pre-existing Code Issues (documented, not blocking)

### `getMarkets()` returns incomplete data
`trader_coinstore.js:103-170` builds market info from the tickers endpoint, which doesn't include lot size, min trade amount, or coin name splits. Result fields:
- `pairReadable: undefined`
- `coin1: undefined`, `coin2: undefined`
- `coin1MinAmount: null`, `coin2MinAmount` missing, `minTrade: null`
- `status: null`

**Impact**: order amount validation at `trader_coinstore.js:485-493` is silently skipped (`number < null` is always false). Orders below exchange minimums get through and Coinstore rejects them. Error messages contain "undefined" for coin names. Pre-existing; doesn't prevent trading when the pair is listed.

### `/v3/public/assets` is undocumented
The `currencies()` method calls an endpoint the original developer noted as undocumented. Still alive as of 2026-05-13. If it ever dies, `getCurrencies()` and `getFees()` fail silently; trading is unaffected.

### Potential consolidation fix (not needed now)
Coinstore's `POST /api/v2/public/config/spot/symbols` endpoint returns `symbolCode`, `tradeCurrencyCode`, `quoteCurrencyCode`, `tickSz`, `lotSz`, `minLmtSz`, `minMktVa`, `makerFee`, `takerFee`, `openTrade`. A single migration could replace the undocumented `currencies()` call AND populate the null `getMarkets()` fields. Touches only `coinstore_api.js` + `trader_coinstore.js`.

### ADAMANT messenger health-check noise
Logs frequently show `Failed to get Txs in check() of checkerTransactions.js module. undefined.` and `[ADAMANT js-api] Health check: Node ... hasn't returned its status`. These are **ADAMANT messenger network health**, completely unrelated to Coinstore. ADAMANT has flaky public nodes; the bot finds working ones and proceeds. Ignore unless commands stop reaching the bot.

---

## 8. Functional Readiness Checklist

When picking up this debugging effort fresh, run through this in order:

```
Gate A — Authentication
[ ] pm2 logs tradebot --lines 100   # check for 1401/401/3005 errors
[ ] Send /balances via ADAMANT — should return balance data, NOT 1401
[ ] If 1401: run the IPv6 diagnostic curl recipe in Section 5 Priority 0
[ ] Verify VPS clock: timedatectl status (synchronized: yes)
[ ] Verify API key on Coinstore dashboard is active with read+trade perms
[ ] Verify BOTH v4 AND v6 IPs of VPS are in Coinstore whitelist

Gate B — Pair Listing
[ ] Search Coinstore tickers for the pair:
    curl -s https://api.coinstore.com/api/v1/market/tickers | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print([t for t in d.get('data',[]) if 'JITOSOL' in t.get('symbol','')])"
[ ] Search Coinstore assets for the coin:
    curl -s https://api.coinstore.com/v3/public/assets | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print([k for k in (d.get('data') or {}) if 'JITOSOL' in str(k).upper()])"
[ ] Check startup logs: parseMarket "Cannot get info" warnings should be GONE once listed
[ ] /amount and /interval should show real USDT values, not NaN

Gate C — Funding (only after A & B green)
[ ] Deposit USDT (for buy-side) and JITOSOL (for sell-side) to the Coinstore account
[ ] /balances shows funded amounts
[ ] Only THEN: /start mm spread
```

---

## 9. Config Reference

`config.jsonc` (copied from `config.default.jsonc`). Strings must remain quoted — it's JSON-with-comments.

```jsonc
{
  "exchange": "Coinstore",
  "pair": "JITOSOL/USDT",
  "apikey": "<32-char hex>",
  "apisecret": "<32-char hex>",
  "apipassword": "",         // Not used by Coinstore
  "passPhrase": "<adamant bot passphrase>",
  "admin_accounts": ["U..."]  // ADAMANT admin address
}
```

Exchange name is case-insensitive — `configReader.js` lowercases it to dynamically load `trade/trader_coinstore.js`.

---

## 10. Coinstore API Error Codes (Quick Reference)

From https://coinstore-openapi.github.io/en/#introduction:

| Code | Meaning |
|---|---|
| 0 | Success |
| 401 | Signature failed / API key error |
| **1401** | **Unauthorized / IP whitelist / Token expired** ← the August 2025 + early 2026-05-13 failure |
| 3005 | Signature generation error |
| **3011** | **Symbol not found** ← will appear when trying to operate on JITOSOL/USDT before listing |
| 3013 | No spot trading qualification |
| 3103 | Order not found |
| 3111 | Duplicate order |
| 3113 | Insufficient balance |

HTTP-level errors:

| HTTP Code | Meaning |
|---|---|
| 400 | Invalid request format |
| 401 | Invalid API Key |
| 404 | Service not found |
| 429 | Too many visits (rate limited) |
| 500 | Internal server error |

Rate limits: 300 requests/3s per IP, 120 requests/3s per user.

---

## 11. What's Next

1. **Wait on Coinstore** to list JITOSOL/USDT spot market and add JITOSOL to `/v3/public/assets`. Coordinate with company backend.
2. When listed: `pm2 restart tradebot`, confirm `parseMarket` warnings are gone, `/amount` / `/interval` show real values, `/orders JITOSOL/USDT` returns `[]` instead of `3011`.
3. Deposit working capital (USDT + JITOSOL).
4. Test order placement manually via the bot's command interface before enabling MM.
5. Only then: `/start mm spread` and monitor.
