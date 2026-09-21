#!/usr/bin/env node
'use strict';

/**
 * Read-only trading forensics over the bot's own log files (logs/*.log).
 * Reconstructs every fill, prices it against the Price watcher's fair price, and reports
 * where value went from a trader's point of view. Does not import the bot, call any API, or
 * touch the bot's files. Reusable for any period: pass whichever log files cover it.
 *
 * Usage (from the bot folder):
 *   node scripts/fill-forensics.js [options] logs/*.log
 *
 * Options:
 *   --fee <pct>             Fee % per side, for the fee estimate (e.g. 0.2)
 *   --start-usdt <n>        Balances at the start of the logs → estimated balance curve
 *   --start-coin <n>          (e.g. --start-usdt 5000 --start-coin 45)
 *   --end-usdt <n>          Actual balances now → reconciliation (fees + transfers + unlogged)
 *   --end-coin <n>
 *   --from YYYY-MM-DD       Only count fills from this UTC date (inclusive)
 *   --to YYYY-MM-DD         Only count fills up to this UTC date (inclusive)
 *   --markout <min>         Markout horizon in minutes (default 5)
 *   --csv <file>            Also write every fill as a CSV row (for a spreadsheet)
 *
 * Fills recognised:
 *   - "It's partly filled …: A -> B"                          partial fill of a resting order
 *   - "Unable to cancel …. Probably it doesn't exist anymore"  resting order vanished → assumed fully filled
 *   - "Successfully executed mm-order … executeInOrderBook"    mm taker trade into the real book (assumed filled)
 *   - "Successfully executed mm-order … executeInSpread"       mm self-trade: volume only, nets to zero except fees
 *
 * Fair price = midpoint of the latest post-coefficient, pre-deviation Pw range in the log.
 *
 * Trader terms used in the report:
 *   Edge vs fair   sell: (price − fair) × amount; buy: (fair − price) × amount, at the moment of the fill.
 *                  Negative = you traded worse than fair (crossed the book or quoted off-market).
 *   Markout        same, but against the fair price N minutes AFTER the fill. Much worse than edge
 *                  = the market moved against you right after you traded = you were picked off.
 *   Inventory      result vs simply holding, minus edge: gain/loss from holding more or less of the
 *                  coin than you started with while its price moved.
 */

const fs = require('fs');
const readline = require('readline');

const FAIR_MAX_AGE_MS = 10 * 60 * 1000;

// ── CLI ──

const opts = { markoutMin: 5 };
const files = [];
const argv = process.argv.slice(2);
const numOpts = {
  '--fee': 'feePercent',
  '--start-usdt': 'startQuote',
  '--start-coin': 'startBase',
  '--end-usdt': 'endQuote',
  '--end-coin': 'endBase',
  '--markout': 'markoutMin',
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (numOpts[a]) opts[numOpts[a]] = +argv[++i];
  else if (a === '--from') opts.from = argv[++i];
  else if (a === '--to') opts.to = argv[++i];
  else if (a === '--csv') opts.csv = argv[++i];
  else files.push(a);
}

if (!files.length) {
  console.log('Usage: node scripts/fill-forensics.js [--fee 0.2] [--start-usdt N --start-coin N] [--end-usdt N --end-coin N]');
  console.log('         [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--markout MIN] [--csv fills.csv] logs/*.log');
  process.exit(1);
}

const MARKOUT_MS = opts.markoutMin * 60 * 1000;
const hasStart = Number.isFinite(opts.startQuote) && Number.isFinite(opts.startBase);
const hasEnd = Number.isFinite(opts.endQuote) && Number.isFinite(opts.endBase);

// ── Log patterns ──

const RE_LINE = /^\s*\w+\|\[?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\|(.*)$/;

const RE_PARTIAL = /Updating (\w+)-order.*?type=(buy|sell), pair=(\S+?),.*?price=([\d.]+).*?It's partly filled [^:]*: ([\d.e-]+) -> ([\d.e-]+) /;
const RE_VANISHED = /Unable to cancel (\w+)-order.*?type=(buy|sell),.*?pair=(\S+?), price=([\d.]+), coin1Amount=[\d.e-]+ \(([\d.e-]+) left\).*Probably it doesn't exist anymore/;
const RE_MM = /Successfully executed mm-order.*? to (buy|sell) ([\d.]+) (\w+) for ([\d.]+) (\w+) at ([\d.]+) \w+\. Action: (executeInOrderBook|executeInSpread)/;

const RE_FAIR = [
  /pre-deviation ([\d.]+)–([\d.]+)\)/,
  /Applied cross-base coefficient [\d.]+ \([^)]*\) → range ([\d.]+)–([\d.]+)/,
  /Applied config pw_source_coefficient [\d.]+: range ([\d.]+)–([\d.]+)/,
];
// Same-pair source (e.g. JITOSOL/USDT@OKX): the Calculated line already is the traded asset's price
const RE_FAIR_SAME_PAIR = /Calculated the (\S+) price range according to (\S+) at .*? — from ([\d.]+) to ([\d.]+) /;

