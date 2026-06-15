# Coinstore JITOSOL/USDT — ops docs for `/cs-mm-helper`

These files are the context the `cs-mm-helper` slash command uses. Read them when diagnosing or planning.

| File | Use when |
|------|----------|
| **[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md)** | **Live MM concerns:** PW/LIQ/OB/MM/MAN, liq risk in USDT, adversarial orders, monitoring, rebalance, restart, log patterns |
| [RUNBOOK.md](./RUNBOOK.md) | Setup, pre-market → opening day, params, Adamant & VPS commands |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Errors, gates, decimals trap, log patterns, health checks |

**Pair:** `JITOSOL/USDT` on **Coinstore** · **VPS:** `srv935443` · **Process:** `pm2` name `tradebot`

**Price anchor:** PW source `SOL/USDT@Coinstore` × Jito coefficient (~1.284). Not stale JITOSOL ticker prices.

**Baseline snapshot (2026-06-15):** Opening day, `optimal` MM, PW **2.5%** smart/prevent, liq **2% / 12 JITOSOL / 1200 USDT**, OB **8** (watch 429), wallet ~**42 JITOSOL + ~5160 USDT**. Always confirm with fresh `/params` and `/balances`.
