# Handoff — tradebot alerts to Telegram (via n8n) + fill log

Status: READY TO BUILD · Written: 2026-09-21 · Owner: Joash · Executor: **two local Claude Code sessions (see §0), on `main`**
Supersedes: `docs/plans/handoff-liq-safety-guards.md` (see §9 for what was dropped and why).
Read first: `AGENTS.md`, `docs/RUNBOOK.md`, `docs/OPERATOR_GUIDE.md`, `docs/logs/2026-09-21-*.md`,
and in the n8n repo `/Users/joash/JoJo_n8n_Adventures/AGENTS.md` + `docs/WORKFLOW_REGISTRY.md`.

## 0. Who builds what: two local sessions + operator steps

n8n-mcp is configured **only for the `/Users/joash/JoJo_n8n_Adventures` project** (`~/.claude.json` project scope),
and that repo has its own rules (sync-before-write, deploy-from-source, registry). So the n8n part must be built
by a session **opened in that repo**, not from here.

| Who | Where | Does |
|---|---|---|
| **Session A** | Claude Code opened in `/Users/joash/adamant-tradebot` | T1–T6, T8 (docs + `scripts/alert-smoke.js`). Bot side only. |
| **Session B** | Claude Code opened in `/Users/joash/JoJo_n8n_Adventures` | T7 only. Reads this file by absolute path; follows that repo's `AGENTS.md` + `docs/agents/n8n-mcp.md` (sync-before-write, commit rules). Has n8n-mcp + API key there. |
| **Operator** | Telegram / n8n UI / VPS | Steps in §8: create the Telegram bot, add the **two credentials** in the n8n UI (Telegram token, header-auth secret) and the chat id. Agents never handle these secrets. |

A and B are independent: the only link between them is the event contract (§4). Either can go first. B builds and
tests against fixture payloads and deploys the workflow **inactive**, with credential stubs the operator binds.
The end-to-end check (T8 smoke) needs both done plus the operator's credentials. Run it from Session A with
`ALERT_WEBHOOK_URL=https://n8n.srv935443.hstgr.cloud/webhook/tradebot-alerts` and `ALERT_WEBHOOK_SECRET` exported by
the operator in their own shell (not pasted into chat).

## 1. What we're building, in plain words

The bot lost almost all its USDT between June and September and nobody noticed for weeks. This build makes sure
that never happens quietly again. It does **not** change how the bot trades.

- The bot watches itself and sends short events to an **n8n webhook** on the same VPS.
- n8n turns each event into a **plain-language Telegram message** (written for a non-technical client: what
  happened → why it matters → what to do), sends it to a **dedicated Telegram bot/chat**, and also raises
  an alarm if the bot stops checking in.
- The bot also writes a **fill log** (one line per trade, priced against fair market price), which feeds a
  **daily one-line report**.

```
tradebot ──POST event / heartbeat──▶ n8n webhook ──▶ Telegram
                                        ▲
                     n8n schedule (5 min): "heartbeat older than 20 min?" → 🛑 offline
```

