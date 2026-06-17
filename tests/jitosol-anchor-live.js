/**
 * JitoSOL Anchor — Live HTTP Tests
 *
 * Tests external API endpoints used for the JitoSOL price anchor.
 * No bot process, no tradebot configuration, no orders placed.
 *
 * Run with:
 *   node tests/jitosol-anchor-live.js
 *
 * Requires: internet access (Jito API, Jupiter API, Coinstore public API, Binance public API)
 * Does NOT require: config.jsonc, tradeParams, or a running bot
 */

'use strict';

const https = require('https');
const http = require('http');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function pass(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────────────`);
}

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    pass(label);
  } else {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label, value, detail) {
  if (value) {
    pass(label);
  } else {
    fail(label, detail || `expected truthy, got ${JSON.stringify(value)}`);
  }
}

function assertInRange(label, value, min, max) {
  if (typeof value === 'number' && isFinite(value) && value >= min && value <= max) {
    pass(label);
  } else {
    fail(label, `expected value in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
}

/**
 * Simple JSON GET request using built-in https/http.
 * Returns { ok, status, data, error }.
 */
function fetchJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(body), error: null });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, data: null, error: `JSON parse error: ${e.message}. Body: ${body.slice(0, 200)}` });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, data: null, error: `Request timed out after ${timeoutMs}ms` });
    });

    req.on('error', (e) => {
      resolve({ ok: false, status: null, data: null, error: e.message });
    });
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JITO_STATS_URL = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v3';
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const COINSTORE_TICKER_URL = 'https://api.coinstore.com/api/v1/ticker/price';
const COINSTORE_DEPTH_URL = 'https://api.coinstore.com/api/v1/market/depth/SOLUSDT?depth=5&level=5';
const OKX_TICKER_URL = 'https://www.okx.com/api/v5/market/ticker?instId=JITOSOL-USDT';
const OKX_BOOKS_URL = 'https://www.okx.com/api/v5/market/books?instId=JITOSOL-USDT&sz=5';
const BINANCE_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo?symbol=JTOUSDT';
const BINANCE_JITOSOL_CHECK_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=JITOSOLUSDT';

const COEFFICIENT_MIN = 1.0;
const COEFFICIENT_MAX = 1.6;
const JUPITER_CROSS_CHECK_TOLERANCE_PCT = 1.0;

// ─── Test 1: Jito Stake-Pool Stats ───────────────────────────────────────────

async function testJitoStats() {
  section('TEST 1: Jito stake_pool_stats API');
  console.log(`  URL: ${JITO_STATS_URL}`);

  const result = await fetchJson(JITO_STATS_URL);

  assertTrue('HTTP request succeeded', result.ok, result.error);
  if (!result.ok) {
    fail('Cannot proceed — no data from Jito API', result.error);
    return null;
  }

  const data = result.data;

  assertTrue('Response is an object', data && typeof data === 'object', `Got: ${typeof data}`);
  assertTrue('Response has tvl array', Array.isArray(data.tvl), `Got: ${typeof data.tvl}`);
  assertTrue('Response has supply array', Array.isArray(data.supply), `Got: ${typeof data.supply}`);

  if (!Array.isArray(data.tvl) || !Array.isArray(data.supply)) {
    fail('Cannot compute coefficient — missing arrays');
    return null;
  }

  assertTrue('tvl array is non-empty', data.tvl.length > 0, `length=${data.tvl.length}`);
  assertTrue('supply array is non-empty', data.supply.length > 0, `length=${data.supply.length}`);

  const latestTvl = data.tvl[data.tvl.length - 1];
  const latestSupply = data.supply[data.supply.length - 1];

  assertTrue('Latest tvl entry exists', latestTvl && typeof latestTvl === 'object');
  assertTrue('Latest supply entry exists', latestSupply && typeof latestSupply === 'object');
  assertTrue('Latest tvl.data is a positive number', typeof latestTvl.data === 'number' && latestTvl.data > 0, `Got: ${latestTvl.data}`);
  assertTrue('Latest supply.data is a positive number', typeof latestSupply.data === 'number' && latestSupply.data > 0, `Got: ${latestSupply.data}`);

  const tvlLamports = latestTvl.data;
  const supply = latestSupply.data;
  const tvlSol = tvlLamports / 1e9;
  const coefficient = tvlSol / supply;

  console.log(`  ℹ TVL: ${tvlLamports.toLocaleString()} lamports = ${tvlSol.toFixed(2)} SOL`);
  console.log(`  ℹ Supply: ${supply.toLocaleString()} JitoSOL`);
  console.log(`  ℹ Coefficient (TVL_SOL / Supply): ${coefficient.toFixed(6)}`);
  console.log(`  ℹ Expected range: [${COEFFICIENT_MIN}, ${COEFFICIENT_MAX}]`);

  assertTrue('Coefficient is a finite number', isFinite(coefficient) && !isNaN(coefficient), `Got: ${coefficient}`);
  assertInRange(`Coefficient ${coefficient.toFixed(6)} is within sane bounds`, coefficient, COEFFICIENT_MIN, COEFFICIENT_MAX);

  if (latestTvl.date) {
    console.log(`  ℹ Data date: ${latestTvl.date}`);
  }

  return coefficient;
}

