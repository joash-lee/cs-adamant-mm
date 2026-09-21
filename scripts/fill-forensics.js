#!/usr/bin/env node
'use strict';

/**
 * Read-only forensic pass over the bot's own log files (logs/*.log).
 * Reconstructs fills and prices each one against the Price watcher's fair price at that moment.
 * Does not import the bot, does not call any API, does not write anything.
 *
 * Usage (from the bot folder):
 *   node scripts/fill-forensics.js logs/*.log
 *   node scripts/fill-forensics.js --fee 0.2 logs/*.log   # fee % per side, for the fee estimate
 *
 * Fill sources recognised:
 *   - "It's partly filled …: A -> B JITOSOL"                 partial fill of a resting order (liq, mm maker, …)
 *   - "Unable to cancel …. Probably it doesn't exist anymore" resting order vanished → assumed fully filled
 *   - "Successfully executed mm-order … executeInOrderBook"   mm taker trade into the real book
 *   - "Successfully executed mm-order … executeInSpread"      mm self-trade (volume only; nets to zero except fees)
 *
 * Fair price = midpoint of the latest post-coefficient, pre-deviation Pw range seen in the log
 * (ignored if older than FAIR_MAX_AGE_MS at fill time).
 *
 * Edge vs fair: sell → (price − fair) × amount; buy → (fair − price) × amount.
 * Negative total = value given to counterparties relative to fair. Self-trades cancel out automatically.
 */

const fs = require('fs');
const readline = require('readline');

const FAIR_MAX_AGE_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
let feePercent = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fee') {
    feePercent = +args[++i];
  } else {
    files.push(args[i]);
  }
}

if (!files.length) {
  console.log('Usage: node scripts/fill-forensics.js [--fee 0.2] logs/*.log');
  process.exit(1);
}

const RE_LINE = /^\s*\w+\|\[?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\|(.*)$/;

const RE_PARTIAL = /Updating (\w+)-order.*?type=(buy|sell).*?price=([\d.]+).*?It's partly filled [^:]*: ([\d.e-]+) -> ([\d.e-]+) /;
const RE_VANISHED = /Unable to cancel (\w+)-order.*?type=(buy|sell).*?price=([\d.]+), coin1Amount=[\d.e-]+ \(([\d.e-]+) left\).*Probably it doesn't exist anymore/;
const RE_MM = /Successfully executed mm-order.*? to (buy|sell) ([\d.]+) \w+ for ([\d.]+) \w+ at ([\d.]+) \w+\. Action: (executeInOrderBook|executeInSpread)/;

const RE_FAIR = [
  /pre-deviation ([\d.]+)–([\d.]+)\)/,
  /Applied cross-base coefficient [\d.]+ \([^)]*\) → range ([\d.]+)–([\d.]+)/,
  /Applied config pw_source_coefficient [\d.]+: range ([\d.]+)–([\d.]+)/,
];
// Same-pair source (e.g. JITOSOL/USDT@OKX): the Calculated line is already the traded asset's price
const RE_FAIR_SAME_PAIR = /Calculated the (\S+) price range according to (\S+) at .*? — from ([\d.]+) to ([\d.]+) /;

const RE_LIQ_OPENED = /Liquidity: Opened (\d+) bids-buy .*? and (\d+) asks-sell/;

let fair = null;
let fairTs = 0;

const weeks = new Map();
const days = new Map();
let firstTs = null;
let lastTs = null;

function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function bucket(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      sources: {},
      spreadVolumeUsdt: 0,
      liqCycles: 0,
      liqZeroBidCycles: 0,
      liqZeroAskCycles: 0,
    });
  }
  return map.get(key);
}

function sourceBucket(b, source) {
  if (!b.sources[source]) {
    b.sources[source] = {
      fills: 0,
      buyAmount: 0, buyQuote: 0,
      sellAmount: 0, sellQuote: 0,
      edge: 0, noFairFills: 0,
    };
  }
  return b.sources[source];
}

