# Trading forensics — `scripts/fill-forensics.js`

**Use this when** the wallet looks wrong, a client asks "where did the money go?", or as a routine monthly check.
It answers, from the bot's own logs: how much value the bot made or lost vs simply holding, **which part of the bot**
did it, **when**, and **whether the answer can be trusted**.

Findings from the first use (Sep 2026 loss): [incidents/2026-09-21-loss-diagnosis.md](./incidents/2026-09-21-loss-diagnosis.md).
Terms: [CONTEXT.md](../CONTEXT.md).

---

## What it is

- A read-only Node script. It does **not** load the bot, call any exchange, or touch orders. Safe to run while the
  bot is live (use `nice` so it doesn't compete for CPU).
- Input: the bot's text logs in `logs/*.log` on the VPS (one file per bot start, never deleted by the bot).
- It rebuilds every fill from log lines, prices each one against the Price watcher's fair price at that moment, and
  prints a report.

Since Sept 2026 the bot also writes a live fill log (`logs/fills-YYYY-MM-DD.jsonl`, see RUNBOOK → Fill log) and a
daily report. Use those for day-to-day. Use this script for **any period**, for periods before the fill log existed,
and as an independent second opinion.

---

## How to run (on the VPS, in `~/adamant-tradebot`)

```bash
nice -n 19 node scripts/fill-forensics.js \
  --from 2026-06-11 \
  --start-usdt 5000 --start-coin 45 \
  --end-usdt 12.75 --end-coin 43.53 \
  --csv fills.csv \
  logs/*.log > forensics.txt 2>&1
cat forensics.txt
```

| Option | Meaning |
|---|---|
| `--from` / `--to YYYY-MM-DD` | UTC date range to count. Default: everything in the files. |
| `--start-usdt` / `--start-coin` | Wallet at the start of the range. Needed for the balance curve. |
| `--end-usdt` / `--end-coin` | Wallet now (`/balances`, free + frozen). Needed for the **trust check**. |
| `--fee <pct>` | Fee % per side, only for a fee estimate line. Our Coinstore account behaves as ~0 fee. |
| `--markout <min>` | Markout horizon, default 5 minutes. |
| `--csv <file>` | Every fill as a spreadsheet row. |

Takes a few minutes for ~3 GB of logs. Progress (lines, fills, memory) prints every 2M lines.

---

## How to read the report — in this order

1. **Reconciliation (the trust check) — read first.**
   - *"Value and coin balances reconcile"* → trust everything.
   - *"Total VALUE reconciles … coin SPLIT does not"* → totals (result vs holding, edge, by source) are trustworthy;
     read the weekly balance path loosely. (This was the Sept 2026 result: value gap −$38 on $11.5k.)
   - *"Value does NOT reconcile"* → there are fees, transfers, or missed fills of real size. Don't conclude yet —
     check the data-quality section and any deposits/withdrawals in the period.
2. **SUMMARY** — result vs holding, split into *edge vs fair* and *inventory*, plus markout, drawdown, and the date liq
   first ran out of one side.
3. **BY SOURCE** — which module made or lost it (`liq`, `mm-book`, …).
4. **DATA QUALITY** — how every fill signal was classified; the `UNCONFIRMED` line is kept out of the totals.
5. **WEEKLY / ESTIMATED BALANCES / WORST DAYS** — timing.

**Quick diagnosis table**

| Pattern | Meaning |
|---|---|
| `mm-book` edge strongly negative, `liq` ≥ 0 | Paying the spread to make volume (the `optimal` policy crossing the book). |
| `liq` edge negative **and** markout much worse than edge | Resting quotes being picked off (stale-quote arbitrage). |
| Inventory large, edge small | Result driven by holding more/less coin while price moved, not by trading. |
| `0bid%` jumps to high % | USDT ran out; liq can't bid. The date is when the wallet became one-sided. |
| Value doesn't reconcile | Fees, transfers, or fills the logs don't show. |

---

## Limits (know these before trusting a number)

- **Fair price** is the Price watcher's mid at the time. Before Aug 2026 that was Coinstore SOL × JitoSOL/SOL
  coefficient (approximate); since then OKX JITOSOL/USDT.
- **Fees and transfers are not in the logs.** The trust check detects them; the script can't itemise them.
- **Log gaps** (bot down, e.g. 2026-07-31 → 08-04) are invisible.
- `executeInSpread` self-trades are counted as volume only (they net to zero except fees).
- mm taker trades use the bot's follow-up status line; trades without one go to `UNCONFIRMED`.

## Keeping it working

The script depends on the **wording of bot log lines** (e.g. `Unable to cancel order … pair: FILLED`,
`taker executeInOrderBook mm-order status is part_filled (x% filled)`, `pre-deviation a–b`).

- `tests/fill-forensics.test.js` runs the script on `tests/fixtures/forensics-sample.log` (real line shapes).
  `npm test` fails if the classification breaks. **If you change a log message in `trade/`, run `npm test`.**
- If the bot's `log_level` is lowered below `log`, the fill lines disappear. Keep `"log_level": "log"`.
- Log files are never rotated (one reached 2 GB). Check disk now and then: `df -h` and `du -sh logs/`.
  Don't delete old logs without archiving them first — they are the only history (Coinstore keeps ~2 days).
