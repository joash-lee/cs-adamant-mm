/**
 * @module helpers/cryptos/jitoCoefficient
 *
 * Fetches and caches the JitoSOL/SOL exchange rate (coefficient) from the Jito
 * stake-pool stats API.
 *
 * The true on-chain rate (from Jito documentation) is:
 *   Exchange Rate = Total Pool Lamports / Pool Token Supply
 *
 * This rate changes at epoch speed (~2–3 days) as staking rewards and MEV tips
 * accumulate in the pool. It is the correct denominator when pricing JitoSOL in
 * terms of SOL, e.g. to convert a SOL/USDT order-book price to a JitoSOL/USDT range.
 *
 * Sources:
 *   Primary:    https://kobe.mainnet.jito.network/api/v1/stake_pool_stats
 *   Cross-check: https://api.jup.ag/price/v3
 *   Docs:       https://www.jito.network/docs/jitosol/faqs/technical-faqs/
 *
 * This module is NOT a replacement for config.pw_source_coefficient.
 * If the live API is unavailable, mm_price_watcher falls back to the config
 * value. If both are absent the watcher fails closed.
 */

'use strict';

const axios = require('axios');
const log = require('../log');

// ─── Constants ────────────────────────────────────────────────────────────────

const JITO_STATS_URL = 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats';
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v3';

// JitoSOL and native SOL mint addresses on Solana
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Sane bounds for the JitoSOL/SOL coefficient.
// JitoSOL launched at 1:1 and accrues ~0.55%/month. 1.6 is headroom for ~35 years.
const COEFFICIENT_MIN = 1.0;
const COEFFICIENT_MAX = 1.6;

// How often to refresh from the Jito API. 6 hours gives 4 fetches/day vs an epoch
// of 2–3 days — plenty without causing per-cycle HTTP fragility.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Beyond this age a cached value is considered too stale and we block on a live fetch.
// 24 hours = one full day of outage tolerance; even 12 epochs of drift is < 0.2%.
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

// Jupiter cross-check: flag if market-derived ratio diverges from Jito stats by more than this.
// 1% allows for normal market spread without false positives.
const CROSS_CHECK_TOLERANCE_PCT = 1.0;

// HTTP timeout for external calls
const HTTP_TIMEOUT_MS = 8000;

// ─── Module-level state ────────────────────────────────────────────────────────

/** @type {number|null} Last successfully computed coefficient */
let lastCoefficient = null;

/** @type {number|null} Epoch ms when lastCoefficient was set */
let lastFetchTimestamp = null;

/** @type {boolean} Guard against concurrent fetches */
let isFetching = false;

/** @type {string|null} Last error message, for diagnostics */
let lastFetchError = null;

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {'fresh' | 'stale-usable' | 'stale-expired' | 'missing' | 'fetch-failed'} CoefficientStatus
 */

/**
 * @typedef {Object} CoefficientResult
 * @property {number|null} coefficient  The JitoSOL/SOL ratio, or null if unavailable
 * @property {CoefficientStatus} status Machine-readable status string
 * @property {string} description       Human-readable status for logging
 * @property {number|null} ageMs        Age of the cached value in ms, or null
 */

// ─── Core Computation ──────────────────────────────────────────────────────────

/**
 * Computes the JitoSOL/SOL coefficient from a raw Jito stake_pool_stats response.
 *
 * The response contains arrays of {date, data} objects ordered ascending by date.
 * We always use the last element (most recent epoch snapshot).
 *
 * @param {Object} data Parsed JSON from the Jito stats API
 * @returns {{ coefficient: number|null, reason: string }}
 */
function computeFromStatsResponse(data) {
  if (!data || typeof data !== 'object') {
    return { coefficient: null, reason: 'Response is null or not an object' };
  }

  if (!Array.isArray(data.tvl) || !Array.isArray(data.supply)) {
    return { coefficient: null, reason: 'Response missing tvl or supply arrays' };
  }

  if (data.tvl.length === 0 || data.supply.length === 0) {
    return { coefficient: null, reason: 'tvl or supply array is empty' };
  }

  // Arrays are ordered ascending; last entry is the most recent epoch snapshot.
  const latestTvlEntry = data.tvl[data.tvl.length - 1];
  const latestSupplyEntry = data.supply[data.supply.length - 1];

  if (!latestTvlEntry || !latestSupplyEntry) {
    return { coefficient: null, reason: 'Latest tvl or supply entry is undefined' };
  }

  const latestTvlLamports = latestTvlEntry.data;
  const latestSupply = latestSupplyEntry.data;

  if (typeof latestTvlLamports !== 'number' || typeof latestSupply !== 'number') {
    return { coefficient: null, reason: `tvl or supply .data is not a number: tvl=${latestTvlLamports} supply=${latestSupply}` };
  }

  if (latestTvlLamports <= 0) {
    return { coefficient: null, reason: `TVL is zero or negative: ${latestTvlLamports} lamports` };
  }

  if (latestSupply <= 0) {
    return { coefficient: null, reason: `JitoSOL supply is zero or negative: ${latestSupply}` };
  }

  const tvlSol = latestTvlLamports / 1e9;
  const coefficient = tvlSol / latestSupply;

  if (!isFinite(coefficient) || isNaN(coefficient)) {
    return { coefficient: null, reason: `Computed coefficient is not a finite number: ${coefficient}` };
  }

  if (coefficient < COEFFICIENT_MIN || coefficient > COEFFICIENT_MAX) {
    return {
      coefficient: null,
      reason: `Computed coefficient ${coefficient.toFixed(6)} is outside sane bounds [${COEFFICIENT_MIN}, ${COEFFICIENT_MAX}]`,
    };
  }

  return { coefficient, reason: 'ok' };
}

