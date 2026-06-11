# JITOSOL/USDT Coinstore MM — Runbook

## Deployment

| Item | Value |
|------|--------|
| Exchange | Coinstore |
| Pair | `JITOSOL/USDT` (always use slash; `jitosolusdt` triggers perpetual error) |
| VPS | `srv935443` |
| IPv4 whitelist | `31.97.71.71` |
| IPv6 whitelist | `2a02:4780:5e:64b::1` (both required) |
| Bot process | `pm2 restart tradebot` / `pm2 logs tradebot` |
| Config | `config.jsonc` in bot root (not editable via `/params`) |
| tradeParams | Persisted per exchange; survives restart |

## Three gates (mental model)

1. **Gate A — Auth:** `/balances` works, no `1401` in logs.
2. **Gate B — Pair in bot cache:** After `pm2 restart`, `/pair JITOSOL/USDT` returns market info (not "not found"). Market list loads **once at startup**.
3. **Gate C — Capital:** USDT + JITOSOL funded; free balance after liq/ob freezes.

Pre-market: pair may be in tickers but not in symbol-config catalog; whitelist may be required for `placeOrder`.

---

## Phase 1 — Pre-market bootstrap

```bash
# VPS
pm2 restart tradebot
pm2 logs tradebot --lines 60
```

Adamant — verify:

```
/pair JITOSOL/USDT
/balances
```

Seed book (whole numbers until decimals confirmed):

```
/stop mm
/clear JITOSOL/USDT man
/fill JITOSOL/USDT buy quote=400 low=81 high=84 count=3
/fill JITOSOL/USDT sell amount=3 low=84 high=87 count=3
/orders JITOSOL/USDT
```

Enable modules:

```
/enable pw SOL/USDT@Coinstore 3% smart prevent
/enable liq 2% 12 JITOSOL 1200 USDT middle
/enable ob 6 20%
/amount 1-4
/interval 10-40 sec
/buypercent 0.5
/start mm optimal
/params
```

**Config fallback** (VPS `config.jsonc`, then restart):

```jsonc
"pw_source_coefficient": 1.2842,
```

```bash
cp config.jsonc config.jsonc.bak.$(date +%Y%m%d%H%M%S)
# add key after "pair" line, then:
node -e "const j=require('jsonminify');const f=require('fs');const c=JSON.parse(j(f.readFileSync('config.jsonc','utf8'))); console.log('pw_source_coefficient =', c.pw_source_coefficient);"
pm2 restart tradebot
```

Jito API stays primary; config is fallback if API blips.

---

## Phase 2 — Opening day (tune after real volume)

When external trades appear in `/stats` and self-trade noise drops:

```
/interval 5-22 sec
/disable ob
/enable ob 8 25%
```

After Coinstore publishes real tick/lot sizes **and** `/pair` shows sane decimals:

```
/amount 0.5-3
```

Optional tighter PW:

```
/disable pw
/enable pw SOL/USDT@Coinstore 2.5% smart prevent
```

Morning checklist:

1. `pm2 restart tradebot` once symbol config lists JITOSOLUSDT.
2. `/pair JITOSOL/USDT` — decimals not `0`.
3. Optional `/clear JITOSOL/USDT man` for clean bot-only book.
4. `/balances` — ≥1,500 free USDT and ≥10 free JITOSOL after liq.
5. Logs: `Applied cross-base coefficient` and `within Pw's range`.

---

## Recommended params (opening-day profile)

| Param | Value | Notes |
|-------|--------|--------|
| `mm_Policy` | `optimal` | With liq on |
| `mm_minAmount` / `mm_maxAmount` | `1`–`4` | Until fractional decimals verified |
| `mm_minInterval` / `mm_maxInterval` | `10s`–`40s` open; `5s`–`22s` after volume | Reduces self-trade pre-open |
| `mm_buyPercent` | `0.5` | Neutral |
| `mm_orderBookOrdersCount` | `6` then `8` | Via `/enable ob` |
| `mm_liquiditySpreadPercent` | `2%` | |
| `mm_liquidityBuyQuoteAmount` | `1200` USDT | |
| `mm_liquiditySellAmount` | `12` JITOSOL | |
| PW source | `SOL/USDT@Coinstore` | |
| PW deviation | `3%` (or `2.5%`) | |
| PW policy / action | `smart` / `prevent` | Not `fill` on launch |

---

## Adamant command cheat sheet

| Goal | Command |
|------|---------|
| Status | `/params` `/stats JITOSOL/USDT` `/orders JITOSOL/USDT` `/balances` |
| Rates (display) | `/rates JITOSOL/USDT` `/rates SOL/USDT` |
| Stop MM | `/stop mm` |
| Clear orders | `/clear JITOSOL/USDT all` or `man` / `ob` / `liq` |
| Manual test buy | `/buy JITOSOL/USDT amount=1 price=80` |
| PW | `/enable pw SOL/USDT@Coinstore 3% smart prevent` |
| Liq | `/enable liq 2% 12 JITOSOL 1200 USDT middle` |
| OB | `/enable ob 6 20%` |
| Amount / interval | `/amount 1-4` `/interval 10-40 sec` |
| Start | `/start mm optimal` |

There is no `/info pw`; use `/params`.

---

## Healthy signals (pm2 logs)

- `Received info about N markets on Coinstore` (N ≥ 487 with JITOSOL)
- `Applied cross-base coefficient 1.284… (fresh)` from price watcher
- `Set a price range from … USDT` tracking SOL × coefficient
- `JITOSOL is within Pw's range`
- MM placing ob/liq orders without endless `doNotExecute`

## Expected noise (usually OK)

- Self-trade cancel warnings on thin pre-market book
- `Unable to calculate JITOSOL price in USD` (Currencyinfo has no JITOSOL)
- ADAMANT node health-check warnings (messenger, not Coinstore)
- Transient `Unable to receive balances` at MM start

## Red flags

- JITOSOL prices near raw SOL (~$65) instead of ~$84 → PW/coefficient broken
- `1401` on authenticated calls → IP whitelist / auth
- `3011` / `3013` on orders → listing or account whitelist
- `Unable to get order book` with only one side → need both bid and ask
- `After rounding to 0 decimal places` → decimals trap; use integers or code patch

---

## Code changes (hand off — do not apply from helper)

| Issue | Files | Notes |
|-------|--------|--------|
| Pre-market decimals | `trade/trader_coinstore.js` | Empty ticker → safe default decimals |
| Symbol config merge | `trade/trader_coinstore.js`, `trade/api/coinstore_api.js` | Real tick/lot when listed |
| IPv4 force | `trade/api/coinstore_api.js` | Only if whitelist can't add IPv6 |

Helper outputs a **plan block** for a separate coding agent; it does not edit the repo.
