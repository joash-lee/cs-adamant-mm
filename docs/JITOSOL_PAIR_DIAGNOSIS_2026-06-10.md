# JITOSOL/USDT "Pair Not Found" — Diagnosis & Fix Plan

> Investigated 2026-06-10. Companion to `COINSTORE_DEBUG_PRIMER.md` (which is from 2026-05-13 and now partially out of date — see "What changed since the primer" below).

---

## TL;DR

**Good news: your hunch was right in spirit, but the situation is better than you think.**

1. **JITOSOL/USDT IS now visible on Coinstore's public API.** As of today, `JITOSOLUSDT` appears in the public tickers list (instrument ID **1906**), and `JITOSOL` appears in the public assets list. I verified this three times in a row — it's stable, not a server fluke.

2. **The bot says "not found" because of a stale cache, not a broken API call.** The bot downloads the list of markets from Coinstore **exactly once, when it starts up**, and never refreshes it. Nothing in the codebase ever updates that list afterwards. Your bot process was started before Coinstore added the JITOSOLUSDT instrument, so it's still working from an old market list that doesn't contain the pair.

3. **The fix for "not found" is one command: restart the bot.**
   ```bash
   pm2 restart tradebot
   ```

4. **But there is a second problem waiting behind this one** (the "decimals trap", explained below). It won't stop you from placing **whole-number** test orders, but it will block fractional amounts like `amount=0.1` until either Coinstore publishes the pair's trading config, or we apply a small code patch.

---

## What changed since the primer (2026-05-13 → 2026-06-10)

| Thing | May 13 | Today (Jun 10) |
|---|---|---|
| `JITOSOL` in public assets (`/v3/public/assets`) | ❌ absent (showed as `0 undefined`) | ✅ present (deposits/withdrawals disabled, fees 0.2%/0.2%) |
| `JITOSOLUSDT` in public tickers (`/api/v1/market/tickers`) | ❌ absent (484 markets) | ✅ **present** (487 markets, instrumentId 1906) |
| `JITOSOLUSDT` order book endpoint | n/a | ✅ responds (empty book: no bids, no asks, lastPrice 0) |
| `JITOSOLUSDT` in symbol config catalog (`/api/v2/public/config/spot/symbols`) | n/a | ❌ **absent** (396 symbols, no JITO entry) |
| Wallet funding (Gate C) | ❌ ~zero | ✅ ~4,998 USDT + 44.97 JITOSOL |

That last row matters: the instrument exists on the matching engine, but it's **not in the "open for trade" config catalog**. This is exactly what a pre-market / whitelist-only listing looks like. It also means the bot (and we) cannot read the pair's official tick size / lot size / minimum order size from the API yet — see "The decimals trap".

---

## Why each Adamant message happened (plain English)

**`/buy amount=0.1 price=80` → "Market or perpetual contract ticker 'JITOSOL/USDT' is not found on Coinstore"**
Every pair command first looks the pair up in the bot's in-memory market list (`modules/commandTxs.js:1638` → `orderUtils.parseMarket` → `trader_coinstore.js getMarkets()`). That list was downloaded at startup, before the pair existed. The bot never re-downloads it, so the lookup fails forever until restart. **No API call to Coinstore ever happened for your order** — it died at the local lookup.

**`/pair` → "Unable to receive JITOSOL/USDT market info"**
Same lookup, same stale cache, different wording.

**`/clear all` → same "not found"**
Same lookup again — `/clear` validates the pair before doing anything.

**`/pair jitosolusdt` → "Perpetual contract trading on Coinstore is not enabled in the config"**
This one is a red herring that cost you three attempts. The bot's parser treats any pair **without a slash** as a perpetual-futures contract ticker (`modules/commandTxs.js:1631`). Since you don't have perpetual trading configured, it bails with that message. It has nothing to do with JITOSOL. **Always write the pair with a slash: `JITOSOL/USDT`.** Case doesn't matter; the slash does.

