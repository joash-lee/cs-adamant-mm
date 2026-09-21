/**
 * Fill log: one JSON line per fill, priced against the fair mid, in logs/fills-YYYY-MM-DD.jsonl (UTC day).
 * Line: { ts, source, side, price, amount, quote, fair, vsFairPct }
 * - source: 'liq' | 'mm-taker' | 'mm-self' | '<order purpose>'
 * - vsFairPct: sell (price − fair) / fair, buy (fair − price) / fair, ×100. Negative = worse than fair. null when fair is unknown.
 *
 * Always on unless fill_log_enabled is false. Appends only, no API calls, never throws into trading code.
 * Also tells bot alerts a trade happened (for the no_trades check), even when the file is disabled.
 */

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {'buy'|'sell'} side The bot's side of the fill
 * @param {number} price Fill price
 * @param {number|null} fair Fair mid price
 * @return {number|null} Percent, negative = worse than fair
 */
function computeVsFairPct(side, price, fair) {
  if (!(typeof fair === 'number' && isFinite(fair) && fair > 0) || !isFinite(price)) {
    return null;
  }

  const pct = side === 'sell' ?
      (price - fair) / fair * 100 :
      (fair - price) / fair * 100;

  return Math.round(pct * 10000) / 10000;
}

/**
 * @param {number} ts Timestamp, ms
 * @return {string} fills-YYYY-MM-DD.jsonl for the UTC day of ts
 */
function fillFileName(ts) {
  return `fills-${new Date(ts).toISOString().slice(0, 10)}.jsonl`;
}

/**
 * Builds a fill line
 * @param {Object} fill { ts, source, side, price, amount, quote? }
 * @param {number|null} fair Fair mid price
 * @return {Object} Line object
 */
function buildFillLine(fill, fair) {
  const price = +fill.price;
  const amount = +fill.amount;
  const quote = isFinite(+fill.quote) && fill.quote !== undefined && fill.quote !== null ? +fill.quote : price * amount;
  const fairValue = typeof fair === 'number' && isFinite(fair) && fair > 0 ? fair : null;

  return {
    ts: fill.ts,
    source: fill.source,
    side: fill.side,
    price,
    amount,
    quote,
    fair: fairValue,
    vsFairPct: computeVsFairPct(fill.side, price, fairValue),
  };
}

/**
 * Reads fill lines with ts in [sinceTs, nowTs] from the UTC-day files covering the range
 * @param {string} dir Directory with fills-*.jsonl
 * @param {number} sinceTs
 * @param {number} nowTs
 * @return {Array<Object>} Fill lines; unreadable files and broken lines are skipped
 */
function readFillsSince(dir, sinceTs, nowTs) {
  const files = new Set();
  for (let ts = sinceTs; ts < nowTs + DAY; ts += DAY) {
    files.add(fillFileName(Math.min(ts, nowTs)));
  }

  const fills = [];

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const fill = JSON.parse(line);
        if (fill.ts >= sinceTs && fill.ts <= nowTs) {
          fills.push(fill);
        }
      } catch {
        // Skip a broken line
      }
    }
  }

  return fills;
}

/**
 * Summarises fills for the daily report.
 * Trades = fills against outsiders (everything except mm-self). Self-trades are counted separately as volume.
 * The vs-fair average is weighted by quote amount, over trades with a known fair price only.
 * @param {Array<Object>} fills Fill lines
 * @param {number} badFillsPct Warn when the average is worse than −badFillsPct
 * @return {Object} { trades, selfTrades, selfTradeQuote, tradeQuote, avgVsFairPct, badFills }
 */
function summarizeFills(fills, badFillsPct) {
  let trades = 0;
  let selfTrades = 0;
  let selfTradeQuote = 0;
  let tradeQuote = 0;
  let weightedSum = 0;
  let weight = 0;

  for (const fill of fills) {
    if (fill.source === 'mm-self') {
      selfTrades++;
      selfTradeQuote += +fill.quote || 0;
      continue;
    }

    trades++;
    tradeQuote += +fill.quote || 0;

    if (typeof fill.vsFairPct === 'number' && isFinite(fill.vsFairPct)) {
      const w = +fill.quote > 0 ? +fill.quote : 1;
      weightedSum += fill.vsFairPct * w;
      weight += w;
    }
  }

  const avgVsFairPct = weight > 0 ? Math.round(weightedSum / weight * 100) / 100 : null;

  return {
    trades,
    selfTrades,
    selfTradeQuote: Math.round(selfTradeQuote * 100) / 100,
    tradeQuote: Math.round(tradeQuote * 100) / 100,
    avgVsFairPct,
    badFills: avgVsFairPct !== null && avgVsFairPct < -badFillsPct,
  };
}

/**
 * Creates a fill logger
 * @param {Object} deps
 * @param {string} deps.dir Directory to write into
 * @param {boolean} deps.enabled Write the file
 * @param {Function} deps.getFairMid () => number | null
 * @param {Object} deps.log Logger
 * @param {Function} [deps.onTrade] (ts) => void, called for every fill
 * @param {Function} [deps.appendFile] fs.appendFile-compatible
 * @return {{ record: Function }}
 */
function createFillLog({ dir, enabled, getFairMid, log, onTrade, appendFile = fs.appendFile }) {
  let isDirChecked = false;

  return {
    /**
     * Records a fill. Never throws.
     * @param {Object} fill { source, side, price, amount, quote?, ts? }
     * @return {Object|undefined} The written line
     */
    record(fill) {
      try {
        const ts = fill.ts ?? Date.now();

        if (!(+fill.amount > 0) || !(+fill.price > 0)) return;

        try {
          onTrade?.(ts);
        } catch (e) {
          log.warn(`Fill log: Error while recording a trade for alerts: ${e}.`);
        }

        if (!enabled) return;

        let fair = null;
        try {
          fair = getFairMid();
        } catch {
          fair = null;
        }

        const line = buildFillLine({ ...fill, ts }, fair);

        if (!isDirChecked) {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          isDirChecked = true;
        }

        appendFile(path.join(dir, fillFileName(ts)), JSON.stringify(line) + '\n', (error) => {
          if (error) {
            log.warn(`Fill log: Unable to write a fill: ${error}.`);
          }
        });

        return line;
      } catch (e) {
        log.warn(`Fill log: Error while recording a fill: ${e}.`);
      }
    },
  };
}

let instance;

function getInstance() {
  if (!instance) {
    const config = require('../modules/configReader');
    const log = require('./log');

    instance = createFillLog({
      dir: path.resolve('./logs'), // Same folder as helpers/log.js
      enabled: config.fill_log_enabled !== false,
      log,
      getFairMid() {
        const pw = require('../trade/mm_price_watcher');
        return typeof pw.getFairMid === 'function' ? pw.getFairMid() : null;
      },
      onTrade(ts) {
        require('./botAlerts').recordTrade(ts);
      },
    });
  }

  return instance;
}

module.exports = {
  computeVsFairPct,
  fillFileName,
  buildFillLine,
  readFillsSince,
  summarizeFills,
  createFillLog,

  /**
   * Records a fill with the default logger. Never throws.
   * @param {Object} fill { source, side, price, amount, quote?, ts? }
   */
  record(fill) {
    try {
      return getInstance().record(fill);
    } catch (e) {
      try {
        require('./log').warn(`Fill log: Error in record(): ${e}.`);
      } catch {
        // Nothing else to do
      }
    }
  },
};
