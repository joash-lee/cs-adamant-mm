# Handoff — liq safety guards (small code build)

Status: **SUPERSEDED by `handoff-tradebot-alerts.md` (2026-09-21) — do not build** · Written: 2026-09-21 · Owner: Joash · Executor: one cloud session (Cursor cloud / CC cloud)
Read first: `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/RUNBOOK.md`, `docs/OPERATOR_GUIDE.md`,
`docs/logs/2026-09-21-adamant-bot-log.md`, `docs/logs/2026-09-21-tradebot-log.md`.

## 1. Why this exists (short)

ADAMANT tradebot market-makes **JITOSOL/USDT on Coinstore** (VPS pm2 `tradebot`, controlled by ADAMANT messenger
commands). On 2026-09-21 the operator found the wallet at 12.75 USDT + 43.53 JITOSOL (started ~5,000 USDT + ~45 JITOSOL
in June). We assume (cannot prove; trade history >2 days is gone) the loss came from **stale quotes being arbitraged +
one-sided inventory**. Evidence from logs: 0 bids placed every cycle (no USDT), 429 rate limits, failed cancels, Coinstore
book dislocated (bid 61.05 / ask 144.24 vs OKX fair ~145), PW check passing with an 81% spread.

Recovery is happening **by operator params, not code**: policy `spread` (was `optimal`, which sent 80% of MM trades into the
real book), liq 1.5%/15 JITOSOL/2150 USDT with `ss`, PW `JITOSOL/USDT@OKX 0.5% smart prevent`, kill switch by hand.
This build is a **small, tabled add-on** that makes the next failure loud and bounded. It must not change how the bot trades.

## 2. HARD constraints (read twice)

1. **No change to trading semantics on the healthy path.** Do not touch liq pricing/anchor, MM policies, PW band math,
   order sizing, or `orderCollector` behaviour. New code = guards, alerts, logging, docs, one standalone script.
2. **Do NOT block liq bootstrapping.** After a `/clear` the Coinstore book is junk and the bot's own liq orders are what
   repair it. Any "book looks dislocated → stop liq" rule would deadlock. (Rejected idea, see §7.)
3. Every new threshold is a **config key with a default**, read via `modules/configReader.js`, documented in
   `config.default.jsonc`. Missing key = default. No new required fields (bot must still start on the existing VPS config).
4. New guards default to **warn/alert**, never auto-stop, except S1 (stale OKX quote → treat primary unavailable, which
   just triggers the existing fallback).
5. Never put secrets in code, logs, tests or docs. No SSH/VPS/exchange calls from this session. Tests must mock the network.
6. Work on a branch, open a PR. **Do not merge, do not push to `main`.** Operator reviews, merges, deploys, restarts
   (a `pm2 restart` leaves orders on the book — operator handles that).
7. Match the surrounding code style (JSDoc, 2-space, `log.log/warn`, `notify(msg, type, silent, isPriority)` from `helpers/notify.js`).

## 3. Verified repo facts (do not re-derive)

- PW source flow: `trade/mm_price_watcher.js` `setPriceRange()` → `computeRangeFromSource(primary,false)`; on `!ok` and
  `config.pw_fallback_source` set → `computeRangeFromSource(fallback,true)` + notify (rate-limited by
  `FALLBACK_NOTIFY_INTERVAL_MS`, 1h). Fallback is triggered **only when the request fails/returns no data**, never on a bad or stale value.
- Coefficient is applied **only for cross-base sources** (`isCrossBase`, e.g. `SOL/USDT@…`). Direct `JITOSOL/USDT@OKX` never
  gets a coefficient (log: `Active PW source: … (direct, authenticated, no coefficient)`).
- Coefficient tiers (`helpers/cryptos/jitoCoefficient.js`): live Jito API (cached, refresh 6h) → Jupiter cross-check →
  static `config.pw_source_coefficient` → else fail closed. Log lines `Applied cross-base coefficient 1.30xxxx (fresh)` mean
  the live API was used. The static value is the **third** tier only.
- OKX connector: `trade/trader_okx.js` `getRates()` reads `/api/v5/market/ticker` (`bidPx, askPx, last, vol24h, …`) but
  **drops the ticker `ts`** — no staleness check exists. `trade/api/okx_api.js` has public endpoints incl. `/market/ticker`,
  `/market/books`, `/market/trades`, `/market/candles`-style access via `publicMarketGet`.