Design split: **all detection logic lives in the bot** (unit-testable with Jest, has the data). **n8n only
formats, sends, and runs the dead-man check** (the one thing the bot can't do for itself). Message wording
lives in n8n so it can be edited without redeploying the bot.

## 2. HARD constraints

1. **No change to trading behaviour.** Do not alter order placement, pricing, sizing, PW band maths, MM
   policies or `orderCollector` decisions. New code = observation, events, files, docs.
2. **Feature fully off when `alert_webhook_url` is missing.** No timers, no requests, no errors. The bot
   must start and behave exactly as today on the current VPS config. Fill log is the only exception (§5.5).
3. **Alert sending can never break or slow trading.** Fire-and-forget POST, 5 s timeout, all errors caught
   and logged with `log.warn`. No `await` on the webhook inside trading loops.
4. Every threshold is an optional config key with a default, read from `modules/configReader.js`,
   documented in `config.default.jsonc`.
5. **No secrets in code, tests, docs or logs.** Webhook secret and Telegram token live only in VPS
   `config.jsonc` / n8n credentials. Tests mock the network.
6. **Git:** work on `main`, one commit per slice (§6), attribution line per repo rules. **Do not push**
   (operator pushes). Do not touch `scripts/fill-forensics.js`: it has uncommitted work from another session.
7. **No SSH, VPS or exchange calls from the build session.** The only live call allowed is to the n8n
   instance for T6/T8, and only with the operator present (T8 sends real Telegram messages).
8. Match the surrounding style: CommonJS, 2-space, JSDoc, `log.log/warn`, `utils.getModuleName(module.id)`.
   Use lazy `require` inside functions where a top-level require would create a cycle
   (`mm_price_watcher` ⇄ `orderUtils` ⇄ `orderCollector`).

## 3. Verified repo facts (don't re-derive)

- Modules start in `app.js` lines ~55–58 (`mm_trader`, `mm_orderbook_builder`, `mm_liquidity_provider`,
  `mm_price_watcher` `.run()`). Start the alerts module right after them.
- Trade params: `tradeParams.mm_isActive`, `mm_isLiquidityActive`, `mm_isPriceWatcherActive`
  (`trade/settings/tradeParams_Default.js`); live object is `require('./settings/tradeParams_' + config.exchange)`.
- **Liq cycle:** `trade/mm_liquidity_provider.js` `updateLiquidity()`, around line 148: after placement,
  `liquidityDepthStats.bidsCount` / `.asksCount` = liq depth orders open on each side (existing + new).
  The `ss` orders have their own stats (`liqSsInfoString`); count both. Hook **after** `log.log(liqInfoString)`.
- **Balances:** `orderUtils.getBalancesCached(false, moduleName, false, walletType, api)` returns entries with
  `free` / `freezed`. It's cached and already called every liq cycle, so reusing it adds ~no API load.
- **Fills:** `orderUtils.updateOrders()` builds `fills[purpose]` (`partlyFilledOrders`, `filledOrders`, each with
  `type, price, coin1AmountFilled, coin2AmountFilled`) and saves them to `fillsDb` (~line 835). Hook there.
  MM trades are logged in `trade/mm_trader.js`: `Successfully executed mm-order … executeInSpread` (~216,
  self-trade, volume only) and `… executeInOrderBook` (~372, taker trade into the real book). Hook both.
- ⚠️ `orderCollector.js` lines 339/528, "Unable to cancel … Probably it doesn't exist anymore", is **the
  normal fully-filled path**, NOT a failure. Real trouble signals: `orderCollector.js` ~703
  ("Unable to receive … open orders"), the false-empty order list in `orderUtils.js` ~660 (already
  priority-notifies), and HTTP 429 in `trade/api/coinstore_api.js` (error map line 18; find where the response
  status is handled).
- **PW:** `setPriceRange()` in `trade/mm_price_watcher.js` ~1052: fallback branch at ~1054;
  `computeRangeFromSource()` computes `preDeviationL/H` (post-coefficient, pre-deviation). **Fair mid =
  (preDeviationL + preDeviationH) / 2** (same definition as `scripts/fill-forensics.js`). Don't use
  `getLowPrice/getHighPrice`: those include deviation, randomisation and support-price overrides (can be `MAX_VALUE`).
- `helpers/log.js` writes `logs/<start-date>.log`; `logs/` is gitignored. `helpers/notify.js` stays untouched;
  existing ADAMANT notifications carry on unchanged.
- Tests: `npm test` = Jest 30. Existing `tests/*.js` are plain node scripts; `okx-api-auth-fallback.test.js`
  matches Jest's pattern but has no `test()` blocks. **First step: run `npx jest` for a baseline and record it.**
  New tests: `tests/alerts-*.test.js` using `describe/it`. If the baseline fails only because of that file, add a
  `jest.testMatch` in `package.json` limited to `tests/**/alerts-*.test.js` + `tests/**/fill-*.test.js` and say so.
- The n8n instance is `n8n.srv935443.hstgr.cloud`, the same VPS as the bot. The n8n repo uses n8n-mcp locally.

## 4. Event contract (bot → n8n)

`POST {alert_webhook_url}`, header `X-Alert-Secret: {alert_webhook_secret}`, JSON:

```json
{ "bot": "<config.notifyName>", "pair": "JITOSOL/USDT", "ts": 1760000000000,
  "kind": "raise | clear | reminder | heartbeat | daily",
  "key": "wallet_warn", "data": { "...": "numbers only, no prose" } }
```

The bot sends **keys + numbers**; n8n owns the wording. Every alert state change is driven by one helper:
`raise(key, data)` sends on first raise, then `reminder` every `alert_reminder_hours`; `clear(key, data)` sends once
only if the key was raised. State is in memory (a restart re-evaluates from scratch; acceptable).

**As built (Session A, 2026-09-21) — Session B, template against these.** The `data` fields for every key × kind
are the samples in `/Users/joash/adamant-tradebot/scripts/alert-smoke.js` (`buildSamples()`; `--dry-run` prints
them all). Points the templates must handle:
- Wallet keys: `baseShare`, `quoteShare` (%), `lowSide`: `'quote'` = too much JITOSOL → "unable to **buy**";
  `'base'` = too much USDT → "unable to **sell**". Also `baseAmount`, `quoteAmount`, `fairMid`. `wallet_fast`:
  `fromQuoteShare/fromBaseShare → toQuoteShare/toBaseShare`, `movedPts`, `windowMin`, `lowSide`.
- `side_empty`: `emptySide` `'buy'` → "only selling, not buying"; `'sell'` → "only buying, not selling".
- `exchange_trouble`: `reason` ∈ `rate_limit` (+ `count429`, `windowMin`) | `open_orders_failed` | `false_empty`.
- `no_orders`: `minutes`, `bidsOpen`, `asksOpen`, `lastLiqCycleMinAgo` (null = liq never completed a cycle).
  `no_trades`: `minutes`, `lastTradeTs`. `paused` / `backup_price`: `{}`. Clear payloads may be `{}`.
- `reminder` = the raise data + `raisedMinAgo`. `paused` never gets reminders.
- `daily`: `trades`, `selfTrades`, `selfTradeQuote`, `tradeQuote`, `avgVsFairPct` (null when no trades),
  `badFills` (bool; add the "worse than market" line), `badFillsPct`, `baseAmount`, `quoteAmount` (null if the
  balance read failed), `alerts` (`{key: count}`), `alertsTotal`, `paused` (bool → "paused").
- Heartbeat `data`: `mmActive, liqActive, pwActive, bidsOpen, asksOpen, lastLiqCycleTs, lastTradeTs,
  walletShareQuote, fairMid, uptimeSec` (all may be null early after start).

## 5. Alert catalogue (what the client sees)

Each message is 2–3 lines: **headline · why it matters · Do:**. "Pause the bot" always means `/stop mm` then
`/clear JITOSOL/USDT all` (spelled out in the runbook). Every raise has a ✅ clear message.

### 5.1 Wallet balance (by % of wallet value, both directions)
Share = value of each side / total, using **free + locked** balances and **fair mid** (§3). Skip the check when
the fair mid is unknown. The worse side decides the level. Levels are exclusive (serious replaces warn).

| key | Trigger (defaults) | Example text |
|---|---|---|
| `wallet_warn` | a side < **30%** | ⚠️ Wallet getting one-sided: 72% JITOSOL / 28% USDT. Keep an eye on it. |
| `wallet_serious` | a side < **15%** | 🔴 Wallet very one-sided: 86% JITOSOL / 14% USDT. The bot will soon be unable to buy. Do: add USDT or pause the bot. |
| `wallet_fast` | split moved ≥ **15 points** within **60 min** (ring buffer of samples) | ⚡ Wallet moved from 50/50 to 67/33 in the last hour. Unusually fast; someone may be trading against the bot. Do: check it now. |
| `side_empty` | liq has **0 buy** (or **0 sell**) orders for **5** consecutive cycles while liq is active | 🛑 Bot is only selling, not buying. USDT almost gone. Do: pause the bot now. |

Clear: warn/serious clear when the weaker side is back above **35%** (the gap stops flip-flopping); `wallet_fast`
clears after 60 min without a fast move; `side_empty` clears on the first cycle with orders on both sides.
Text must name the direction correctly in **both** cases (too much JITOSOL *or* too much USDT → "unable to buy" vs "unable to sell").

### 5.2 Stopped trading
| key | Trigger | Example text |
|---|---|---|
| `offline` | **n8n**: no heartbeat for **20 min** (heartbeat every **10 min**) | 🛑 Bot hasn't checked in for 20 minutes. It may have crashed. Its orders are still on the exchange with nobody managing them. Do: restart the bot or cancel orders on Coinstore. |
| `no_orders` | MM + liq active, and liq had 0 orders on **both** sides, or liq hasn't completed a cycle, for **10 min**. Checked by a bot-side timer, not the liq loop, so a stuck loop is still caught. | 🛑 Bot is running but has no orders on the market. Do: check the bot or restart it. |
| `no_trades` | MM active, no trade (mm execution or fill) for **30 min** | ⚠️ Bot hasn't made any trades in 30 minutes. Volume has stopped. Do: check the price reference is working. |
| `paused` | `mm_isActive` false (info, sent once; clear = "▶️ resumed") | ℹ️ Bot paused. |

### 5.3 Problems
| key | Trigger | Example text |
|---|---|---|
| `backup_price` | PW fallback branch used; clears when the primary source succeeds again | ⚠️ Bot lost its main price reference (OKX) and is using an estimate. Prices may be slightly off. Do: usually fixes itself; if over 1 hour, pause the bot. |
| `exchange_trouble` | any of: ≥ **30** Coinstore 429s in 5 min; "Unable to receive … open orders"; false-empty order list. `data.reason` says which. Clears after 30 min clean. | ⚠️ Coinstore isn't responding properly. The bot may be unable to update or cancel its orders. Do: if this repeats within an hour, pause the bot and check open orders. |

### 5.4 Daily report (`kind: daily`, at **01:00 UTC = 09:00 SGT**)
Bot computes it from the fill log (last 24 h) + one cached balance read:
`📊 JITOSOL daily · 14 trades · on average at fair price (−0.2%) · wallet 2,140 USDT + 28.5 JITOSOL · no problems`
- "trades" = fills against outsiders (liq fills + mm taker trades). Self-trades (`executeInSpread`) are reported
  separately as volume, if at all, and **excluded** from the vs-fair average.
- If the average vs fair is worse than **−1%**, add: "⚠️ trades were 1.8% worse than market price: someone may be picking off the bot's orders. Consider pausing."
- "no problems" / "3 alerts (wallet_warn ×2, backup_price ×1)". Paused all day → "paused".

### 5.5 Fill log (always on; local file only)
`logs/fills-YYYY-MM-DD.jsonl` (UTC day), one line per fill:
`{ts, source: "liq"|"mm-taker"|"mm-self"|"<purpose>", side, price, amount, quote, fair, vsFairPct}`.
`vsFairPct` = sell: (price − fair)/fair; buy: (fair − price)/fair; ×100. Negative = worse than fair. `fair: null`
when unknown (never crash). Appends only, no extra API calls. Config `fill_log_enabled` (default `true`).

## 6. Slices (build in order; one commit each; tests green after each)

**T1 — Alerts core.** New `helpers/botAlerts.js`: config parsing, `raise/clear/reminder` state machine, fire-and-forget
sender (axios, 5 s timeout, caught errors), heartbeat timer (payload: `mmActive, liqActive, pwActive, bidsOpen,
asksOpen, lastLiqCycleTs, lastTradeTs, walletShareQuote, fairMid, uptimeSec`), a periodic evaluator tick (60 s) for
the timer-based checks, `start()` wired in `app.js`. No-op when the URL is missing.
*Accept:* tests: off when unconfigured; raise sends once; reminder after N h (fake timers); clear only after raise;
sender errors swallowed; heartbeat payload shape.

**T2 — Fair mid + fill log.** Export `getFairMid()` from `mm_price_watcher` (stored from a successful
`computeRangeFromSource`: primary or fallback). New `helpers/fillLog.js`; hooks in `orderUtils.updateOrders()` and both
`mm_trader` success paths; also `botAlerts.recordTrade(ts)`.
*Accept:* tests: vsFair sign for buy/sell; null fair; file name rolls per UTC day; self-trade tagged `mm-self`.

**T3 — Wallet alerts.** Hook after the liq cycle log: record `bidsOpen/asksOpen/lastLiqCycleTs`; evaluate
`side_empty`; compute share from cached balances + fair mid; evaluate `wallet_warn/serious/fast` with hysteresis.
*Accept:* tests for both directions, 30/15/35 boundaries, no flip-flop at 31–34%, fast-move over a 60-min
window, unknown fair → skip, 5-cycle counter reset.

**T4 — Stopped-trading alerts.** In the evaluator tick: `no_orders`, `no_trades`, `paused/resumed`.
*Accept:* tests with fake clock: stuck liq loop still raises `no_orders`; no alerts while paused except `paused`;
`no_trades` only while MM is active.

**T5 — Problem alerts.** `backup_price` raise/clear in `setPriceRange()`; `exchange_trouble` from a 429 counter
(5-min sliding window) + the two trouble signals in §3. Also send `exchange_trouble` for "Unable to receive … open orders".
*Accept:* tests: 29 vs 30 429s; clears after 30 min clean; "Probably it doesn't exist anymore" does **not** count.

**T6 — Daily report.** Scheduler in `botAlerts` (fires once per UTC day at `alert_daily_utc_hour`, guarded against double
sends); reads today's and yesterday's fill files for the last 24 h; one `getBalancesCached`; alert counts from state.
*Accept:* tests over a fixture `.jsonl`: trade count excludes self-trades; avg vsFair; the < −1% warning line flag.

**T7 — n8n workflow (in `/Users/joash/JoJo_n8n_Adventures`).** Load the n8n-mcp skills first
(`using-n8n-mcp-skills` → patterns, code-javascript, error-handling). New folder `tradebot_alerts/` following the
`gtm_digest/` layout (logic in `src/*.js` + Jest tests, workflow built/deployed from source, `workflow.json` snapshot),
plus a row in `docs/WORKFLOW_REGISTRY.md`. Workflow **"Tradebot Alerts - Live"**:
- Webhook `POST /tradebot-alerts`, **header auth** credential (`X-Alert-Secret`), respond 200 immediately.
- Code `formatAlert`: `heartbeat` → store `{ts, payload}` in workflow static data, emit nothing (it also clears
  `offline` if it was raised: send ✅ "back online"); other kinds → template by `key` + `kind` (§5 texts) → Telegram.
  Unknown key → generic "⚠️ Bot alert: <key>" (never drop silently).
- Schedule every 5 min → Code `deadManCheck` (static data; raise `offline` once, remember it's raised) → Telegram.
- Telegram node: **new dedicated bot** credential, chat id stored as an n8n variable or node param (not in git).
- Error output wired to log/notify per `n8n-error-handling`.
- Note: static data only persists for the **active** (production) workflow, not manual test runs; verify on the
  live version before trusting `offline`. If static data is unreliable on this n8n version, use an n8n Data Table.
*Accept:* formatter tests cover every key × raise/clear/reminder + daily (both wording variants) + unknown key;
workflow validates via n8n-mcp; deployed **inactive** until T8.

**T8 — Docs + end-to-end smoke (operator present).**
- `config.default.jsonc`: every new key + default (list in §7). `docs/RUNBOOK.md` + `docs/OPERATOR_GUIDE.md`: "Alerts"
  section (the catalogue in plain words, "pause the bot" = `/stop mm` then `/clear JITOSOL/USDT all`, known false
  alarms: deposits/withdrawals and big price moves shift the wallet split), recommend MM policy `spread` (why:
  `optimal` + liq sent ~80% of MM trades into the real book), fill log location + how to read `vsFairPct`.
- `scripts/alert-smoke.js`: posts one sample of every event to the webhook (URL + secret from env only), `--dry-run`
  prints the payloads. With the operator's OK, activate the workflow and run it once so they see every message in Telegram.
- Append one line to `docs/agents/learnings.md` if it exists (do not create it).

## 7. Config keys (all optional)

| key | default | notes |
|---|---|---|
| `alert_webhook_url` | — | missing = whole alert feature off |
| `alert_webhook_secret` | — | sent as `X-Alert-Secret` |
| `alert_heartbeat_min` | 10 | n8n offline threshold is 20 (keep ≥ 2×) |
| `alert_wallet_warn_pct` / `_serious_pct` / `_clear_pct` | 30 / 15 / 35 | weaker side's share of wallet value |
| `alert_wallet_fast_move_pts` / `_fast_window_min` | 15 / 60 | |
| `alert_empty_side_cycles` | 5 | |
| `alert_no_orders_min` / `alert_no_trades_min` | 10 / 30 | |
| `alert_429_count` / `alert_trouble_clear_min` | 30 / 30 | 429s per 5 min |
| `alert_reminder_hours` | 6 | |
| `alert_daily_utc_hour` | 1 | 09:00 SGT |
| `alert_bad_fills_pct` | 1 | daily warning when avg vs fair < −this |
| `fill_log_enabled` | true | |

## 8. Definition of done

- `npx jest` and `npm run lint` pass in the bot repo (baseline issues recorded, not hidden); n8n repo tests pass.
- With no `alert_*` keys the bot behaves exactly as before, apart from writing `logs/fills-*.jsonl`.
- One commit per slice on `main` in each repo, nothing pushed. Final message to the operator lists: commits,
  config keys, anything skipped and why, and the deploy steps below.
- Operator has seen every message type in Telegram via `alert-smoke.js`.

### Operator deploy steps (for the final summary; the build session does NOT run these)
1. **Telegram:** @BotFather → `/newbot` → token; message the new bot once; get the chat id (`getUpdates`).
2. **n8n:** add the Telegram credential (token) + header-auth credential (a new random secret); set the chat id;
   activate "Tradebot Alerts - Live"; run `node scripts/alert-smoke.js` from the laptop to check every message.
3. **Adamant:** `/stop mm`, then `/clear JITOSOL/USDT all` (a restart leaves orders on the book).
4. **VPS**, in the bot folder: `git status` (must be clean), `git pull`, `npm ci` only if `package-lock.json` changed.
5. Add `alert_webhook_url` + `alert_webhook_secret` to `config.jsonc` (other keys optional).
6. `pm2 restart tradebot`, then `pm2 logs tradebot --lines 80` and check for the alerts startup line and `Active PW source`.
   Telegram should show **ℹ️ Bot paused** within a minute. That proves the chain end to end.
7. Optional offline test (orders are cleared, so it's safe): `pm2 stop tradebot`, wait for 🛑 (~20 min), then
   `pm2 start tradebot` → ✅ back online.
8. **Adamant:** start with the recovery params (`/start mm spread` …) → ▶️ resumed. Next morning: 📊 daily at 09:00.

## 9. Decisions (2026-09-21)

- **Alerts go bot → n8n → Telegram**, not bot → Telegram directly: reuses the n8n instance on the same VPS, wording
  editable without a bot deploy, and n8n can detect a dead bot. Accepted risk: n8n down = no alerts, and a VPS down
  silences both. Revisit if an off-VPS check becomes worth it.
- **Wallet alert by % of value, both directions, with an early level (30%), a serious level (15%) and a
  fast-move level.** The zero-side alert alone would fire far too late (it's what 12.70 USDT looks like).
- **"Stopped trading" is judged on bot status, not just heartbeat**: alive-but-idle is the dangerous case.
- **Fill log written live by the bot** (not reconstructed from logs): exact data for the daily report.
  `scripts/fill-forensics.js` stays the tool for investigating old logs.
- Dropped from the old handoff: **S1 OKX stale-quote guard** (OKX book snapshots are always fresh; the PW reads the
  book, not the ticker), **S2 OKX-vs-SOL divergence** (watches the wrong gap; the incident was Coinstore vs OKX),
  **S5 standalone KPI watchdog** (too much for now; the offline alert covers a dead bot), **balance-only equity logger**
  (the wallet alerts + fill log cover it).
- Rejected: **automatic stop** (bot pausing itself on drawdown). The operator chose alerts only. Revisit if an alert
  fires and the loss still grows before a human reacts.
- Still rejected (from the old handoff): anchoring liq to OKX fair; stopping liq when the Coinstore book looks
  dislocated (it deadlocks the post-`/clear` bootstrap).
- Known and accepted: none of this stops a loss by itself. It makes one loud within minutes, and explainable afterwards.
