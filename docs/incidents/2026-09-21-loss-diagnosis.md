---
title: Loss diagnosis — Coinstore JITOSOL/USDT, Jun–Sep 2026
date: 2026-09-21
tags: [incident-2026-09-21, forensics, jitosol-usdt, coinstore, mm-policy]
source: scripts/fill-forensics.js over VPS logs/*.log (2026-06-11 → 2026-09-21), see docs/FORENSICS.md
related: [docs/logs/2026-09-21-adamant-bot-log.md, docs/logs/2026-09-21-tradebot-log.md] (local, git-ignored)
---

# Loss diagnosis — what really happened (Jun–Sep 2026)

## One-line answer

The bot **paid the spread to make volume**. The `optimal` MM policy sent ~80% of volume trades straight into
Coinstore's real order book — buying at the ask, selling at the bid — thousands of times a day. Each round trip lost a
little USDT and gave the JITOSOL back, so **USDT drained while JITOSOL stayed flat**, until liq had no USDT to bid
(week of Sep 7).

## Is the answer trustworthy?

Yes, on total value. Fills rebuilt from the logs explain the wallet to within **−$38 (0.3% of start value)**, with no
fees or transfers needed. Independent check: vs simply holding, the wallet is −$5,202; the logs say −$5,163.
The USDT/JITOSOL **split** is off by ~48 JITOSOL somewhere, so exact dates on the balance path are approximate.

## Numbers (2026-06-11 → 2026-09-21)

| | Result vs fair price |
|---|---|
| `mm-book` (MM taker trades into the real book) | **−$8,597** (bought avg 101.47, sold avg 100.38: −1.07% per round trip on $3.8M) |
| `liq` (resting liquidity orders) | **+$815** (earned) |
| Inventory (held a bit more JITOSOL while price rose 84 → 145) | **+$2,618** |
| **Total vs holding** | **≈ −$5,200** |

- Turnover $7.8M + $2.2M self-trades ≈ $78k/day — the volume KPI was met; this was its cost.
- Worst days: launch **Jun 15–17 (≈ −$2,400)**; then ~−$250/week in July; −$650 to −$1,000/week from mid-August.
- USDT ran out: liq `0bid%` = 0% every week until **week of Sep 7 (65%)**, then 97%, 100%.

## What we believed before, and was wrong

| Earlier assumption | Finding |
|---|---|
| Stale quotes were arbitraged (picked off) | **Not supported.** Liq earned money; 5-min markout ≈ edge (no extra adverse move). |
| Fees might explain it | **No.** Value reconciles with ~zero fees. |
| USDT ran out in June | **No.** Early September. |
| The price rise hurt us | **No.** It helped (+$2.6k). |

## What we learnt (process)

- The bot's own text logs (`logs/*.log`, never deleted) held the full history back to May. Coinstore only keeps ~2
  days — **the VPS logs are the record**.
- Log lines must be read with care: `Unable to cancel … Probably it doesn't exist anymore` is a fill only when the
  exchange replied `FILLED`; `Successfully executed mm-order … executeInOrderBook` is only *sent* — the fill is in
  the next status line (`filled` / `part_filled x%` / `cancelled`). Treating both as fills produced a false
  −$209k result on the first run.
- **Always reconcile against the real wallet before believing a diagnosis.** The reconciliation line caught the
  wrong run immediately.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Run MM with the `spread` policy (self-trade inside the spread; pays no spread) instead of `optimal` | Operator — recovery plan |
| 2 | Keep liq caps small and PW `JITOSOL/USDT@OKX 0.5% smart prevent` | Operator — recovery plan |
| 3 | Alerts + live fill log + daily report (side_empty = the "0 bids" alarm) | Built (alerts T1–T8); deploy by restart when ready |
| 4 | Check the Coinstore fee tier for the account (logs imply ~0) | Operator |
| 5 | Check Coinstore rules / client agreement on self-trading (wash trading) under `spread` | Operator / business |
| 6 | Count "third-party bot intervention" in old logs: `grep -hc "third-party bot intervention" logs/2026-0[6-9]*.log` — how often other bots snipe `spread` self-trades | Operator |
| 7 | Run `scripts/fill-forensics.js` monthly and after any surprise (docs/FORENSICS.md) | Routine |
| 8 | Watch disk: logs are never rotated (one file hit 2 GB) | Routine |

## Open / not explained

- ~48 JITOSOL / ~$7k split mismatch (value-neutral at today's price). Likely mis-sided/mis-dated fills; not chased.
- No logs 2026-07-31 → 08-04.
- 596 mm taker trades with no status line (reported as UNCONFIRMED).
