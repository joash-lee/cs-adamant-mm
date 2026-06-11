# Troubleshooting — Coinstore JITOSOL/USDT bot

## What to paste when asking for help

Always provide **both**:

1. **Adamant** — full bot reply for the command you ran (e.g. `/params`, `/orders`, `/stats`, error text).
2. **VPS logs** — `pm2 logs tradebot --lines 80` (or more around the incident).

Optional: what you changed last (`/enable`, config edit, restart).

---

## Gate A — Authentication (`1401`)

**Layman:** Coinstore rejects the bot's login — usually wrong IP leaving the server.

**Technical:** `X-CS-SIGN` OK but source IP not whitelisted; dual-stack VPS often exits on IPv6.

```bash
curl -s https://ifconfig.me && echo
curl -s -4 https://api.ipify.org && echo
curl -s -6 https://api.ipify.org && echo
```

**Fix options:**

| Option | CLI |
|--------|-----|
| A (preferred) | Add VPS IPv6 `2a02:4780:5e:64b::1` to Coinstore API key whitelist |
| B | `pm2 delete tradebot && pm2 start app.js --name tradebot --node-args="--dns-result-order=ipv4first" && pm2 save` |
| C | Code: force `family: 4` in axios — **hand off to coding agent** |

Canary: `/balances` must succeed without `1401`.

Cascade in logs (all one root cause): `1401` → `balances.filter is not a function` → `Cannot read properties of undefined`.

---

## Gate B — Pair not found (stale cache)

**Layman:** Coinstore has the pair; the bot still uses an old list from when it started.

**Technical:** `getMarkets()` caches at startup; `parseMarket` fails locally — no order API call.

```
/pair JITOSOL/USDT
```

**Fix:**

```bash
pm2 restart tradebot
```

If still failing: tickers curl check:

```bash
curl -s https://api.coinstore.com/api/v1/market/tickers | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print([t for t in d.get('data',[]) if 'JITOSOL' in t.get('symbol','')])"
```

---

## Gate B — Order rejected `3011` / `3013`

| Code | Meaning | Action |
|------|---------|--------|
| 3011 | Symbol not found / not tradable for this key | Coinstore listing or pre-market whitelist |
| 3013 | No spot trading qualification | Account not whitelisted for pre-market |

Not fixable by restart alone if catalog still excludes the pair.

---

## Decimals trap

**Layman:** With no trades yet, Coinstore reports prices as `0`; the bot thinks you can only trade whole coins.

**Symptoms:**

- `After rounding to 0 decimal places, the order amount is wrong`
- `0.7` JITOSOL silently becomes `1`

**Workaround now:**

```
/buy JITOSOL/USDT amount=1 price=80
/amount 1-4
```

**Check listing progress:**

```bash
curl -s -X POST "https://api.coinstore.com/api/v2/public/config/spot/symbols" \
  -H 'Content-Type: application/json' -d '{"symbolCodes":["jitosolusdt"]}'
```

`data:[null]` = not in trade catalog yet. When listed, returns `tickSz`, `lotSz`, `minLmtSz`.

**Permanent fix:** patch `trade/trader_coinstore.js` — **hand off to coding agent** (see RUNBOOK).

---

## Price Watcher / coefficient

**Correct:** `mm_priceWatcherSource: SOL/USDT@Coinstore`, logs show `Applied cross-base coefficient ~1.284`.

**Wrong:** JITOSOL mid near SOL spot (~$65); static USDT band only; coefficient `1` or missing with cross-base source.

**Verify:**

```
/params
```

Look for `mm_priceWatcherSource`, `mm_priceWatcherDeviationPercent`, `mm_priceWatcherAction: prevent`.

**Enable:**

```
/enable pw SOL/USDT@Coinstore 3% smart prevent
```

Config fallback: `pw_source_coefficient: 1.2842` in `config.jsonc`.

---

## Empty / one-sided order book

**Layman:** Market-making needs a buy and a sell on the book; if only your bids exist, MM may refuse to trade.

**Log:** `Unable to get order book` — `orderUtils` requires both bid and ask.

**Fix:** Seed both sides (`/fill` or manual buy + sell far apart); avoid matching your own price (wash).

---

## Self-trade warnings

Pre-market: bot matches its own ob/liq orders. Expected. Mitigate: wider `/interval`, slightly wider liq spread, fewer ob orders.

---

## Coinstore error codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 401 | API key / signature |
| 1401 | IP whitelist / token |
| 3005 | Signature generation |
| 3011 | Symbol not found |
| 3013 | No spot qualification |
| 3113 | Insufficient balance |

---

## Key repo paths (read-only reference)

| Path | Role |
|------|------|
| `trade/trader_coinstore.js` | Markets cache, decimals, orders |
| `trade/api/coinstore_api.js` | HTTP + signature |
| `trade/mm_price_watcher.js` | PW + coefficient |
| `helpers/cryptos/jitoCoefficient.js` | Jito stats API |
| `modules/commandTxs.js` | Adamant commands |
| `config.jsonc` | Exchange keys, `pw_source_coefficient` |

---

## Ignore (usually)

- `Failed to get Txs in check()` — ADAMANT nodes
- `Unknown cryptos JITOSOL` on `/balances` USD total
- `/stats` "no orders all time" — DB history vs open orders