// ─── Fetch and Cache ───────────────────────────────────────────────────────────

/**
 * Fetches stake_pool_stats from Jito API and updates the cached coefficient.
 * Does not throw — all errors are captured into lastFetchError.
 *
 * @returns {Promise<void>}
 */
async function refreshCoefficient() {
  if (isFetching) return;
  isFetching = true;

  try {
    const response = await axios.get(JITO_STATS_URL, { timeout: HTTP_TIMEOUT_MS });
    const { coefficient, reason } = computeFromStatsResponse(response.data);

    if (coefficient !== null) {
      lastCoefficient = coefficient;
      lastFetchTimestamp = Date.now();
      lastFetchError = null;
      log.log(`JitoCoefficient: Updated JitoSOL/SOL coefficient to ${coefficient.toFixed(6)} from Jito stake_pool_stats.`);
    } else {
      lastFetchError = reason;
      log.warn(`JitoCoefficient: Jito stats API returned unusable data — ${reason}. Keeping last-good value${lastCoefficient !== null ? ` (${lastCoefficient.toFixed(6)})` : ' (none yet)'}.`);
    }
  } catch (error) {
    lastFetchError = error.message || String(error);
    log.warn(`JitoCoefficient: Failed to fetch Jito stake_pool_stats — ${lastFetchError}. Keeping last-good value${lastCoefficient !== null ? ` (${lastCoefficient.toFixed(6)})` : ' (none yet)'}.`);
  } finally {
    isFetching = false;
  }
}

// ─── Primary API ──────────────────────────────────────────────────────────────

/**
 * Returns the current JitoSOL/SOL coefficient with status information.
 *
 * This is the entry point used by mm_price_watcher on each PW cycle.
 *
 * Caching behaviour:
 *  - FRESH (age < REFRESH_INTERVAL_MS): return immediately, no HTTP call.
 *  - STALE-USABLE (REFRESH_INTERVAL_MS ≤ age < STALE_THRESHOLD_MS): kick off
 *    a background refresh but return the last-good value now so the PW cycle
 *    is not blocked.
 *  - STALE-EXPIRED (age ≥ STALE_THRESHOLD_MS): block on a live fetch before
 *    returning. If the fetch fails, coefficient is null.
 *  - NEVER FETCHED: block on the initial fetch.
 *
 * @returns {Promise<CoefficientResult>}
 */
async function getCoefficient() {
  const now = Date.now();
  const ageMs = lastFetchTimestamp !== null ? now - lastFetchTimestamp : null;

  // ── Case 1: fresh value in cache ──────────────────────────────────────────
  if (lastCoefficient !== null && ageMs !== null && ageMs < REFRESH_INTERVAL_MS) {
    return {
      coefficient: lastCoefficient,
      status: 'fresh',
      description: `JitoSOL/SOL ${lastCoefficient.toFixed(6)} (fresh, ${Math.round(ageMs / 60000)}m old)`,
      ageMs,
    };
  }

  // ── Case 2: stale but still usable — background refresh ───────────────────
  if (lastCoefficient !== null && ageMs !== null && ageMs < STALE_THRESHOLD_MS) {
    refreshCoefficient(); // fire-and-forget, PW cycle continues immediately
    return {
      coefficient: lastCoefficient,
      status: 'stale-usable',
      description: `JitoSOL/SOL ${lastCoefficient.toFixed(6)} (stale ${Math.round(ageMs / 3600000)}h, background refresh started)`,
      ageMs,
    };
  }

  // ── Case 3: stale-expired or never fetched — blocking fetch ───────────────
  // Record timestamp before fetch so we can detect whether the refresh succeeded.
  const timestampBeforeRefresh = lastFetchTimestamp;
  await refreshCoefficient();
  const refreshSucceeded = lastFetchTimestamp !== timestampBeforeRefresh;

  if (refreshSucceeded && lastCoefficient !== null) {
    const newAge = Date.now() - lastFetchTimestamp;
    return {
      coefficient: lastCoefficient,
      status: 'fresh',
      description: `JitoSOL/SOL ${lastCoefficient.toFixed(6)} (refreshed)`,
      ageMs: newAge,
    };
  }

  // ── Case 4: blocking fetch failed — fail closed ───────────────────────────
  // The stale-expired path demands a live fetch. If that fails, the coefficient
  // is considered unavailable regardless of any old cached value.
  const status = (ageMs !== null && ageMs >= STALE_THRESHOLD_MS) ? 'stale-expired' : 'missing';
  return {
    coefficient: null,
    status,
    description: `JitoSOL/SOL coefficient unavailable — fetch failed: ${lastFetchError}`,
    ageMs: null,
  };
}

