# Coinstore JITOSOL/USDT — ops docs for `/cs-mm-helper`

These files are the **only** context the `cs-mm-helper` slash command uses. Read them in order when diagnosing or planning.

| File | Use when |
|------|----------|
| [RUNBOOK.md](./RUNBOOK.md) | Setup, pre-market → opening day, params, Adamant & VPS commands |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Errors, gates, decimals trap, log patterns, health checks |

**Pair:** `JITOSOL/USDT` on **Coinstore** · **VPS:** `srv935443` · **Process:** `pm2` name `tradebot`

**Price anchor:** PW source `SOL/USDT@Coinstore` × Jito coefficient (~1.284). Not stale JITOSOL ticker prices.

**Last ops snapshot:** 2026-06-11 — MM optimal, PW smart/prevent 3%, wallet ~5k USDT + ~45 JITOSOL, book seeded, coefficient live in logs.