const RE_LIQ_OPENED = /Liquidity: Opened (\d+) bids-buy .*? and (\d+) asks-sell/;

// ── State ──

let pairName = null;
let baseCoin = 'COIN';
let quoteCoin = 'USDT';

let fair = null;
let fairTs = 0;

let cumBase = 0; // net coin bought since log start (all sources)
let cumQuote = 0; // net USDT received since log start

const pendingMarkouts = []; // fills waiting for the fair price MARKOUT_MS later
const weeks = new Map();
const days = new Map();
const daySnap = new Map(); // day -> { cumBase, cumQuote, fair } at the last event of that day
const zeroBidDays = new Set();
const zeroAskDays = new Set();
let firstTs = null;
let lastTs = null;
let fillCount = 0;

const csv = opts.csv ? fs.createWriteStream(opts.csv) : null;
if (csv) csv.write('time,source,side,price,amount,quote,fair,edge,cumCoin,cumUsdt\n');

function weekKey(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); // Monday
  return d.toISOString().slice(0, 10);
}

function inRange(day) {
  return (!opts.from || day >= opts.from) && (!opts.to || day <= opts.to);
}

function period(map, key) {
  if (!map.has(key)) {
    map.set(key, { sources: {}, selfTradeQuote: 0, liqCycles: 0, liqZeroBid: 0, liqZeroAsk: 0 });
  }
  return map.get(key);
}

function newStats() {
  return {
    fills: 0,
    buyBase: 0, buyQuote: 0,
    sellBase: 0, sellQuote: 0,
    edge: 0, noFair: 0,
    markout: 0, markoutFills: 0,
  };
}

function stats(p, source) {
  if (!p.sources[source]) p.sources[source] = newStats();
  return p.sources[source];
}

function snapDay(day) {
  daySnap.set(day, { cumBase, cumQuote, fair });
}

function setFair(value, ts, day) {
  fair = value;
  fairTs = ts;

  while (pendingMarkouts.length && pendingMarkouts[0].ts + MARKOUT_MS <= ts) {
    const f = pendingMarkouts.shift();
    // A log gap (bot down) would compare against a much later price — skip those
    if (ts - f.ts > MARKOUT_MS + FAIR_MAX_AGE_MS) continue;
    const m = f.side === 'sell' ? (f.price - fair) * f.amount : (fair - f.price) * f.amount;
    for (const s of f.statsRefs) {
      s.markout += m;
      s.markoutFills += 1;
    }
  }

  if (inRange(day)) snapDay(day);
}

function addFill(day, time, ts, source, side, amount, price) {
  if (!(amount > 0) || !(price > 0) || !inRange(day)) return;

  fillCount += 1;
  const fairNow = fair && ts - fairTs <= FAIR_MAX_AGE_MS ? fair : null;
  const edge = fairNow ? (side === 'sell' ? (price - fairNow) * amount : (fairNow - price) * amount) : null;

  cumBase += side === 'buy' ? amount : -amount;
  cumQuote += side === 'buy' ? -amount * price : amount * price;
  snapDay(day);

  const statsRefs = [];
  for (const p of [period(weeks, weekKey(day)), period(days, day)]) {
    const s = stats(p, source);
    const all = stats(p, 'ALL');
    for (const t of [s, all]) {
      t.fills += 1;
      if (side === 'buy') {
        t.buyBase += amount;
        t.buyQuote += amount * price;
      } else {
        t.sellBase += amount;
        t.sellQuote += amount * price;
      }
      if (edge !== null) t.edge += edge;
      else t.noFair += 1;
      statsRefs.push(t);
    }
  }

  pendingMarkouts.push({ ts, side, price, amount, statsRefs });

  if (csv) {
    csv.write(`${day} ${time},${source},${side},${price},${amount},${(amount * price).toFixed(4)},${fairNow ?? ''},${edge === null ? '' : edge.toFixed(4)},${cumBase.toFixed(6)},${cumQuote.toFixed(4)}\n`);
  }
}