// ─── Test 2: Jupiter Cross-Check ─────────────────────────────────────────────

async function testJupiterCrossCheck(jitoStatsCoefficient) {
  section('TEST 2: Jupiter price cross-check');
  const url = `${JUPITER_PRICE_URL}?ids=${JITOSOL_MINT},${SOL_MINT}`;
  console.log(`  URL: ${url}`);

  const result = await fetchJson(url);
  assertTrue('HTTP request succeeded', result.ok, result.error);

  if (!result.ok) {
    fail('Cannot proceed — no data from Jupiter API', result.error);
    return;
  }

  const data = result.data;
  const jitosolEntry = data?.[JITOSOL_MINT];
  const solEntry = data?.[SOL_MINT];

  assertTrue('Response contains JitoSOL entry', !!jitosolEntry, `Keys: ${Object.keys(data || {}).join(', ')}`);
  assertTrue('Response contains SOL entry', !!solEntry, `Keys: ${Object.keys(data || {}).join(', ')}`);

  if (!jitosolEntry || !solEntry) return;

  const jitosolPrice = jitosolEntry.usdPrice ?? jitosolEntry.price;
  const solPrice = solEntry.usdPrice ?? solEntry.price;

  console.log(`  ℹ JitoSOL price: $${jitosolPrice}`);
  console.log(`  ℹ SOL price: $${solPrice}`);

  assertTrue('JitoSOL price is positive', jitosolPrice > 0, `Got: ${jitosolPrice}`);
  assertTrue('SOL price is positive', solPrice > 0, `Got: ${solPrice}`);

  if (jitosolPrice <= 0 || solPrice <= 0) return;

  const jupiterRatio = jitosolPrice / solPrice;
  console.log(`  ℹ Jupiter ratio (JitoSOL/SOL): ${jupiterRatio.toFixed(6)}`);
  assertTrue(`Jupiter ratio ${jupiterRatio.toFixed(6)} is within sane bounds [${COEFFICIENT_MIN}, ${COEFFICIENT_MAX}]`, jupiterRatio >= COEFFICIENT_MIN && jupiterRatio <= COEFFICIENT_MAX);

  if (jitoStatsCoefficient !== null && jitoStatsCoefficient !== undefined) {
    const diffPct = Math.abs(jupiterRatio - jitoStatsCoefficient) / ((jupiterRatio + jitoStatsCoefficient) / 2) * 100;
    console.log(`  ℹ Difference vs Jito stats: ${diffPct.toFixed(4)}% (threshold: ${JUPITER_CROSS_CHECK_TOLERANCE_PCT}%)`);
    assertTrue(
        `Jupiter ratio within ${JUPITER_CROSS_CHECK_TOLERANCE_PCT}% of Jito stats coefficient (${jitoStatsCoefficient.toFixed(6)})`,
        diffPct <= JUPITER_CROSS_CHECK_TOLERANCE_PCT,
        `diff=${diffPct.toFixed(4)}%`,
    );
  } else {
    console.log('  ℹ Jito stats coefficient unavailable — skipping cross-check comparison');
  }
}

// ─── Test 3: Coinstore SOL Source ─────────────────────────────────────────────