**`/balances` → "I didn't count unknown cryptos JITOSOL"**
Harmless. The balance itself comes straight from Coinstore (that's why the name shows correctly), but ADAMANT's price-info service doesn't know a USD rate for JITOSOL, so the bot can't include it in the "total holdings" math. This will persist until rate providers track JITOSOL. It does not affect trading.

---

## The decimals trap (the problem you'll hit AFTER restarting)

When the bot builds its market list from the tickers endpoint, it **guesses** each pair's allowed decimal places from the ticker's price/volume numbers (`trade/trader_coinstore.js:116-150`). The JITOSOLUSDT ticker is all zeros right now (no trades, empty book):

```json
{"close":"0","open":"0","high":"0","low":"0","volume":"0","bid":"0","ask":"0", ...}
```

`"0"` has zero decimal places, so the bot will record the pair as allowing **0 decimals for both amount and price**. Consequences (`trade/trader_coinstore.js:452-483`):

- `/buy amount=0.1 price=80` → amount is rounded to "0" → rejected with *"After rounding to 0 decimal places, the order amount is wrong"*. Annoying but safe.
- `/buy amount=0.7 price=80` → **silently rounds UP to 1 whole JITOSOL** (~$80 extra). Dangerous.
- Any fractional price (e.g., `price=80.5`) → silently rounded to `81`.
- The market-making module would generate fractional amounts constantly, so MM cannot run sanely until this is fixed.

**Whole-number orders are unaffected.** `amount=1 price=80` passes through rounding untouched. That's your test vehicle for Step 3 below.

This is a chicken-and-egg problem: the bot would normally learn real decimals from trade data, but in pre-market only *you* can create trade data. Two ways out, listed in the plan.

---

## The Plan

### Step 1 — Restart the bot (fixes "not found")

On the VPS (I could not SSH in from this session — production access needs your go-ahead, so run these yourself):

```bash
pm2 restart tradebot
pm2 logs tradebot --lines 60
```

In the startup logs, look for:

```
Received info about 487 markets on Coinstore exchange.
```

(487 or more — the count was 484 on May 13, before the pair existed.) Also confirm the old warning is **gone**:

```
orderUtils/parseMarket: Cannot get info about the JITOSOL/USDT market/contract...   ← should NOT appear anymore
```

### Step 2 — Verify via Adamant

```
/pair JITOSOL/USDT
```

Expected: market info instead of "Unable to receive". Prices/volumes will show as 0 — that's fine, the book is empty. If this still says "not found" after a restart, capture `pm2 logs tradebot --lines 200` right after startup and we dig deeper (that would mean the tickers fetch itself failed at boot, e.g., a timeout — a second restart usually clears that).

### Step 3 — First test order, whole numbers only

This is the moment of truth for the whitelist. Use integer amount AND integer price so the decimals trap can't interfere:

```
/buy JITOSOL/USDT amount=1 price=80
```

(Costs at most 80 USDT of your ~4,998. Pick whatever integer price the team wants the book to open at.) Then:

```
/orders JITOSOL/USDT
```

**Outcome cheat sheet:**

| Bot reply / log | Meaning | Next move |
|---|---|---|
| "Order placed … Order Id: …" | 🎉 Whitelist works. Pre-market trading is live. | Proceed to Step 4 so fractional amounts work |
| Error with code **3011** "Symbol not found" | Engine accepts the symbol publicly but order placement is gated — your account is NOT actually whitelisted yet | Ask Coinstore/backend team to confirm the whitelist is attached to **this** account/API key |
| Error with code **3013** "No spot trading qualification" | Same as above, different gate | Same — whitelist question to Coinstore |
| Error with code **1401** | IP whitelist regression (both `31.97.71.71` and `2a02:4780:5e:64b::1` must stay on the key) | Re-check key settings; see primer §5 Priority 0 |
| "After rounding to N decimal places…" | You used a fractional amount/price — decimals trap | Use integers, or apply the Step 4 patch |

To clean up the test order: `/clear JITOSOL/USDT all` (or cancel by order id).

**Important:** don't place a sell at the same price as your own buy — pre-market means the only counterparty in the book is you, and you'd trade against yourself (wash trade). If you want to test the sell side, place it far above your buy, e.g. `/sell JITOSOL/USDT amount=1 price=200`, then clear both.

### Step 4 — Fix fractional amounts (small code patch)

The clean long-term source for decimals is Coinstore's symbol-config endpoint — I verified today it works **without authentication**:

```bash
curl -s -X POST "https://api.coinstore.com/api/v2/public/config/spot/symbols" \
  -H 'Content-Type: application/json' -d '{"symbolCodes":["jitosolusdt"]}'
```

Today it returns `{"data":[null]}` for JITOSOL — the pair isn't in the public trading catalog yet. **Once Coinstore fully lists the pair, this returns tick size, lot size, min order size, and fees**, and re-running it is the cheapest way to check listing progress. (For reference, SOL/USDT there shows `tickSz: 3, lotSz: 3, minLmtSz: 0.001` — JITOSOL will likely get similar values.)

So for the pre-market window the bot needs a fallback. Minimal patch in `trade/trader_coinstore.js`, inside `getMarkets()`'s `markets.forEach()` loop (around line 116): when a ticker is all zeros, don't derive decimals from it — use safe defaults instead.

```js
// Pre-market pairs have all-zero tickers; deriving decimals from them yields 0,
// which makes the bot round amounts like 0.1 down to nothing.
const tickerIsEmpty = !+market.close && !+market.bid && !+market.ask && !+market.volume;

const maxCoin1Decimals = tickerIsEmpty ? 2 : Math.max(
    utils.getDecimalsFromNumber(market.bidSize),
    utils.getDecimalsFromNumber(market.askSize),
    utils.getDecimalsFromNumber(market.volume),
);
const maxCoin2Decimals = tickerIsEmpty ? 3 : Math.max(
    utils.getDecimalsFromNumber(market.close),
    utils.getDecimalsFromNumber(market.open),
    utils.getDecimalsFromNumber(market.high),
    utils.getDecimalsFromNumber(market.low),
    utils.getDecimalsFromNumber(market.bid),
    utils.getDecimalsFromNumber(market.ask),
);
```

The `2` (amount decimals) and `3` (price decimals) are deliberately conservative guesses — **confirm the real values with the Coinstore backend team first** (see Step 5). If the exchange rejects an order for precision, its error message will say so and we adjust the constants. After editing: `pm2 restart tradebot`.

I have NOT applied this patch — per your instruction to diagnose before changing code, and because it can't be tested without the whitelisted account on the VPS. It's a 10-line, single-file change when you're ready.

**Optional later upgrade** (primer §7 already sketched this): make `getMarkets()` merge in `/api/v2/public/config/spot/symbols` data, which would give the bot *real* tick/lot sizes, minimums, and fees for every listed pair, replace the guessed decimals entirely, and also fix the long-standing "min amount validation silently skipped" issue. Worth doing once JITOSOL is fully listed and appears in that catalog. Touches `coinstore_api.js` + `trader_coinstore.js` only.

### Step 5 — Two questions for the Coinstore / backend team

1. **"What are the tick size (price decimals), lot size (quantity decimals), and minimum order size for JITOSOLUSDT (instrument ID 1906)?"** — The pair is not in the public symbol-config catalog, so we can't read these; we need them to place correctly-formatted fractional orders.
2. **"Is the pre-market whitelist attached to our account / API key `642d48e6…7e39`?"** — Only needed if Step 3 returns error 3011 or 3013.

---

## Things that are NOT wrong (don't chase these)

- **The bot's API call construction is fine.** It signs and formats requests exactly like the Python snippet from the exchange team (same `POST /api/trade/order/place`, same `symbol: "JITOSOLUSDT"` format, same two-step HMAC). The order request was never even sent — it failed at the bot's local pair lookup.
- **Authentication is fine.** `/balances` works; the dual IPv4+IPv6 whitelist from the May 13 fix is holding.
- **"Unknown cryptos JITOSOL" in /balances** — cosmetic, see above.
- **ADAMANT node health-check noise in logs** — unrelated, see primer §7.

---

## Appendix — raw evidence (all collected 2026-06-10, public API, no auth)

```
GET /api/v1/market/tickers                     → 487 markets; JITOSOLUSDT present (3/3 runs)
  JITOSOLUSDT ticker: all fields "0", count 0, instrumentId 1906

GET /api/v1/market/depth/JITOSOLUSDT           → code 0; bids [], asks [], lastPrice "0"
GET /api/v1/market/trade/JITOSOLUSDT           → code 0; data [] (no trades ever)

GET /v3/public/assets                          → 1658 assets; JITOSOL present:
  {"name":"jitosol","unified_cryptoasset_id":1902,"can_withdraw":"false",
   "can_deposit":"false","maker_fee":"0.002","taker_fee":"0.002"}

POST /api/v2/public/config/spot/symbols {"symbolCodes":["jitosolusdt"]}
                                               → {"code":"0","data":[null]}  ← not in trade catalog yet
POST /api/v2/public/config/spot/symbols {}     → 396 symbols, no JITO entry
  (SOLUSDT for comparison: tickSz 3, lotSz 3, minLmtSz 0.001, fees 0.002/0.002)
```

Code paths verified in this repo (branch `dev`):

- Market cache built once, never refreshed: `trade/trader_coinstore.js:103-170` (`getMarkets`, early-returns on existing cache; no other writer of `exchangeMarkets` anywhere in the codebase)
- "not found" message: `modules/commandTxs.js:1638` via `trade/orderUtils.js:263-348` (`parseMarket`)
- No-slash pair → perpetual branch: `modules/commandTxs.js:1631`
- Decimals derived from ticker numbers: `trade/trader_coinstore.js:116-129`
- Rounding/rejection on placement: `trade/trader_coinstore.js:452-483`
