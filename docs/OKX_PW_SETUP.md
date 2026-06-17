# OKX Price Watcher — deploy & setup

**Purpose of this doc:** Get new code onto your VPS, add OKX API keys, restart the bot, and run the first `/enable pw`. For **day-to-day commands**, use [RUNBOOK.md](./RUNBOOK.md). For **how PW behaves**, use [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md).

---

## What you are setting up (plain English)

You are giving the bot permission to **look at OKX** for “what is JITOSOL worth in USDT?” The bot still **buys and sells on Coinstore**. OKX is not your trading exchange — it is the **fair-price thermometer**.

Three layers (you only configure the first two):

1. **OKX with API keys** — normal; best rate limits
2. **OKX without keys** — if keys expire, bot keeps using OKX public prices (you get a warning)
3. **Coinstore SOL fallback** — only if OKX is completely down; uses SOL price × Jito multiplier

You **cannot** turn layer 3 on/off from Adamant. It lives in `config.jsonc` as `pw_fallback_source`.

---

## Step 1 — OKX API key (read-only)

1. Log in to OKX → **API** → Create **V5** key
2. Permissions: **Read** only (no trade, no withdraw)
3. IP whitelist: your VPS IP (`31.97.71.71` and/or IPv6 if you use it)
4. Save all three strings OKX shows:
   - API Key
   - Secret Key
   - Passphrase

If the key expires later, the bot keeps working on OKX public data until you renew keys and restart.

---

## Step 2 — Edit `config.jsonc` on the VPS

Add or confirm these (Coinstore keys stay as they are):

```jsonc
"exchanges": [ "Coinstore", "OKX", … ],
"okx_apikey": "YOUR-OKX-KEY",
"okx_apisecret": "YOUR-OKX-SECRET",
"okx_apipassphrase": "YOUR-OKX-PASSPHRASE",
"pw_fallback_source": "SOL/USDT@Coinstore",
"pw_source_coefficient": 1.285
```

| Field | Plain English |
|-------|----------------|
| `okx_api*` | Required. Bot **will not start** if OKX is in `exchanges` and these are empty |
| `pw_fallback_source` | Emergency backup price source; never changed by `/enable pw` |
| `pw_source_coefficient` | Backup multiplier if Jito website is down **during fallback only** |

Backup before editing:

```bash
cp config.jsonc config.jsonc.bak.$(date +%Y%m%d%H%M%S)
```

---

## Step 3 — Deploy code & restart

```bash
# On VPS — pull/copy new code however you usually deploy
pm2 restart tradebot
pm2 logs tradebot --lines 40
```

**Healthy startup logs:**

```
Config reader: OKX API credentials loaded for PW source connector.
Config reader: pw_fallback_source is set to SOL/USDT@Coinstore.
```

If the bot exits immediately, check OKX keys and `pw_fallback_source` format (`PAIR@Exchange`).

---

## Step 4 — Enable Price Watcher (Adamant)

Stop MM first if it was running on the old anchor:

```
/stop mm
/clear JITOSOL/USDT liq
```

Enable OKX PW:

```
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
```

Confirm in logs:

```bash
pm2 logs tradebot --lines 100 | grep -E 'Active PW source|cross-base coefficient|Falling back'
```

**Good (OKX working):**

```
Active PW source: JITOSOL/USDT@OKX (direct, authenticated, no coefficient).
```

**Bad on a healthy OKX day:** `Applied cross-base coefficient` or `Falling back to SOL/USDT@Coinstore` — means you are not on OKX primary; investigate.

---

## Step 5 — Conservative liq & MM (after PW validated)

```
/enable liq 0.5% 6 JITOSOL 600 USDT middle
/interval 30-120 sec
/start mm optimal
```

Only tighten intervals and raise liq caps after ~24h of stable OKX logs.

---

## Pre-live checklist

- [ ] Code deployed; `pm2 restart tradebot` succeeds
- [ ] `config.jsonc` has OKX keys + `pw_fallback_source`
- [ ] Optional: `node tests/jitosol-anchor-live.js` on a machine with internet
- [ ] `/stop mm`; clear old liq if needed
- [ ] `/enable pw JITOSOL/USDT@OKX 1% smart prevent -y`
- [ ] Logs: `Active PW source: JITOSOL/USDT@OKX` — **no** coefficient line on primary path
- [ ] `/params` shows `mm_priceWatcherSource: "JITOSOL/USDT@OKX"`
- [ ] Re-enable liq conservatively; MM last

---

## Key rotation (OKX key expired)

1. Bot **keeps running** on OKX public API — fair price still from OKX
2. Look for: `OKX API key rejected; using public keyless`
3. Create new Read-only key on OKX
4. Update `okx_api*` in `config.jsonc` → `pm2 restart tradebot`

---

## Local tests (optional, on your laptop)

```bash
node tests/jitosol-anchor-live.js
node tests/jitosol-okx-pw-logic.js
node tests/okx-api-auth-fallback.test.js
```

No bot config required for the live HTTP test.