function notePair(pair) {
  if (pairName || !pair || !pair.includes('/')) return;
  pairName = pair;
  [baseCoin, quoteCoin] = pair.split('/');
}

function handleLine(line) {
  const m = RE_LINE.exec(line);
  if (!m) return;
  const [, day, time, msg] = m;
  const ts = Date.parse(`${day}T${time}Z`);

  if (inRange(day)) {
    if (firstTs === null) firstTs = `${day} ${time}`;
    lastTs = `${day} ${time}`;
  }

  if (msg.startsWith('Price watcher:')) {
    for (const re of RE_FAIR) {
      const f = re.exec(msg);
      if (f) return setFair((+f[1] + +f[2]) / 2, ts, day);
    }
    const sp = RE_FAIR_SAME_PAIR.exec(msg);
    if (sp && sp[1] === sp[2]) setFair((+sp[3] + +sp[4]) / 2, ts, day);
    return;
  }

  if (msg.includes('It\'s partly filled')) {
    const p = RE_PARTIAL.exec(msg);
    if (p) {
      notePair(p[3]);
      addFill(day, time, ts, p[1], p[2], +p[5] - +p[6], +p[4]);
    }
    return;
  }

  if (msg.includes('Probably it doesn\'t exist anymore')) {
    const v = RE_VANISHED.exec(msg);
    if (v) {
      notePair(v[3]);
      addFill(day, time, ts, v[1], v[2], +v[5], +v[4]);
    }
    return;
  }

  if (msg.includes('Successfully executed mm-order')) {
    const e = RE_MM.exec(msg);
    if (!e) return;
    const [, side, amount, coin1, quote, coin2, price, action] = e;
    notePair(`${coin1}/${coin2}`);
    if (action === 'executeInOrderBook') {
      addFill(day, time, ts, 'mm-book', side, +amount, +price);
    } else if (inRange(day)) {
      period(weeks, weekKey(day)).selfTradeQuote += +quote;
      period(days, day).selfTradeQuote += +quote;
    }
    return;
  }

  if (msg.startsWith('Liquidity: Opened') && inRange(day)) {
    const l = RE_LIQ_OPENED.exec(msg);
    if (l) {
      const w = period(weeks, weekKey(day));
      w.liqCycles += 1;
      if (+l[1] === 0) {
        w.liqZeroBid += 1;
        zeroBidDays.add(day);
      }
      if (+l[2] === 0) {
        w.liqZeroAsk += 1;
        zeroAskDays.add(day);
      }
    }
  }
}

async function readFile(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) handleLine(line);
}

// ── Formatting ──

