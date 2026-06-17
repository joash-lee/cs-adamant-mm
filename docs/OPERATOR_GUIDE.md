# Operator guide — how the bot behaves (plain English)

**Use this doc** when you want to understand PW, liq, MM, and risk — not copy-paste commands. For commands, open **[RUNBOOK.md](./RUNBOOK.md)**. For deploy/restart, open **[OKX_PW_SETUP.md](./OKX_PW_SETUP.md)**.

Always trust **live** `/params`, `/balances`, `/orders JITOSOL/USDT`, and `pm2 logs` over anything written here.

---

## Fair price in one paragraph

The bot needs to know: *“What should JITOSOL cost in USDT?”*

It now asks **OKX** (a big external exchange that lists JITOSOL/USDT). That answer is **fair price**. The bot draws a **fence** (Price Watcher band) around fair — e.g. ±1% — and refuses to let **itself** buy too high or sell too low (`prevent` mode).

It **still posts quotes on Coinstore** using Coinstore’s own order book shape. Fair price (OKX) and quote placement (Coinstore) are **related but not identical** — see [PW vs liq](#pw-vs-liq-two-different-clocks) below.

---

## Three ways the bot can set fair price

| # | Name | When | Multiplier? | You control it? |
|---|------|------|-------------|-----------------|
| 1 | **OKX primary** | Normal | No | `/enable pw JITOSOL/USDT@OKX …` |
| 2 | **OKX keyless** | OKX API key expired | No | Automatic — renew keys in config |
| 3 | **Coinstore SOL fallback** | OKX completely unreachable | Yes (~1.285×) | `pw_fallback_source` in **config.jsonc only** |

**Important:** Expired OKX keys do **not** switch you to Coinstore SOL. The bot keeps reading OKX public prices.

---

## Module primer

### Price Watcher (PW) — the fair-price fence

**Layman:** “OKX says JITOSOL is about $93. The bot is only allowed to trade between roughly $92 and $94 (with 1% deviation).”

**What it does not do:** Spend your money to push the market back inside the fence (`prevent` mode). It also does **not** stop other people from filling your open orders.

**Commands:** See RUNBOOK — `/enable pw JITOSOL/USDT@OKX 1% smart prevent -y`

**How to check it is working:**

```
/params   → mm_priceWatcherSource should be JITOSOL/USDT@OKX
```

```bash
pm2 logs tradebot --lines 80 | grep 'Active PW source'
```

**Good log:**

```
Active PW source: JITOSOL/USDT@OKX (direct, authenticated, no coefficient).
```

**On OKX primary you should NOT see:** `Applied cross-base coefficient` or `Falling back to SOL/USDT@Coinstore`.

**Refresh speed:** OKX band updates every **15–30 seconds** (slower than the old same-exchange SOL feed at 3–7 s). That is normal.

---

### Liquidity (LIQ) — where most of your money sits on the book

**Layman:** The bot posts chunky buy and sell orders near the **Coinstore JITOSOL** mid price — e.g. within ±0.5% or ±1%.

**Risk:** Up to your liq caps can sit on the book (~600 USDT bids + ~6 JITOSOL asks in conservative mode). Someone can fill those orders; that is market-making, not a bug.

**Commands:** `/enable liq 0.5% 6 JITOSOL 600 USDT middle` — see RUNBOOK.

**Check:** `/orders JITOSOL/USDT` → `Liquidity liq:` line · `/balances` → frozen vs free.

---

### PW vs liq — two different clocks

| | Price Watcher | Liquidity |
|--|---------------|-----------|
| **Reads** | OKX JITOSOL/USDT | Coinstore JITOSOL/USDT book |
| **Purpose** | Define fair / fence | Post actual quotes |
| **Updates** | Every 15–30 s | Every ~10–20 s |

**Why this matters:** Coinstore’s JITOSOL book can sit **~1% above** OKX fair (self-referential quoting). PW says fair is ~$93 from OKX; liq may still **try** to quote near Coinstore’s ~$94 mid.

**What PW blocks today:**

- **Buys** above the top of the PW band — ✓ capped
- **Sells** below the bottom of the PW band — ✓ capped
- **Sells above** the top of the band — **not** capped (existing behaviour)

So aggressive **ask** prices can still appear high vs OKX until liq spread rules or you retune. Starting with **tight liq (0.5%)** and **MM off** reduces that risk while you validate OKX.

---

### Order book builder (OB)

**Layman:** Small, fast orders to make the book look busy. Can trigger **429** (rate limit) if too many.

**Mitigation:** `/disable ob` or `/enable ob 4 20%`.

---

### Market-making (MM)

**Layman:** Bot trades to create volume. Turn **off** until OKX PW is validated (~24h clean logs).

**Check:** `/stats JITOSOL/USDT` · logs `Successfully executed mm-order`.

---

### Manual (MAN) / Unknown (UNK)

- **MAN:** Orders you placed with `/fill`, `/buy`, etc.
- **UNK:** On exchange but not in bot DB — investigate before clearing.

---

## Worked example (live-style numbers)

Rough snapshot — always verify live:

| Feed | Mid (USDT) |
|------|------------|
| OKX JITOSOL (fair) | ~**93.15** |
| Coinstore SOL × 1.285 (fallback fair) | ~**93.24** |
| Coinstore JITOSOL book (venue) | ~**94.36** |

**PW band @ 1% on OKX primary:** about **$92.18 – $94.12**

**If OKX dies → fallback:** band shifts only ~**$0.10** — fallback math is close to OKX today.

**If you used Coinstore JITOSOL as fair (old mistake):** band center ~**$94.36** — about **$1.20 too high** vs OKX.

---

## Liquidity “at risk” (USDT framing)

**Conservative liq (`6 JITOSOL` / `600 USDT` @ ~$93):**

- ~**$560** in JITOSOL asks (6 × 93)
- ~**$600** in USDT bids
- ~**$1,160** on the book — not the same as $1,160 *lost*

**One-sided worst case:** ~$600 bought or ~6 JITOSOL sold if the market takes one side.

PW **`prevent`** stops the **bot** from new bad trades; it does **not** un-fill orders already on the book.

---

## Monitoring

### Daily Adamant (~5 min)

```
/params
/balances
/orders JITOSOL/USDT
/stats JITOSOL/USDT
```

| Signal | OK | Concern |
|--------|-----|---------|
| `mm_priceWatcherSource` | `JITOSOL/USDT@OKX` | Still `SOL/USDT@Coinstore` after cutover |
| `Active PW source` in logs | OKX, no coefficient | Fallback or coefficient on OKX day |
| Liq both sides | Near caps | One side → 0 |
| `man` / `unk` | 0 | Leftover unknowns |

### Log grep (VPS)

```bash
pm2 logs tradebot --lines 80 | grep -E 'Active PW source|Falling back|cross-base coefficient|within Pw|429|Refusing'
```

---

## Log cheat sheet (OKX era)

| Log | Plain English |
|-----|---------------|
| `Active PW source: JITOSOL/USDT@OKX … no coefficient` | Healthy OKX anchor |
| `OKX API: Authenticated request failed … keyless` | Keys bad; OKX still works; fix keys later |
| `Falling back to SOL/USDT@Coinstore` | OKX down; emergency SOL×coef pricing |
| `Applied cross-base coefficient 1.285…` | Expected on **fallback**; wrong on OKX primary |
| `within Pw's range` | Activity inside fence |
| `Refusing to buy higher than …` | PW doing its job |
| `429 Too Many Requests` | Too much API — disable OB, slow MM |

---

## Restart & stop

**`pm2 restart tradebot`:** Safe for config changes and cache refresh. Orders stay open on Coinstore. ~5–30 s gap with no updates.

**`/stop mm`:** Stops trading logic without killing the process.

After restart: `/params`, `/balances`, grep `Active PW source`.

---

## Common questions

**Which doc has commands?** → [RUNBOOK.md](./RUNBOOK.md)

**Which doc is deploy / OKX keys?** → [OKX_PW_SETUP.md](./OKX_PW_SETUP.md)

**Can I choose SOL instead of OKX?** → Yes: `/enable pw SOL/USDT@Coinstore 1% smart prevent -y` — but you lose the external anchor (not recommended).

**Can I change fallback from Adamant?** → No. Edit `pw_fallback_source` in `config.jsonc` and restart.

**Is spoof book junk a problem?** → Usually no unless fake prices become **#1 bid/ask**. PW ignores deep junk; it uses OKX for fair.

**Opening day tune after OKX validated?** → Widen liq to 1% / 8 JITOSOL / 800 USDT; `/interval 10-40 sec`; MM on last.

---

## Evidence to paste when asking for help

1. Adamant: `/params`, `/balances`, `/orders JITOSOL/USDT`
2. VPS: `pm2 logs tradebot --lines 80`
3. What changed: deploy, `/enable pw`, config edit, restart