// ─── Jupiter Cross-Check ──────────────────────────────────────────────────────

/**
 * Performs a one-shot Jupiter cross-check against a Jito stats coefficient.
 *
 * Used during manual verification and live HTTP tests. NOT called on every PW cycle.
 *
 * @param {number} jitoStatsCoefficient The coefficient computed from Jito stats
 * @returns {Promise<{ ok: boolean, jupiterRatio: number|null, diffPct: number|null, message: string }>}
 */
async function crossCheckWithJupiter(jitoStatsCoefficient) {
  try {
    const url = `${JUPITER_PRICE_URL}?ids=${JITOSOL_MINT},${SOL_MINT}`;
    const response = await axios.get(url, { timeout: HTTP_TIMEOUT_MS });
    const data = response.data;

    const jitosolEntry = data?.[JITOSOL_MINT];
    const solEntry = data?.[SOL_MINT];

    if (!jitosolEntry || !solEntry) {
      return {
        ok: false,
        jupiterRatio: null,
        diffPct: null,
        message: `Jupiter API did not return prices for both tokens. Got: ${Object.keys(data || {}).join(', ')}`,
      };
    }

    const jitosolPrice = jitosolEntry.usdPrice ?? jitosolEntry.price;
    const solPrice = solEntry.usdPrice ?? solEntry.price;

    if (!jitosolPrice || !solPrice || jitosolPrice <= 0 || solPrice <= 0) {
      return {
        ok: false,
        jupiterRatio: null,
        diffPct: null,
        message: `Jupiter returned non-positive prices: JitoSOL=${jitosolPrice} SOL=${solPrice}`,
      };
    }

    const jupiterRatio = jitosolPrice / solPrice;
    const midPoint = (jupiterRatio + jitoStatsCoefficient) / 2;
    const diffPct = midPoint > 0 ? (Math.abs(jupiterRatio - jitoStatsCoefficient) / midPoint) * 100 : null;
    const ok = diffPct !== null && diffPct <= CROSS_CHECK_TOLERANCE_PCT;

    return {
      ok,
      jupiterRatio,
      diffPct,
      message: ok
        ? `Jupiter ratio ${jupiterRatio.toFixed(6)} matches Jito stats ${jitoStatsCoefficient.toFixed(6)} (diff ${(diffPct ?? 0).toFixed(4)}%)`
        : `Jupiter ratio ${jupiterRatio.toFixed(6)} diverges from Jito stats ${jitoStatsCoefficient.toFixed(6)} by ${(diffPct ?? '?').toFixed ? (diffPct).toFixed(4) : diffPct}% (threshold: ${CROSS_CHECK_TOLERANCE_PCT}%)`,
    };
  } catch (error) {
    return {
      ok: false,
      jupiterRatio: null,
      diffPct: null,
      message: `Jupiter cross-check failed: ${error.message || error}`,
    };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getCoefficient,
  refreshCoefficient,
  crossCheckWithJupiter,
  computeFromStatsResponse, // exported for unit testing

  // Exported constants for reference and tests
  COEFFICIENT_MIN,
  COEFFICIENT_MAX,
  REFRESH_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  CROSS_CHECK_TOLERANCE_PCT,
  JITO_STATS_URL,
  JUPITER_PRICE_URL,
  JITOSOL_MINT,
  SOL_MINT,

  /**
   * Test helper: inject a known coefficient and timestamp.
   * @param {number|null} coefficient
   * @param {number|null} timestamp  Epoch ms; null means never fetched
   */
  _setState(coefficient, timestamp) {
    lastCoefficient = coefficient;
    lastFetchTimestamp = timestamp;
    lastFetchError = null;
    isFetching = false;
  },

  /** Test helper: reset all state to the initial never-fetched state. */
  _resetState() {
    lastCoefficient = null;
    lastFetchTimestamp = null;
    lastFetchError = null;
    isFetching = false;
  },

  /** Diagnostic: returns a copy of the current internal state for inspection. */
  _getState() {
    return {
      lastCoefficient,
      lastFetchTimestamp,
      lastFetchError,
      isFetching,
      ageMs: lastFetchTimestamp !== null ? Date.now() - lastFetchTimestamp : null,
    };
  },
};