- Existing anomaly pattern to reuse: `ALLOWED_GLOBAL_RATE_DIFFERENCE_PERCENT` / `GLOBAL_RATE_DIFFERENCE_ACTION`
  (inert for JITOSOL because Infoservice has no JITOSOL rate — that is why an OKX-vs-SOL check is missing).
- Notifications: `helpers/notify.js` supports ADAMANT / Slack / Discord, plus `*_priority` channels
  (`adamant_notify_priority`, `slack_priority`, `discord_notify_priority`).
- This fork's `/enable` accepts only `ob`, `liq`, `pw` (`validateFeature` in `modules/commandTxs.js`). No Balance Watcher.
- Tests: Jest (`npm test`), existing files in `tests/` (`okx-api-auth-fallback.test.js`, `jitosol-okx-pw-logic.js`, …). Lint: `npm run lint`.
- Live numbers for realistic fixtures (2026-09-21): OKX JITOSOL-USDT ≈ 145.0 (bid 145.12/ask 145.32), OKX SOL-USDT ≈ 111.46,
  JitoSOL/SOL ≈ 1.3012. OKX JITOSOL book is thin (~9 JITOSOL top of book, ~1–2 JITOSOL/hour overnight) and can swing 2–3%/hour.
  Coinstore public depth: `https://api.coinstore.com/api/v1/market/depth/JITOSOLUSDT?depth=10` (`data.a` asks, `data.b` bids).
- Operator's KPIs (for S5): spread < 1.5%; depth ±2% > $2,000 on **each** side; 24h volume $50–100k; volume/depth ≤ 100.
- Timezones: bot logs are UTC; operator messenger times are UTC+8.

## 4. Slices (build in this order; one commit each; each independently testable)

**Before code:** per `docs/agents/issue-tracker.md`, create the Linear issues for S1–S6 (one per slice, ≤10-line bodies:
What to build / Acceptance / Blocked by). Set only structural fields (project, parent, blocked-by). Do not set priority,
labels, status. If Linear MCP is unavailable, say so in the PR description and proceed — do not invent ticket ids.

### S1 — OKX quote freshness guard
- `trader_okx.js getRates()`: also return `ts` (number, ms) from the ticker.
- In `computeRangeFromSource` for an OKX direct source: if `Date.now() - ts > PW_MAX_QUOTE_AGE_MS`
  (config `pw_max_quote_age_ms`, default 120000) → return `{ ok:false, errorMessage:'OKX quote stale (age Xs)' }` so the
  existing fallback path runs. Missing `ts` = do not block (backward compatible).
- Accept: unit tests — fresh ts unchanged result; stale ts → `ok:false`; missing ts → unchanged. Fallback notify still rate-limited.

### S2 — OKX vs SOL×coefficient divergence check (read-only)
- After a successful **direct** OKX range, compute a reference = OKX `SOL-USDT` mid × `jitoCoefficient.getCoefficient()`
  (fall back to config coef if API tier fails; skip silently if neither available). Use the existing OKX public client; 1 extra
  request per PW cycle max, cached ≥60s.
- If |OKX JITOSOL mid − reference| / reference > `pw_divergence_percent` (default 1.5) → `log.warn` + priority `notify`
  (rate-limited 10 min per direction). Config `pw_divergence_action`: `warn` (default) | `block` (treat as `ok:false` → fallback).
  Default MUST be `warn`.
- Accept: tests for within-tolerance / over-tolerance / reference unavailable / action=block. No effect on band values when action=warn.

### S3 — Alerts for bad states (no behaviour change)
Priority notify (rate-limited 10 min per key, all via `helpers/notify.js`) when:
  a) liq places **0 bids or 0 asks** for `liq_zero_side_cycles` (default 5) consecutive cycles (`trade/mm_liquidity_provider.js`
     already logs `Opened N bids…`; hook where that string is built, do not alter placement logic);
  b) ≥ `api_429_alert_count` (default 10) Coinstore 429s within 5 min (`trade/trader_coinstore.js` / request wrapper);
  c) `orderCollector` clear finishes with failed cancels or "Unable to receive … open orders" — include the failed order ids;
  d) PW fallback notify (already exists) is sent to the priority channel too.
- Accept: unit tests with fake counters/clock; alert fires once per window; no alert spam; messages contain pair + counts.

### S4 — Equity logger (+ optional drawdown alert)
- New small module started from `app.js` next to other schedulers. Every `equity_log_interval_sec` (default 300) append one JSON
  line to `logs/equity-YYYY-MM-DD.jsonl`: `{ts, usdtFree, usdtLocked, jitosolFree, jitosolLocked, pwMid, source, equityUsdt}`;
  `pwMid` from the PW module's current range midpoint (no new API call); equity = USDT + JITOSOL×pwMid.