function addFill(dateStr, ts, source, side, amount, price) {
  if (!(amount > 0) || !(price > 0)) return;

  const fairFresh = fair && ts - fairTs <= FAIR_MAX_AGE_MS ? fair : null;

  for (const b of [bucket(weeks, weekKey(dateStr)), bucket(days, dateStr)]) {
    const s = sourceBucket(b, source);
    s.fills += 1;
    if (side === 'buy') {
      s.buyAmount += amount;
      s.buyQuote += amount * price;
    } else {
      s.sellAmount += amount;
      s.sellQuote += amount * price;
    }
    if (fairFresh) {
      s.edge += side === 'sell' ? (price - fairFresh) * amount : (fairFresh - price) * amount;
    } else {
      s.noFairFills += 1;
    }
  }
}

function handleLine(line) {
  const m = RE_LINE.exec(line);
  if (!m) return;
  const [, dateStr, timeStr, msg] = m;
  const ts = Date.parse(`${dateStr}T${timeStr}Z`);
  if (firstTs === null) firstTs = `${dateStr} ${timeStr}`;
  lastTs = `${dateStr} ${timeStr}`;

  if (msg.startsWith('Price watcher:')) {
    for (const re of RE_FAIR) {
      const f = re.exec(msg);
      if (f) {
        fair = (+f[1] + +f[2]) / 2;
        fairTs = ts;
        return;
      }
    }
    const sp = RE_FAIR_SAME_PAIR.exec(msg);
    if (sp && sp[1] === sp[2]) {
      fair = (+sp[3] + +sp[4]) / 2;
      fairTs = ts;
    }
    return;
  }

  if (msg.includes("It's partly filled")) {
    const p = RE_PARTIAL.exec(msg);
    if (p) addFill(dateStr, ts, p[1], p[2], +p[4] - +p[5], +p[3]);
    return;
  }

  if (msg.includes("Probably it doesn't exist anymore")) {
    const v = RE_VANISHED.exec(msg);
    if (v) addFill(dateStr, ts, v[1], v[2], +v[4], +v[3]);
    return;
  }

  if (msg.includes('Successfully executed mm-order')) {
    const e = RE_MM.exec(msg);
    if (!e) return;
    const [, side, amount, quote, price, action] = e;
    if (action === 'executeInOrderBook') {
      addFill(dateStr, ts, 'mm-book', side, +amount, +price);
    } else {
      for (const b of [bucket(weeks, weekKey(dateStr)), bucket(days, dateStr)]) {
        b.spreadVolumeUsdt += +quote;
      }
    }
    return;
  }

  if (msg.startsWith('Liquidity: Opened')) {
    const l = RE_LIQ_OPENED.exec(msg);
    if (l) {
      const b = bucket(weeks, weekKey(dateStr));
      b.liqCycles += 1;
      if (+l[1] === 0) b.liqZeroBidCycles += 1;
      if (+l[2] === 0) b.liqZeroAskCycles += 1;
    }
  }
}

async function readFile(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) handleLine(line);
}