async function testCoinstoreSOL() {
  section('TEST 3: Coinstore SOL/USDT source');

  // Ticker (informational only — Coinstore's public ticker/price endpoint returns close=0
  // without authentication. The depth/order book endpoint is the actual data source used
  // by the Price Watcher, so depth is the authoritative assertion below.)
  console.log(`  URL (ticker): ${COINSTORE_TICKER_URL}?symbol=SOLUSDT`);
  const tickerResult = await fetchJson(`${COINSTORE_TICKER_URL}?symbol=SOLUSDT`);
  assertTrue('Ticker HTTP request succeeded (endpoint reachable)', tickerResult.ok, tickerResult.error);

  if (tickerResult.ok && tickerResult.data) {
    const data = tickerResult.data;
    const ticker = Array.isArray(data.data) ? data.data[0] : data.data;

    if (ticker) {
      const price = parseFloat(ticker.close ?? ticker.price ?? ticker.last);
      if (isFinite(price) && price > 0) {
        console.log(`  ℹ SOLUSDT ticker last price: ${price} (positive — good)`);
      } else {
        console.log(`  ℹ SOLUSDT ticker last price: ${price} (zero/missing — expected on public endpoint without auth; depth is authoritative)`);
      }
    }
  }

  // Order book depth
  console.log(`  URL (depth): ${COINSTORE_DEPTH_URL}`);
  const depthResult = await fetchJson(COINSTORE_DEPTH_URL);
  assertTrue('Depth HTTP request succeeded', depthResult.ok, depthResult.error);

  if (depthResult.ok && depthResult.data) {
    const depth = depthResult.data.data || depthResult.data;
    const bids = depth.b ?? depth.bids ?? [];
    const asks = depth.a ?? depth.asks ?? [];

    console.log(`  ℹ Depth bids count: ${bids.length}, asks count: ${asks.length}`);
    assertTrue('Depth has at least one bid', bids.length > 0, `bids=${bids.length}`);
    assertTrue('Depth has at least one ask', asks.length > 0, `asks=${asks.length}`);

    if (bids.length > 0 && asks.length > 0) {
      const topBid = parseFloat(Array.isArray(bids[0]) ? bids[0][0] : bids[0].p ?? bids[0].price);
      const topAsk = parseFloat(Array.isArray(asks[0]) ? asks[0][0] : asks[0].p ?? asks[0].price);

      console.log(`  ℹ Top bid: ${topBid}, top ask: ${topAsk}`);
      assertTrue('Top bid is positive', topBid > 0, `Got: ${topBid}`);
      assertTrue('Top ask is positive', topAsk > 0, `Got: ${topAsk}`);
      assertTrue('Top bid < top ask (no crossed book)', topBid < topAsk, `bid=${topBid} ask=${topAsk}`);

      const spreadPct = (topAsk - topBid) / topBid * 100;
      console.log(`  ℹ Spread: ${spreadPct.toFixed(4)}%`);
      assertTrue('Spread is below 5% (sane market)', spreadPct < 5, `spread=${spreadPct.toFixed(4)}%`);
    }
  }
}

// ─── Test 4: OKX JITOSOL/USDT Primary Source ─────────────────────────────────

async function testOkxJitosol() {
  section('TEST 4: OKX JITOSOL/USDT primary PW source');
  console.log(`  URL (ticker): ${OKX_TICKER_URL}`);

  const tickerResult = await fetchJson(OKX_TICKER_URL);
  assertTrue('OKX ticker HTTP request succeeded', tickerResult.ok, tickerResult.error);

  if (tickerResult.ok && tickerResult.data) {
    const data = tickerResult.data;
    assertTrue('OKX response code is 0', data.code === '0', `code=${data.code} msg=${data.msg}`);
    const ticker = Array.isArray(data.data) ? data.data[0] : null;
    assertTrue('OKX ticker data present', !!ticker, JSON.stringify(data).slice(0, 200));

    if (ticker) {
      const bid = parseFloat(ticker.bidPx);
      const ask = parseFloat(ticker.askPx);
      const last = parseFloat(ticker.last);
      console.log(`  ℹ JITOSOL-USDT bid: ${bid}, ask: ${ask}, last: ${last}`);
      assertTrue('OKX bid is positive', bid > 0, `Got: ${bid}`);
      assertTrue('OKX ask is positive', ask > 0, `Got: ${ask}`);
      assertTrue('OKX bid < ask', bid < ask, `bid=${bid} ask=${ask}`);
    }
  }

  console.log(`  URL (books): ${OKX_BOOKS_URL}`);
  const booksResult = await fetchJson(OKX_BOOKS_URL);
  assertTrue('OKX order book HTTP request succeeded', booksResult.ok, booksResult.error);

  if (booksResult.ok && booksResult.data?.code === '0') {
    const book = booksResult.data.data?.[0];
    const bids = book?.bids ?? [];
    const asks = book?.asks ?? [];
    console.log(`  ℹ OKX depth bids: ${bids.length}, asks: ${asks.length}`);
    assertTrue('OKX book has bids', bids.length > 0);
    assertTrue('OKX book has asks', asks.length > 0);

    if (bids.length > 0 && asks.length > 0) {
      const topBid = parseFloat(bids[0][0]);
      const topAsk = parseFloat(asks[0][0]);
      assertTrue('OKX top bid < top ask', topBid < topAsk, `bid=${topBid} ask=${topAsk}`);
    }
  }
}

