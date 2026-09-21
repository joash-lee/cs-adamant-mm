#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test for bot alerts: posts one sample of every event the bot can send to the
 * n8n webhook, so the operator sees every Telegram message once. Same payloads as helpers/botAlerts.js,
 * so this file is also the reference for the data fields per key.
 *
 * URL and secret come from the environment only (never pass them as arguments or commit them):
 *   ALERT_WEBHOOK_URL=https://…/webhook/tradebot-alerts ALERT_WEBHOOK_SECRET=… node scripts/alert-smoke.js
 *
 * Options:
 *   --dry-run      Print the payloads, send nothing (no env needed)
 *   --delay <ms>   Pause between posts (default 1500, keeps Telegram in order and under its rate limit)
 *   --only <key>   Send only events with this key (e.g. wallet_warn, daily, heartbeat)
 *
 * Not sent: 'offline' — n8n raises it itself when heartbeats stop (stop the bot to test it).
 */

const BOT = 'JITOSOL/USDT@Coinstore TradeBot (smoke test)';
const PAIR = 'JITOSOL/USDT';

/**
 * @param {number} now Timestamp for the samples
 * @return {Array<{ kind: string, key: string, data: Object, note: string }>}
 */
function buildSamples(now = Date.now()) {
  const fairMid = 250.4;
  const wallet = (quoteShare) => {
    const quoteAmount = Math.round(quoteShare * 30 * 100) / 100; // wallet worth ~3000 USDT
    const baseAmount = Math.round((3000 - quoteAmount) / fairMid * 1e4) / 1e4;
    return {
      baseShare: Math.round((100 - quoteShare) * 10) / 10,
      quoteShare,
      lowSide: quoteShare < 50 ? 'quote' : 'base',
      baseAmount,
      quoteAmount,
      fairMid,
    };
  };

  return [
    { kind: 'heartbeat', key: 'heartbeat', note: 'no message; n8n stores it for the offline check', data: {
      mmActive: true, liqActive: true, pwActive: true, bidsOpen: 6, asksOpen: 6,
      lastLiqCycleTs: now - 15000, lastTradeTs: now - 90000, walletShareQuote: 48.2, fairMid, uptimeSec: 86400,
    } },

    // 5.1 Wallet
    { kind: 'raise', key: 'wallet_warn', note: 'too much JITOSOL → unable to buy soon', data: wallet(28) },
    { kind: 'raise', key: 'wallet_warn', note: 'too much USDT → unable to sell soon', data: wallet(72) },
    { kind: 'raise', key: 'wallet_serious', note: 'too much JITOSOL', data: wallet(14) },
    { kind: 'raise', key: 'wallet_serious', note: 'too much USDT', data: wallet(86) },
    { kind: 'reminder', key: 'wallet_serious', note: 'reminder = raise data + raisedMinAgo', data: { ...wallet(12), raisedMinAgo: 360 } },
    { kind: 'raise', key: 'wallet_fast', note: 'split moved fast', data: {
      fromQuoteShare: 50, fromBaseShare: 50, toQuoteShare: 33, toBaseShare: 67, movedPts: 17, windowMin: 60, lowSide: 'quote',
    } },
    { kind: 'raise', key: 'side_empty', note: 'no buy orders: only selling', data: { emptySide: 'buy', cycles: 5, bidsOpen: 0, asksOpen: 6 } },
    { kind: 'raise', key: 'side_empty', note: 'no sell orders: only buying', data: { emptySide: 'sell', cycles: 5, bidsOpen: 6, asksOpen: 0 } },
    { kind: 'clear', key: 'wallet_warn', note: 'back above 35%', data: wallet(41) },
    { kind: 'clear', key: 'wallet_serious', note: 'big recovery straight to clear', data: wallet(45) },
    { kind: 'clear', key: 'wallet_fast', note: '60 min without a fast move', data: {} },
    { kind: 'clear', key: 'side_empty', note: 'orders on both sides again', data: { bidsOpen: 3, asksOpen: 6 } },

    // 5.2 Stopped trading
    { kind: 'raise', key: 'no_orders', note: 'liq loop stuck (lastLiqCycleMinAgo null = never completed)', data: {
      minutes: 10, bidsOpen: 0, asksOpen: 0, lastLiqCycleMinAgo: 12,
    } },
    { kind: 'clear', key: 'no_orders', data: { bidsOpen: 6, asksOpen: 6 } },
    { kind: 'raise', key: 'no_trades', data: { minutes: 30, lastTradeTs: now - 30 * 60000 } },
    { kind: 'clear', key: 'no_trades', data: {} },
    { kind: 'raise', key: 'paused', note: 'info, sent once, no reminders', data: {} },
    { kind: 'clear', key: 'paused', note: '▶️ resumed', data: {} },

    // 5.3 Problems
    { kind: 'raise', key: 'backup_price', data: {} },
    { kind: 'clear', key: 'backup_price', data: {} },
    { kind: 'raise', key: 'exchange_trouble', note: 'reason: rate_limit', data: { reason: 'rate_limit', count429: 34, windowMin: 5 } },
    { kind: 'raise', key: 'exchange_trouble', note: 'reason: open_orders_failed', data: { reason: 'open_orders_failed' } },
    { kind: 'raise', key: 'exchange_trouble', note: 'reason: false_empty', data: { reason: 'false_empty' } },
    { kind: 'clear', key: 'exchange_trouble', note: '30 min clean', data: {} },

    // 5.4 Daily report
    { kind: 'daily', key: 'daily', note: 'normal day, no problems', data: {
      trades: 14, selfTrades: 120, selfTradeQuote: 18250.5, tradeQuote: 3120.4, avgVsFairPct: -0.2, badFills: false, badFillsPct: 1,
      baseAmount: 28.5, quoteAmount: 2140.12, alerts: {}, alertsTotal: 0, paused: false,
    } },
    { kind: 'daily', key: 'daily', note: 'bad fills + alerts', data: {
      trades: 22, selfTrades: 95, selfTradeQuote: 14100, tradeQuote: 5400, avgVsFairPct: -1.8, badFills: true, badFillsPct: 1,
      baseAmount: 36.1, quoteAmount: 410.5, alerts: { wallet_warn: 2, backup_price: 1 }, alertsTotal: 3, paused: false,
    } },
    { kind: 'daily', key: 'daily', note: 'paused all day (no trades → avgVsFairPct null)', data: {
      trades: 0, selfTrades: 0, selfTradeQuote: 0, tradeQuote: 0, avgVsFairPct: null, badFills: false, badFillsPct: 1,
      baseAmount: 30, quoteAmount: 1500, alerts: {}, alertsTotal: 0, paused: true,
    } },

    // Unknown key: n8n must still send a generic message, never drop it
    { kind: 'raise', key: 'smoke_unknown_key', note: 'generic fallback message', data: { value: 1 } },
  ];
}

