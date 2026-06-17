# JITOSOL/USDT Coinstore MM — Runbook & command reference

**This is your Adamant command cheat sheet** for the OKX price anchor setup. For *why* things work this way, see [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md). For *first-time deploy* (code + OKX keys + restart), see [OKX_PW_SETUP.md](./OKX_PW_SETUP.md).

---

## Deployment facts

| Item | Value |
|------|--------|
| Trading exchange | **Coinstore** (orders go here) |
| Fair-price source | **OKX** JITOSOL/USDT (read-only) |
| Pair | `JITOSOL/USDT` — always use a slash |
| VPS | `srv935443` |
| IPv4 whitelist | `31.97.71.71` |
| IPv6 whitelist | `2a02:4780:5e:64b::1` |
| Process | `pm2 restart tradebot` / `pm2 logs tradebot` |
| Config file | `config.jsonc` — OKX keys, fallback (not editable via `/params`) |
| Saved settings | `tradeParams_*` — survives restart |

---

## Three gates before you trust the bot

1. **Gate A — Coinstore login:** `/balances` works; no `1401` in logs.
2. **Gate B — Pair loaded:** After restart, `/pair JITOSOL/USDT` shows market info (not “not found”).
3. **Gate C — Money & fair price:** Funded wallet; logs show `Active PW source: JITOSOL/USDT@OKX`.

---

## OKX cutover — command sequence (live)

Use this when moving from the old SOL-based anchor to OKX.

**VPS first** (see [OKX_PW_SETUP.md](./OKX_PW_SETUP.md) for config keys):

```bash
pm2 restart tradebot
pm2 logs tradebot --lines 60
```

**Adamant:**

```
/stop mm
/clear JITOSOL/USDT liq
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
/enable liq 0.5% 6 JITOSOL 600 USDT middle
/interval 30-120 sec
/params
```

**Verify logs:**

```bash
pm2 logs tradebot --lines 100 | grep -E 'Active PW source|cross-base coefficient|Falling back'
```

Expect: `Active PW source: JITOSOL/USDT@OKX (direct, …, no coefficient)` — **not** `Applied cross-base coefficient` on a healthy day.

**After ~24h stable OKX logs**, optionally widen activity:

```
/enable liq 1% 8 JITOSOL 800 USDT middle
/interval 10-40 sec
/start mm optimal
```

---

## Pre-market bootstrap (unchanged flow, new PW command)

```bash
pm2 restart tradebot
pm2 logs tradebot --lines 60
```

Adamant:

```
/pair JITOSOL/USDT
/balances
/stop mm
/clear JITOSOL/USDT man
/fill JITOSOL/USDT buy quote=400 low=81 high=84 count=3
/fill JITOSOL/USDT sell amount=3 low=84 high=87 count=3
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
/enable liq 0.5% 6 JITOSOL 600 USDT middle
/enable ob 4 20%
/amount 1-4
/interval 30-120 sec
/buypercent 0.5
/start mm optimal
/params
```

---

## Recommended params (post-OKX cutover)

| Param | Recommended | Notes |
|-------|-------------|--------|
| PW source | `JITOSOL/USDT@OKX` | Set via `/enable pw` |
| PW deviation | **1%** | Tighter band around OKX fair |
| PW policy / action | `smart` / **`prevent`** | `prevent` = bot won't trade outside band |
| Fallback | `SOL/USDT@Coinstore` | **config.jsonc only** — automatic if OKX dies |
| Liq spread | **0.5%** → 1% later | Start conservative |
| Liq caps | **6 JITOSOL** / **600 USDT** | Raise after validation |
| MM interval | **30–120 s** initially | Widen until OKX anchor trusted |
| OB | **4** orders or **disabled** | Reduces 429 risk |

**Old values (do not use as default anymore):** `SOL/USDT@Coinstore` as primary PW, 2.5% deviation, 2% / 12 / 1200 liq — only if you deliberately revert.

---

## Adamant command reference (JITOSOL-specific)

| Goal | Command |
|------|---------|
| **Status** | `/params` · `/stats JITOSOL/USDT` · `/orders JITOSOL/USDT` · `/balances` |
| **Check pair decimals** | `/pair JITOSOL/USDT` |
| **Stop trading** | `/stop mm` |
| **Clear orders** | `/clear JITOSOL/USDT all` or `man` / `ob` / `liq` |
| **Price Watcher (OKX)** | `/enable pw JITOSOL/USDT@OKX 1% smart prevent -y` |
| **Price Watcher (legacy SOL)** | `/enable pw SOL/USDT@Coinstore 1% smart prevent -y` — not recommended |
| **Liquidity (conservative)** | `/enable liq 0.5% 6 JITOSOL 600 USDT middle` |
| **Liquidity (moderate)** | `/enable liq 1% 8 JITOSOL 800 USDT middle` |
| **Order book** | `/enable ob 4 20%` or `/disable ob` |
| **Trade size / speed** | `/amount 0.5-1` · `/interval 30-120 sec` |
| **Start MM** | `/start mm optimal` |
| **Rates display** | `/rates JITOSOL/USDT` · `/rates SOL/USDT` |