// ─── Test 5: Binance — Verify JitoSOL is NOT listed ─────────────────────────

async function testBinanceClarification() {
  section('TEST 5: Binance clarification (JTO ≠ JitoSOL)');
  console.log('  This test documents that Binance lists the governance token JTO, not JitoSOL (staked SOL).');

  // JTOUSDT should exist
  console.log(`  URL (JTO): ${BINANCE_EXCHANGE_INFO_URL}`);
  const jtoResult = await fetchJson(BINANCE_EXCHANGE_INFO_URL);

  if (jtoResult.ok && jtoResult.data) {
    const symbols = jtoResult.data.symbols || [];
    const jtoSymbol = symbols.find((s) => s.symbol === 'JTOUSDT');
    assertTrue('JTOUSDT (governance token) exists on Binance', !!jtoSymbol, `Symbols found: ${symbols.map((s) => s.symbol).join(', ')}`);
  } else if (jtoResult.status === 400) {
    fail('JTOUSDT check failed — symbol may not exist', jtoResult.error || 'HTTP 400');
  } else {
    fail('Binance exchangeInfo request failed', `status=${jtoResult.status} error=${jtoResult.error}`);
  }

  // JITOSOLUSDT should NOT exist (404 or error)
  console.log(`  URL (JITOSOLUSDT): ${BINANCE_JITOSOL_CHECK_URL}`);
  const jitosolResult = await fetchJson(BINANCE_JITOSOL_CHECK_URL);

  if (!jitosolResult.ok) {
    pass('JITOSOLUSDT is NOT listed on Binance (as expected — JitoSOL is not the same as JTO)');
    console.log(`    HTTP ${jitosolResult.status ?? 'error'}: ${jitosolResult.error || JSON.stringify(jitosolResult.data)}`);
  } else {
    // If it somehow returns a price, that would be unexpected
    fail(
        'JITOSOLUSDT unexpectedly found on Binance — review if Binance has added a JitoSOL listing',
        JSON.stringify(jitosolResult.data).slice(0, 200),
    );
  }

  console.log('\n  ℹ Summary: Binance DOES list JTO (Jito Network governance token, ticker: JTO).');
  console.log('  ℹ Binance DOES NOT list JitoSOL (liquid-staked SOL, mint: J1toso1...).');
  console.log('  ℹ These are different tokens. JTO is a governance/utility token; JitoSOL is a staking derivative.');
  console.log('  ℹ Therefore Binance cannot be used as a direct JitoSOL price source.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  JitoSOL Anchor — Live HTTP Tests');
  console.log('  No bot, no config required, no orders placed.');
  console.log('═══════════════════════════════════════════════════════════════');

  const jitoCoef = await testJitoStats();
  await testJupiterCrossCheck(jitoCoef);
  await testCoinstoreSOL();
  await testOkxJitosol();
  await testBinanceClarification();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\n  Failed tests:');
    failures.forEach(({ label, detail }) => {
      console.log(`    ✗ ${label}`);
      if (detail) console.log(`        ${detail}`);
    });
  }

  console.log('═══════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Unexpected error in test runner:', e);
  process.exit(1);
});
