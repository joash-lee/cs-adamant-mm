# Operator guide — JITOSOL/USDT MM (for `/cs-mm-helper`)

This doc captures **how to think about the live bot**, common operator concerns, and how to interpret `/params`, `/orders`, and `pm2` logs. Use with [RUNBOOK.md](./RUNBOOK.md) and [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

Always prefer **fresh** `/params`, `/balances`, `/orders JITOSOL/USDT`, and `pm2 logs tradebot --lines 80` over snapshots below.

---

## Operator baseline (2026-06-15 live session)

**Phase:** Opening day — market live, `optimal` MM running.

**Typical `/params` profile (operator-tuned):**

| Setting | Value |
|---------|--------|
| `mm_Policy` | `optimal` |
| `mm_minAmount` / `mm_maxAmount` | `0.5` – `1` JITOSOL |
| `mm_minInterval` / `mm_maxInterval` | `5` – `30` sec |
| PW | `SOL/USDT@Coinstore`, **2.5%**, `smart`, **`prevent`** |
| Liq | **2%**, **12 JITOSOL**, **1200 USDT**, `middle` |
| OB | **8** orders, **25%** max (high API churn — watch **429**) |

**Wallet ballpark at session:** ~42 JITOSOL, ~5,160 USDT (~$5,157 total). Liq near full deploy (~1,160 USDT bids, ~13.5 JITOSOL asks). **2 manual** orders (~393 USDT buys) and **3 unknown** orders seen once — investigate if still present.

**Price anchor:** SOL/USDT on Coinstore × Jito coef (~**1.2849**) ± PW deviation. **Not** Friday-static; PW updates every few seconds. Fair JITOSOL ~$91.6 when SOL ~$71.35; market mid was ~$90.9 (~1% below peg).

---

## Module primer (PW, LIQ, OB, MM, MAN)

### Price Watcher (PW)

- **Layman:** Fair-price fence from **SOL**, not JITOSOL book spam.
- **Technical:** `mm_price_watcher.js` — `SOL/USDT@Coinstore` smart bid/ask × `jitoCoefficient` × (1 ± deviation%). With **`prevent`**: blocks bot from bad prices; **does not** spend balance to defend; **does not** stop strangers from filling your quotes inside the band.
- **Check:** `/params` (no `/info pw`). Logs: `Applied cross-base coefficient`, `within Pw's range`.
- **Enable shape:** `/enable pw SOL/USDT@Coinstore 2.5% smart prevent`

### Liquidity (LIQ) — **main inventory risk**

- **Layman:** Bulk buy/sell quotes in the real market (~±2% from mid). Most **frozen** balance lives here.
- **Technical:** `mm_liquidity_provider.js` — depth orders (`purpose: liq`), caps `mm_liquiditySellAmount` / `mm_liquidityBuyQuoteAmount`, refreshed ~10–20s, clamped to PW band.
- **Enable shape:** `/enable liq 2% 12 JITOSOL 1200 USDT middle`
  - `2%` — spread width from mid (how far quotes sit)
  - `12 JITOSOL` — max sell-side inventory posted
  - `1200 USDT` — max buy-side quote posted
  - `middle` — center quotes (`uptrend` / `downtrend` bias gap)
- **Check:** `/orders JITOSOL/USDT` → `Liquidity liq:` line; `/balances` frozen vs free.
- **Clear:** `/clear JITOSOL/USDT liq`

### Order book builder (OB)

- **Layman:** Tiny, short-lived orders (often **3–7 sec**) to animate the book — not main liquidity.
- **Technical:** `mm_orderbook_builder.js` — up to `mm_orderBookOrdersCount` ob orders; heavy API use → **429 Too Many Requests** if too aggressive.
- **Enable shape:** `/enable ob 8 25%`
- **Mitigation:** `/disable ob` or `/enable ob 4 25%` when 429s appear.
- **Clear:** `/clear JITOSOL/USDT ob`

### Market-making (MM)

- **Layman:** Creates volume (`optimal` = mix of spread + order-book trades).
- **With liq on:** ~**80%** `executeInOrderBook`, ~**20%** `executeInSpread`. Real fills possible (e.g. sell ~0.51 JITOSOL @ ~90.28).
- **Check:** `/stats JITOSOL/USDT`, logs `Market-making: Successfully executed mm-order`.

### Manual (MAN)

- **Layman:** Orders from `/fill`, `/buy`, etc. — not liq/ob/mm/pw.
- **Check:** `/orders JITOSOL/USDT` → `Manual man:` count and USDT/JITOSOL totals.
- **Clear:** `/clear JITOSOL/USDT man`

### Unknown (UNK)

- Orders on exchange not in bot DB. Compare exchange UI vs `/orders`. Investigate before clearing.

---

## Liquidity “at risk” (USDT framing)

**Posted notional (both sides, liq only @ ~$91/JITOSOL):**

- Sells: ~`mm_liquiditySellAmount` JITOSOL → ~**$1,090–1,230**
- Buys: ~`mm_liquidityBuyQuoteAmount` USDT → ~**$1,200**

**~$2.3k** can be **on the book** at once; that is **not** $2.3k loss.

**One-sided pick-off cap (per direction):** ~**$1.2k** — either spend ~1200 USDT on buys or sell ~12 JITOSOL on asks. Add **manual** bid USDT if `man` orders exist.

**Free balance** (not in open orders) is not at risk until the bot posts it.

PW **`prevent`** stops the **bot** from trading outside the band; it does **not** stop the market from lifting your in-band quotes.

---

## Adversarial / spoof orders

**Common pattern on JITOSOL/USDT:** far bids ($0.65–$31) and far asks ($1,000–$11,000). **Usually harmless** — bot uses **top of book** (`highestBid` / `lowestAsk`), PW uses **SOL**.

**Real risk:** informed traders filling **your liq** at ~$89–$92 (inventory skew / adverse selection), not deep-book spam.

**Only worry about spoof** if absurd prices become **#1 bid or #1 ask** → `/stop mm`, assess, Coinstore support.

---

## Monitoring cadence

### Daily (~5 min) — Adamant

```
/params
/balances
/orders JITOSOL/USDT
/stats JITOSOL/USDT
```

| Signal | OK | Concern |
|--------|-----|---------|
| `liq` totals | Near caps, both sides | One side → 0 |
| Free JITOSOL / USDT | Stable band vs target | Fast one-sided drift |
| `man` | 0 | Leftover pre-market fills |
| `unk` | 0 | Unknown orders |
| PW in logs | `within Pw's range` | `Refusing to buy/sell` spam, JITOSOL ~$65 band |

### Logs — VPS

```bash
pm2 logs tradebot --lines 80 | grep -E 'within Pw|429|Refusing|filled|Liquidity: Opened|coefficient'
```

### Rebalance

Rebalance on **inventory skew** (>~15–20% off target), not on a calendar. Options: manual buy/sell on Coinstore, or retune liq caps:

```
/enable liq 2% 8 JITOSOL 1200 USDT middle
/enable liq 2% 12 JITOSOL 800 USDT middle
/clear JITOSOL/USDT man
```

---

## `pm2 restart tradebot` — safe when, risks

**Safe because:** Restarts the **process** only. `/params` persist on disk (`tradeParams_*`). **Exchange orders stay open** (not auto-cancelled). DB kept unless `doClearDB` dev flag.

**Helps:** Stale market cache (Gate B), after `config.jsonc` edit, recovery from 429/stuck iterations, morning refresh when Coinstore updates symbol metadata.

**Risks:** ~5–30s blind window (no PW/liq updates); startup failure (1401, pair missing) leaves bot off while orders remain; **frequent** restarts worsen 429.

**Not a fix for:** OB rate limits (disable OB first), inventory skew, spoof deep in book.

**Procedure:**

```bash
pm2 restart tradebot
pm2 logs tradebot --lines 40
```

Then Adamant: `/params`, `/balances`, `/orders JITOSOL/USDT`.

**vs `/stop mm`:** stops trading logic without rebooting process.

---

## Log pattern cheat sheet

| Log line | Meaning |
|----------|---------|
| `Applied cross-base coefficient 1.284… (fresh)` | PW anchor OK |
| `within Pw's range` | Market inside band |
| `Liquidity: Opened N bids… M asks…` | Liq deploy status |
| `executeInOrderBook` + `filled` | Real MM trade |
| `429 Too Many Requests` | API throttle — reduce OB or widen MM interval |
| `Failed to get Txs in check()` | ADAMANT messenger noise — usually ignore |
| `Unable to calculate JITOSOL price in USD` | Infoservice — usually ignore |
| `Unable to find both USDT/USDT` | Harmless PW log when source is USDT-quoted |
| `It's expired` + ob-order cancel | Normal OB rotation |
| `unknown orders unk` | Exchange orders not in DB — investigate |

---

## Common operator questions → answer shape

1. **Where is my money at risk?** → Liq caps + manual bids; USDT one-sided math; PW does not block fills.
2. **Adversarial orders?** → Far book = noise unless BBO; real flow vs your liq.
3. **PW vs Friday anchor?** → Live SOL × coef; show band from logs.
4. **OB vs LIQ?** → LIQ = bulk/risk; OB = cosmetic/429 risk.
5. **Restart safe?** → Yes with caveats; procedure above.
6. **Check manual orders?** → `/orders JITOSOL/USDT` → `man:` line; `/clear JITOSOL/USDT man`.
7. **Opening day tune?** → 2.5% PW, `/interval 5-22 sec` after volume, `/disable ob` or fewer ob on 429.

---

## Evidence to request (if not pasted)

1. Adamant: `/params`, `/balances`, `/orders JITOSOL/USDT`, `/stats JITOSOL/USDT` (errors too)
2. VPS: `pm2 logs tradebot --lines 80`

Optional: what changed last (`/enable`, restart, config edit).

---

## Beyond Adamant

- Coinstore UI for full order list and unknowns
- External SOL price alerts (PW tracks SOL)
- Simple daily balance spreadsheet
- Keep OB light to avoid 429
- Coinstore support for persistent BBO spoof / wash
