# Coinstore JITOSOL/USDT — operator docs

These files explain how the bot works after the **OKX price anchor** update. Start here if you are not sure which doc to open.

**Pair:** `JITOSOL/USDT` on **Coinstore** · **VPS:** `srv935443` · **Process:** `pm2` name `tradebot`

---

## Which doc do I read?

| Doc | Read this when you want… |
|-----|---------------------------|
| **[RUNBOOK.md](./RUNBOOK.md)** | **Command reference** — exact `/enable`, `/start`, `/clear` commands for day-to-day and cutover. **This is your Adamant cheat sheet.** |
| **[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md)** | **How it behaves in plain English** — PW vs liq vs MM, what “fair price” means, monitoring, risks, log lines explained |
| **[OKX_PW_SETUP.md](./OKX_PW_SETUP.md)** | **One-time deploy** — new code on VPS, OKX API keys in `config.jsonc`, restart, first `/enable pw`, pre-live checklist |

**Short answer:** Use **RUNBOOK** for commands. Use **OPERATOR_GUIDE** to understand behaviour. Use **OKX_PW_SETUP** only when deploying or rotating OKX keys.

| **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** | **Something broke** — auth errors, wrong prices, OKX down, fallback activated, decimals trap |

External generic command list: [marketmaking.app](https://marketmaking.app/cex-mm/command-reference) — our **RUNBOOK** has JITOSOL-specific values.

---

## The big idea (30 seconds)

**Before:** The bot guessed “fair” JITOSOL price from Coinstore’s own JITOSOL book (or SOL × a multiplier). That could drift ~1%+ above real market and create a feedback loop.

**Now:** Fair price comes from **OKX JITOSOL/USDT** — a real external exchange. No multiplier on that path.

**If OKX dies completely:** The bot falls back to **Coinstore SOL/USDT × Jito coefficient** (configured in `config.jsonc` as `pw_fallback_source`). You do not set fallback via Adamant.

**You still trade on Coinstore.** OKX is read-only — for pricing only.

---

## Recommended live commands (2026 cutover)

```
/enable pw JITOSOL/USDT@OKX 1% smart prevent -y
/enable liq 0.5% 6 JITOSOL 600 USDT middle
/stop mm
```

Turn MM back on only after logs show OKX fair price for 24h. Details in RUNBOOK and OKX_PW_SETUP.

---

## Price anchor summary

| Mode | When | Fair price from |
|------|------|-----------------|
| **OKX primary** | Normal | OKX JITOSOL bid/ask (no coefficient) |
| **OKX keyless** | OKX API key expired | Same OKX public data (no Coinstore fallback) |
| **Coinstore fallback** | OKX fully unreachable | Coinstore SOL × ~1.285 Jito coefficient |

Always confirm live state with `/params` and `grep 'Active PW source' pm2 logs`.
