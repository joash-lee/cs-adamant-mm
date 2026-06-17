# Troubleshooting — Coinstore JITOSOL/USDT bot

When something breaks, paste **Adamant output** + **`pm2 logs tradebot --lines 80`**. See [RUNBOOK.md](./RUNBOOK.md) for correct commands; [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md) for behaviour.

---

## Price Watcher / OKX anchor

### Healthy (OKX primary)

**`/params` shows:**

```
mm_priceWatcherSource: "JITOSOL/USDT@OKX"
mm_priceWatcherDeviationPercent: 1  (or your chosen %)
mm_priceWatcherAction: "prevent"
```

**Logs show:**

```
Active PW source: JITOSOL/USDT@OKX (direct, authenticated, no coefficient).
```

**You should NOT see** (while OKX is up): `Applied cross-base coefficient`, `Falling back to SOL/USDT@Coinstore`.

---

### OKX API key expired (still OK)

**Symptoms:** Warn about keyless; band still tracks OKX.

**Logs:**

```
OKX API: Authenticated request failed (...). Retrying public keyless request.
Active PW source: JITOSOL/USDT@OKX (direct, keyless, no coefficient).
```

**Fix (when convenient):** New Read-only OKX key → update `okx_api*` in `config.jsonc` → `pm2 restart tradebot`. See [OKX_PW_SETUP.md](./OKX_PW_SETUP.md).

---

### OKX fully down (automatic fallback)

**Symptoms:** Notify/warn about fallback; band may shift slightly (~$0.10 vs OKX).

**Logs:**

```
Primary source JITOSOL/USDT@OKX unavailable (...). Falling back to SOL/USDT@Coinstore.
Applied cross-base coefficient 1.285…
Active PW source: SOL/USDT@Coinstore (fallback, cross-base, coefficient applied).
```

**Plain English:** Bot is using Coinstore SOL price × Jito multiplier — the **old** method as emergency backup.

**Fix:** Wait for OKX connectivity; or check VPS outbound HTTPS. Fallback is automatic — no Adamant command.

**Config involved:** `pw_fallback_source`, `pw_source_coefficient` (if Jito API also down).

---

### Wrong fair price (~$65 or tracks Coinstore JITOSOL book)

| Symptom | Likely cause |
|---------|--------------|
| Fair ~$65 (SOL spot) | PW off, wrong source, or coef broken |
| Fair ~$94+ while OKX ~$93 | Primary still `SOL/USDT@Coinstore` or PW disabled; venue book loop |
| `coefficient` on OKX primary day | Bug or fallback active — grep `Active PW source` |

**Fix:**

```
/stop mm
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
```

Verify `/params` and logs. See RUNBOOK cutover sequence.

---

### Legacy: SOL as *primary* (you chose it)

If you explicitly ran `/enable pw SOL/USDT@Coinstore …`, logs **will** show `Applied cross-base coefficient` every cycle — that is expected for that mode.

To return to OKX:

```
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
```

---

## Gate A — Coinstore auth (`1401`)

**Layman:** Coinstore rejects login — usually wrong IP leaving the server.

```bash
curl -s https://ifconfig.me && echo
curl -s -4 https://api.ipify.org && echo
curl -s -6 https://api.ipify.org && echo
```

**Fix:** Whitelist VPS IPv4 **and** IPv6 on Coinstore API key, or force IPv4 (see RUNBOOK / old notes below).

Canary: `/balances` without `1401`.

---

## Gate B — Pair not found

**Layman:** Bot started before Coinstore listed the pair; cache is stale.

```
/pair JITOSOL/USDT
pm2 restart tradebot
```

---

## Gate B — Order rejected `3011` / `3013`

| Code | Meaning |
|------|---------|
| 3011 | Symbol not tradable for this key |
| 3013 | Account not whitelisted for spot |

Not fixed by restart alone.

---

## Decimals trap

**Symptoms:** `After rounding to 0 decimal places` · whole JITOSOL only.

**Workaround:** `/amount 1-4` · integer sizes until `/pair` shows real decimals.

---

## Empty / one-sided order book

MM and PW need **both** bid and ask. Seed with `/fill` or manual orders on both sides.

---

## Bot won't start after OKX update

**Layman:** New code requires OKX keys in config.

**Exit message examples:**

- `Field _okx_apikey_ is required when OKX is in exchanges`
- `Field _pw_fallback_source_ is required`

**Fix:** Add keys + `"pw_fallback_source": "SOL/USDT@Coinstore"` to `config.jsonc` → restart. See OKX_PW_SETUP.

---

## Self-trade / 429

Pre-market: self-trade warnings normal. **429:** `/disable ob`, widen `/interval`.

---

## Coinstore error codes

| Code | Meaning |
|------|---------|
| 1401 | IP whitelist |
| 3011 | Symbol not found |
| 3013 | No spot qualification |
| 3113 | Insufficient balance |

---

## Key repo paths

| Path | Role |
|------|------|
| `trade/mm_price_watcher.js` | PW band, OKX primary, fallback |
| `trade/trader_okx.js` | OKX read-only connector |
| `trade/api/okx_api.js` | Auth + keyless retry |
| `helpers/cryptos/jitoCoefficient.js` | Jito multiplier (fallback path) |
| `modules/commandTxs.js` | `/enable pw` handling |
| `config.jsonc` | OKX keys, `pw_fallback_source` |

---

## Ignore (usually)

- `Failed to get Txs in check()` — ADAMANT messenger
- `Unable to calculate JITOSOL price in USD` — Infoservice gap
- `Unknown cryptos JITOSOL` on `/balances` USD total