There is no `/info pw`. Check `/params` for `mm_priceWatcherSource`.

### `/enable pw` syntax (what each part means)

```
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
           └─ source ─────┘ └%┘ └pol┘ └act┘ └confirm┘
```

| Part | Options | Plain English |
|------|---------|---------------|
| Source | `JITOSOL/USDT@OKX` | Fair price from OKX (recommended) |
| | `SOL/USDT@Coinstore` | Fair price from SOL × Jito multiplier (old method) |
| Deviation | `1%`, `2.5%`, etc. | How wide the allowed band is around fair |
| Policy | `smart` / `strict` | `smart` = depth-weighted bid/ask; `strict` = top of book only |
| Action | `prevent` / `fill` | `prevent` = bot refuses bad prices; `fill` = bot may trade to fix band |
| `-y` | optional | Skip confirmation prompt |

**Fallback** (`SOL/USDT@Coinstore`) is **not** set here — it is in `config.jsonc` only.

### `/enable liq` syntax

```
/enable liq 0.5% 6 JITOSOL 600 USDT middle
            └spread┘ └─ sell cap ─┘ └ buy cap ┘ └trend┘
```

Liq quotes are placed around the **Coinstore JITOSOL book**, then clamped partly by PW. See OPERATOR_GUIDE for the nuance.

---

## Config.jsonc (not Adamant)

Edit on VPS, then `pm2 restart tradebot`:

```jsonc
"exchanges": [ "Coinstore", "OKX", … ],
"okx_apikey": "…",
"okx_apisecret": "…",
"okx_apipassphrase": "…",
"pw_fallback_source": "SOL/USDT@Coinstore",
"pw_source_coefficient": 1.285
```

| Key | Changed via Adamant? |
|-----|----------------------|
| `okx_api*` | No — config only |
| `pw_fallback_source` | No — config only |
| `pw_source_coefficient` | No — config only |
| `mm_priceWatcherSource` | Yes — `/enable pw` |

---

## Healthy log signals (OKX era)

| Log | Meaning |
|-----|---------|
| `Active PW source: JITOSOL/USDT@OKX (direct, authenticated, no coefficient)` | **Good** — normal OKX primary |
| `Active PW source: JITOSOL/USDT@OKX (direct, keyless, no coefficient)` | OK — keys expired; renew when convenient |
| `within Pw's range` | Market activity inside band |
| `Liquidity: Opened N bids… M asks…` | Liq deployed |
| `Received info about N markets on Coinstore` | Startup OK |

## Warning signals

| Log | Meaning |
|-----|---------|
| `Falling back to SOL/USDT@Coinstore` | OKX fully down — band may shift ~$0.10 |
| `Applied cross-base coefficient` | On **fallback** or if you enabled SOL primary — expected then, **not** on OKX primary |
| `OKX API key rejected; using public keyless` | Renew OKX keys when you can |
| `429 Too Many Requests` | Slow down OB or widen MM interval |

## Red flags

| Symptom | Likely cause |
|---------|--------------|
| JITOSOL “fair” ~$65 (SOL spot level) | PW broken or wrong source |
| `1401` | Coinstore IP whitelist |
| `Applied cross-base coefficient` **while** `/params` shows `@OKX` and OKX is up | Misconfiguration — investigate |
| Band tracks Coinstore JITOSOL book (~1% above OKX) | Old anchor or PW disabled |

---

## Morning checklist

1. `pm2 logs tradebot --lines 40` — no startup errors
2. `/pair JITOSOL/USDT` — sane decimals
3. `/params` — `mm_priceWatcherSource: "JITOSOL/USDT@OKX"`
4. Grep `Active PW source` — OKX, no coefficient on primary
5. `/balances` — enough free after liq freezes
6. `/orders JITOSOL/USDT` — review `man` / `unk`

---

## Code handoff (helper does not edit repo)

| Issue | Where |
|-------|--------|
| Coinstore decimals | `trade/trader_coinstore.js` |
| PW / OKX connector | `trade/mm_price_watcher.js`, `trade/trader_okx.js` |
| IPv4 force | `trade/api/coinstore_api.js` |