function fmt(n, d = 0) {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function printWeeks() {
  const header = ['week', 'source', 'fills', 'boughtJ', 'avgBuy', 'soldJ', 'avgSell', 'usdtFlow', 'edgeVsFair', 'noFair'];
  const widths = [10, 10, 7, 9, 8, 9, 8, 10, 11, 7];
  console.log(header.map((h, i) => pad(h, widths[i])).join(' '));

  const totals = {};
  let totalSpreadVol = 0;

  for (const [week, b] of [...weeks.entries()].sort()) {
    for (const [source, s] of Object.entries(b.sources).sort()) {
      const usdtFlow = s.sellQuote - s.buyQuote;
      console.log([
        week, source, fmt(s.fills), fmt(s.buyAmount, 2),
        s.buyAmount ? fmt(s.buyQuote / s.buyAmount, 2) : '-',
        fmt(s.sellAmount, 2),
        s.sellAmount ? fmt(s.sellQuote / s.sellAmount, 2) : '-',
        fmt(usdtFlow), fmt(s.edge), fmt(s.noFairFills),
      ].map((v, i) => pad(v, widths[i])).join(' '));

      if (!totals[source]) {
        totals[source] = { fills: 0, buyAmount: 0, buyQuote: 0, sellAmount: 0, sellQuote: 0, edge: 0, noFairFills: 0 };
      }
      const t = totals[source];
      for (const k of Object.keys(t)) t[k] += s[k];
    }
    totalSpreadVol += b.spreadVolumeUsdt;
  }

  console.log('\n── Totals by source ──');
  let allUsdt = 0; let allJ = 0; let allEdge = 0; let allNotional = 0;
  for (const [source, t] of Object.entries(totals).sort()) {
    const usdtFlow = t.sellQuote - t.buyQuote;
    const jFlow = t.buyAmount - t.sellAmount;
    allUsdt += usdtFlow; allJ += jFlow; allEdge += t.edge; allNotional += t.buyQuote + t.sellQuote;
    console.log(`${pad(source, 10)}: ${fmt(t.fills)} fills, JITOSOL ${jFlow >= 0 ? '+' : ''}${fmt(jFlow, 2)}, USDT ${usdtFlow >= 0 ? '+' : ''}${fmt(usdtFlow)}, edge vs fair ${fmt(t.edge)} USDT (${fmt(t.noFairFills)} fills without a fair price)`);
  }
  console.log(`${pad('ALL', 10)}: JITOSOL ${allJ >= 0 ? '+' : ''}${fmt(allJ, 2)}, USDT ${allUsdt >= 0 ? '+' : ''}${fmt(allUsdt)}, edge vs fair ${fmt(allEdge)} USDT`);
  console.log(`mm executeInSpread self-trade volume: ${fmt(totalSpreadVol)} USDT (each is maker + taker on your own account)`);

  if (feePercent !== null) {
    const feeNotional = allNotional + 2 * totalSpreadVol;
    console.log(`Fee estimate at ${feePercent}% per side: ${fmt(feeNotional * feePercent / 100)} USDT on ${fmt(feeNotional)} USDT fee-bearing notional`);
  } else {
    console.log('Fee estimate: pass --fee <percent per side> to estimate (fills + 2× self-trade volume).');
  }
}

function printLiqHealth() {
  console.log('\n── Liq one-sided cycles per week ──');
  for (const [week, b] of [...weeks.entries()].sort()) {
    if (!b.liqCycles) continue;
    console.log(`${week}: ${fmt(b.liqCycles)} cycles, 0 bids in ${fmt(b.liqZeroBidCycles)} (${fmt(100 * b.liqZeroBidCycles / b.liqCycles)}%), 0 asks in ${fmt(b.liqZeroAskCycles)} (${fmt(100 * b.liqZeroAskCycles / b.liqCycles)}%)`);
  }
}

function printWorstDays() {
  const rows = [...days.entries()].map(([day, b]) => {
    let edge = 0; let usdt = 0;
    for (const s of Object.values(b.sources)) {
      edge += s.edge;
      usdt += s.sellQuote - s.buyQuote;
    }
    return { day, edge, usdt };
  }).sort((a, b) => a.edge - b.edge).slice(0, 10);

  console.log('\n── 10 worst days by edge vs fair ──');
  for (const r of rows) console.log(`${r.day}: edge ${fmt(r.edge)} USDT, USDT flow ${fmt(r.usdt)}`);
}

(async () => {
  for (const file of files) {
    process.stderr.write(`Reading ${file}…\n`);
    await readFile(file);
  }
  console.log(`Log span: ${firstTs} → ${lastTs} (UTC)\n`);
  printWeeks();
  printLiqHealth();
  printWorstDays();
})();