function fmt(n, d = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function signed(n, d = 0) {
  return (n > 0 ? '+' : '') + fmt(n, d);
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function row(values, widths) {
  return values.map((v, i) => pad(v, widths[i])).join(' ');
}

function section(title) {
  console.log(`\n══ ${title} ══`);
}

function vsHold(snap) {
  return snap.fair ? snap.cumQuote + snap.cumBase * snap.fair : null;
}

// ── Report ──

function sumSources(map) {
  const totals = {};
  let selfTrade = 0;
  for (const p of map.values()) {
    selfTrade += p.selfTradeQuote;
    for (const [src, s] of Object.entries(p.sources)) {
      if (!totals[src]) totals[src] = newStats();
      for (const k of Object.keys(s)) totals[src][k] += s[k];
    }
  }
  return { totals, selfTrade };
}

function drawdown() {
  let peak = null; let peakDay = null;
  let worst = { dd: 0 };
  for (const [day, snap] of [...daySnap.entries()].sort()) {
    const v = vsHold(snap);
    if (v === null) continue;
    if (peak === null || v > peak) {
      peak = v;
      peakDay = day;
    }
    if (v - peak < worst.dd) worst = { dd: v - peak, from: peakDay, to: day };
  }
  return worst;
}

function balanceRunOut() {
  if (!hasStart) return {};
  const threshold = 0.05;
  let quoteOut = null; let baseOut = null;
  for (const [day, s] of [...daySnap.entries()].sort()) {
    if (!quoteOut && opts.startQuote + s.cumQuote < opts.startQuote * threshold) quoteOut = day;
    if (!baseOut && opts.startBase + s.cumBase < opts.startBase * threshold) baseOut = day;
  }
  return { quoteOut, baseOut };
}

function printSummary(totals, selfTrade) {
  const all = totals.ALL || newStats();
  const lastSnap = { cumBase, cumQuote, fair };
  const result = vsHold(lastSnap);
  const turnover = all.buyQuote + all.sellQuote;

  section('SUMMARY (plain English)');
  console.log(`Pair ${pairName || '?'}, logs ${firstTs} → ${lastTs} UTC, ${fmt(fillCount)} fills, turnover ${fmt(turnover)} ${quoteCoin} (+ ${fmt(selfTrade)} self-trade volume).`);
  console.log(`Net from fills: ${signed(cumBase, 2)} ${baseCoin}, ${signed(cumQuote)} ${quoteCoin}.`);

  if (result !== null) {
    const inventory = result - all.edge;
    console.log(`Result vs simply holding (marked at last fair ${fmt(fair, 2)}): ${signed(result)} ${quoteCoin}.`);
    console.log(`  • Edge vs fair at the moment of trading: ${signed(all.edge)} ${quoteCoin}`);
    console.log(`  • Inventory/trend (holding the wrong amount while price moved): ${signed(inventory)} ${quoteCoin}`);
    console.log(`  • ${opts.markoutMin}-min markout: ${signed(all.markout)} ${quoteCoin} over ${fmt(all.markoutFills)} fills` +
      (all.markout < all.edge ? ` — ${fmt(all.edge - all.markout)} worse than edge: price tended to move against you right after you traded (picked off).` : ' — no sign of being picked off beyond the edge.'));
    const biggest = Math.abs(all.edge) > Math.abs(inventory) ? 'EDGE (trading at bad prices)' : 'INVENTORY (position vs a moving price)';
    console.log(`  → The bigger driver was ${biggest}.`);
  } else {
    console.log('No fair price found in these logs, so value vs fair cannot be computed.');
  }

  if (Number.isFinite(opts.feePercent)) {
    const feeNotional = turnover + 2 * selfTrade;
    console.log(`Fee estimate at ${opts.feePercent}%/side: ~${fmt(feeNotional * opts.feePercent / 100)} ${quoteCoin} (on ${fmt(feeNotional)} fee-bearing volume). Not included above.`);
  }

  const dd = drawdown();
  if (dd.dd < 0) console.log(`Worst drawdown of result vs holding: ${fmt(dd.dd)} ${quoteCoin}, from ${dd.from} to ${dd.to}.`);

  const runOut = balanceRunOut();
  if (runOut.quoteOut) console.log(`Estimated ${quoteCoin} fell below 5% of start on ${runOut.quoteOut}.`);
  if (runOut.baseOut) console.log(`Estimated ${baseCoin} fell below 5% of start on ${runOut.baseOut}.`);
  const firstZeroBid = [...zeroBidDays].sort()[0];
  const firstZeroAsk = [...zeroAskDays].sort()[0];
  if (firstZeroBid) console.log(`Liq first placed 0 bids on ${firstZeroBid} (${zeroBidDays.size} days with at least one 0-bid cycle).`);
  if (firstZeroAsk) console.log(`Liq first placed 0 asks on ${firstZeroAsk} (${zeroAskDays.size} days with at least one 0-ask cycle).`);

  if (hasStart && hasEnd) {
    const expQuote = opts.startQuote + cumQuote;
    const expBase = opts.startBase + cumBase;
    console.log(`Reconciliation: fills explain ${fmt(expQuote)} ${quoteCoin} + ${fmt(expBase, 2)} ${baseCoin}; actual ${fmt(opts.endQuote)} + ${fmt(opts.endBase, 2)}.`);
    console.log(`  Unexplained: ${signed(opts.endQuote - expQuote)} ${quoteCoin}, ${signed(opts.endBase - expBase, 2)} ${baseCoin} (= fees + transfers + fills the logs missed).`);
  }
}

function printSources(totals, selfTrade) {
  section('BY SOURCE (whole period)');
  const w = [9, 7, 10, 9, 8, 9, 8, 9, 10, 10, 9];
  console.log(row(['source', 'fills', 'turnover', `bought`, 'avgBuy', 'sold', 'avgSell', 'spread%', 'edge', 'markout', 'noFair'], w));
  for (const [src, t] of Object.entries(totals).sort((a, b) => (a[0] === 'ALL') - (b[0] === 'ALL') || a[0].localeCompare(b[0]))) {
    const avgBuy = t.buyBase ? t.buyQuote / t.buyBase : null;
    const avgSell = t.sellBase ? t.sellQuote / t.sellBase : null;
    const spread = avgBuy && avgSell ? (avgSell - avgBuy) / avgBuy * 100 : null;
    console.log(row([
      src, fmt(t.fills), fmt(t.buyQuote + t.sellQuote), fmt(t.buyBase, 2), fmt(avgBuy, 2), fmt(t.sellBase, 2),
      fmt(avgSell, 2), fmt(spread, 2), signed(t.edge), signed(t.markout), fmt(t.noFair),
    ], w));
  }
  console.log(`spread% = avg sell vs avg buy (negative = bought higher than sold). Self-trade volume: ${fmt(selfTrade)} ${quoteCoin}.`);
}

function printWeekly() {
  section('WEEKLY (all sources)');
  const w = [10, 7, 10, 9, 9, 8, 8, 9, 9, 10, 10, 9, 7];
  console.log(row(['week', 'fills', 'turnover', 'bought', 'sold', 'avgBuy', 'avgSell', 'edge', 'markout', `cum${baseCoin.slice(0, 4)}`, 'cumUSDT', 'vsHold', '0bid%'], w));
  const weekEnd = new Map();
  for (const [day, snap] of [...daySnap.entries()].sort()) weekEnd.set(weekKey(day), snap);

  for (const [week, p] of [...weeks.entries()].sort()) {
    const t = p.sources.ALL || newStats();
    const snap = weekEnd.get(week) || { cumBase: 0, cumQuote: 0, fair: null };
    console.log(row([
      week, fmt(t.fills), fmt(t.buyQuote + t.sellQuote), fmt(t.buyBase, 2), fmt(t.sellBase, 2),
      fmt(t.buyBase ? t.buyQuote / t.buyBase : null, 2), fmt(t.sellBase ? t.sellQuote / t.sellBase : null, 2),
      signed(t.edge), signed(t.markout), signed(snap.cumBase, 2), signed(snap.cumQuote), fmt(vsHold(snap)),
      p.liqCycles ? fmt(100 * p.liqZeroBid / p.liqCycles) : '-',
    ], w));
  }
  console.log('cum* = net position change since log start (how one-sided the book got). vsHold = result vs holding at that week\'s fair.');
}

function printBalanceCurve() {
  if (!hasStart) {
    section('ESTIMATED BALANCES');
    console.log('Pass --start-usdt and --start-coin to see the estimated wallet week by week.');
    return;
  }
  section('ESTIMATED BALANCES (start + fills; ignores fees and transfers)');
  const weekEnd = new Map();
  for (const [day, snap] of [...daySnap.entries()].sort()) weekEnd.set(weekKey(day), snap);
  for (const [week, s] of [...weekEnd.entries()].sort()) {
    const q = opts.startQuote + s.cumQuote;
    const b = opts.startBase + s.cumBase;
    const value = s.fair ? q + b * s.fair : null;
    const quoteShare = value ? q / value * 100 : null;
    console.log(`${week}: ${pad(fmt(q), 8)} ${quoteCoin}  ${pad(fmt(b, 2), 8)} ${baseCoin}  @ fair ${pad(fmt(s.fair, 2), 7)}  = ${pad(fmt(value), 8)} ${quoteCoin}  (${fmt(quoteShare)}% in ${quoteCoin})`);
  }
}

function printWorstDays() {
  section('10 WORST DAYS (edge + markout)');
  const rows = [...days.entries()]
      .map(([day, p]) => ({ day, t: p.sources.ALL || newStats() }))
      .filter((r) => r.t.fills)
      .sort((a, b) => (a.t.edge + a.t.markout) - (b.t.edge + b.t.markout))
      .slice(0, 10);
  for (const { day, t } of rows) {
    const bySrc = Object.entries(days.get(day).sources)
        .filter(([s]) => s !== 'ALL')
        .map(([s, v]) => `${s} ${signed(v.edge)}`)
        .join(', ');
    console.log(`${day}: edge ${signed(t.edge)}, markout ${signed(t.markout)}, ${fmt(t.fills)} fills, bought ${fmt(t.buyBase, 2)} / sold ${fmt(t.sellBase, 2)} ${baseCoin} (${bySrc})`);
  }
}

(async () => {
  for (const file of files) {
    process.stderr.write(`Reading ${file}…\n`);
    await readFile(file);
  }
  if (csv) csv.end();

  if (!fillCount) {
    console.log('No fills found in the given logs/date range.');
    return;
  }

  const { totals, selfTrade } = sumSources(weeks);
  printSummary(totals, selfTrade);
  printSources(totals, selfTrade);
  printWeekly();
  printBalanceCurve();
  printWorstDays();
  if (opts.csv) console.log(`\nFill-by-fill CSV written to ${opts.csv}`);
})();