function parseArgs(argv) {
  const args = { dryRun: false, delay: 1500, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--delay') args.delay = +argv[++i];
    else if (argv[i] === '--only') args.only = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (!isFinite(args.delay) || args.delay < 0) throw new Error('--delay must be a number of ms');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const events = buildSamples(now)
      .filter((sample) => !args.only || sample.key === args.only)
      .map(({ kind, key, data, note }) => ({ note, payload: { bot: BOT, pair: PAIR, ts: now, kind, key, data } }));

  if (args.dryRun) {
    for (const { note, payload } of events) {
      console.log(`# ${payload.kind} ${payload.key}${note ? ` — ${note}` : ''}`);
      console.log(JSON.stringify(payload));
    }
    console.log(`\n${events.length} events (dry run, nothing sent).`);
    return;
  }

  const url = process.env.ALERT_WEBHOOK_URL;
  const secret = process.env.ALERT_WEBHOOK_SECRET;

  if (!url || !secret) {
    console.error('Set ALERT_WEBHOOK_URL and ALERT_WEBHOOK_SECRET in the environment (or use --dry-run).');
    process.exit(1);
  }

  const axios = require('axios');
  let failed = 0;

  for (const [i, { note, payload }] of events.entries()) {
    const label = `${i + 1}/${events.length} ${payload.kind} ${payload.key}${note ? ` (${note})` : ''}`;
    try {
      const response = await axios.post(url, payload, { timeout: 5000, headers: { 'X-Alert-Secret': secret } });
      console.log(`OK   ${label} → HTTP ${response.status}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${label} → ${e.response ? `HTTP ${e.response.status}` : e.message}`);
    }
    if (i < events.length - 1) await new Promise((resolve) => setTimeout(resolve, args.delay));
  }

  console.log(`\nSent ${events.length - failed}/${events.length}.`);
  if (failed) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { buildSamples };