- Optional alert: if equity < `equity_drawdown_alert_percent` (default 0 = off) below the day's first record → priority notify.
  Alert only, never stops trading. Document that transfers cause false alarms.
- Accept: test writes a line with mocked balances/price; handles missing price (logs null, no crash); file rolls per UTC day.

### S5 — Standalone KPI watchdog script (does NOT import the bot)
- `scripts/kpi-watch.js` (plain Node, axios already a dependency). Public endpoints only. Each run (cron/pm2 every 1–2 min):
  Coinstore spread%; depth ±2% each side in USD (bids in USDT, asks in JITOSOL×mid); 24h volume USD and volume/depth ratio;
  Coinstore mid vs OKX mid drift; OKX JITOSOL vs OKX SOL×coef divergence; OKX move > 2% in 5 min (use recent 1m candles/trades).
- Prints one summary line; POSTs to a Discord/Slack webhook from env (`KPI_WEBHOOK_URL`) only when a KPI breaches; state file to avoid
  repeat spam. Flags: `--dry-run`, `--once`. Thresholds as CLI/env with the KPIs above as defaults. Exit code non-zero on breach.
- Discover the Coinstore 24h ticker/volume endpoint yourself from the Coinstore public docs; if none is reliable, compute volume from
  the bot's `/stats`-independent public trades endpoint or mark the volume KPI "unavailable" (do not guess).
- Accept: unit tests over saved JSON fixtures for each breach type; `--dry-run` works offline with fixtures.

### S6 — Docs and config hygiene
- `config.default.jsonc`: document every new key + default. Update `pw_source_coefficient` example from 1.285 to ~1.30 and say it is
  the **third-tier** fallback after the live Jito API and Jupiter.
- `docs/RUNBOOK.md` / `docs/OPERATOR_GUIDE.md` / `docs/OKX_PW_SETUP.md`: replace the recommended MM policy with `spread`
  (explain `optimal`+liq = 80% of MM trades hit the real book; `depth` = no volume; `orderbook` riskiest; `wash` behaves like `spread`),
  add the kill switch (`/stop mm` then `/clear JITOSOL/USDT all` — `/stop` alone leaves orders), the KPI list, and the alert keys.
- Add a "what these guards do / do not do" section: none of them anchor liq to OKX; the stale-quote risk remains and is handled by
  small caps, tight PW and human monitoring.

## 5. Definition of done

- `npm test` and `npm run lint` pass; new tests cover every acceptance line above.
- With all new config keys absent, the bot behaves exactly as before except: OKX quotes older than 120 s now trigger the existing fallback,
  and extra alerts/log files exist.
- PR description lists: slices done, config keys added (+defaults), anything skipped and why, and the manual deploy notes
  (restart leaves orders open; deploy while MM is stopped and orders cleared; check `Active PW source` afterwards).
- Append one line to `docs/agents/learnings.md` if that file exists (create the line only; do not create the file otherwise).

## 6. Live operating params (context only — do not encode into code)

`/start mm spread` · `/enable pw JITOSOL/USDT@OKX 0.5% smart prevent -y` · `/enable liq 1.5% 15 JITOSOL 2150 USDT ss middle` ·
`/amount 0.5-1` · `/interval 45-120 sec` (later 90-180) · `/buypercent 0.5` · `/disable ob`.
Kill switch: OKX moves >2% in 10 min, or liq shows 0 bids/asks → `/stop mm` then `/clear JITOSOL/USDT all`.

## 7. Decision record / rejected options (also post as a Linear decision comment when tickets exist)

- 📌 **Anchor liq to OKX fair instead of the Coinstore book** — REJECTED for now. Changes core liq logic; operator wants params-only
  safety this round. Revisit when: another stale-quote loss occurs or the operator approves a liq change.
- 📌 **Stop liq when Coinstore book looks dislocated** — REJECTED. Deadlocks post-`/clear` bootstrap (see §2.2).
- 📌 **Liq re-quote throttle (only re-post when price moved >0.3%)** — OUT OF SCOPE. Would cut 429s but changes liq cadence.
- 📌 **Switch primary PW to SOL×coefficient** — REJECTED. OKX direct stays primary; coefficient stays the fallback. Revisit if OKX JITOSOL
  liquidity dries up or the pair becomes unavailable to the VPS.
- Known and accepted: this build does not fix the arbitrage exposure of resting liq orders. It makes wrong prices and bad states visible fast.
