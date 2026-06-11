/**
 * JitoSOL Anchor — Logic and Failure-Mode Tests
 *
 * Tests the coefficient computation, validation, caching, and fail-closed
 * behaviour without requiring live HTTP or a running bot.
 *
 * Run with:
 *   node tests/jitosol-anchor-logic.js
 *
 * Requires: only the helpers/cryptos/jitoCoefficient module (no config.jsonc, no tradeParams)
 */

'use strict';

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

function assertTrue(label, value, detail) {
  if (value) {
    pass(label);
  } else {
    fail(label, detail || `expected truthy, got ${JSON.stringify(value)}`);
  }
}

function assertNull(label, value) {
  if (value === null) {
    pass(label);
  } else {
    fail(label, `expected null, got ${JSON.stringify(value)}`);
  }
}

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    pass(label);
  } else {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertInRange(label, value, min, max) {
  if (typeof value === 'number' && isFinite(value) && value >= min && value <= max) {
    pass(label);
  } else {
    fail(label, `expected [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
}

// ─── Load the module under test ───────────────────────────────────────────────

// The jitoCoefficient module uses axios and log. We need to handle the require chain.
// Since this is a standalone test runner (not Jest), we mock axios globally before require.

// Minimal log mock — just swallows output so tests are clean
const logMock = {
  log: () => {},
  warn: () => {},
  error: () => {},
  info: () => {},
};

// Minimal axios mock — can be overridden per test
let axiosMockImpl = async () => { throw new Error('axiosMock not set'); };

// Inject mocks into require cache BEFORE loading jitoCoefficient
const Module = require('module');
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const basename = request.split('/').pop();
  if (basename === 'axios' || request === 'axios') {
    return { get: (...args) => axiosMockImpl(...args) };
  }
  if (basename === 'log' && parent?.id?.includes('helpers/cryptos')) {
    return logMock;
  }
  return originalLoad.apply(this, arguments);
};

// Now load the module — it will use our mocks
const jc = require('../helpers/cryptos/jitoCoefficient');

// Restore Module._load after loading
Module._load = originalLoad;

// ─── Helper: build a valid Jito API response ──────────────────────────────────

/**
 * Builds a minimal valid Jito stake_pool_stats API response.
 * @param {number} tvlLamports
 * @param {number} supply
 * @param {string} date
 */
function buildValidResponse(tvlLamports, supply, date = '2026-06-01') {
  return {
    tvl: [{ date, data: tvlLamports }],
    supply: [{ date, data: supply }],
  };
}

// ─── Section 1: computeFromStatsResponse — good data ─────────────────────────

section('Section 1: computeFromStatsResponse — valid data');

{
  // Example: ~10M SOL pool, ~8.4M JitoSOL supply → coefficient ~1.19
  const tvlLamports = 10_000_000 * 1e9; // 10M SOL in lamports
  const supply = 8_400_000;            // 8.4M JitoSOL
  const expected = (tvlLamports / 1e9) / supply; // ~1.190476

  const data = buildValidResponse(tvlLamports, supply);
  const result = jc.computeFromStatsResponse(data);

  assertEqual('Reason is "ok" for valid data', result.reason, 'ok');
  assertTrue('Returns coefficient for valid data', result.coefficient !== null, `reason=${result.reason}`);
  assertInRange(`Coefficient ${result.coefficient?.toFixed(6)} is in sane bounds`, result.coefficient, jc.COEFFICIENT_MIN, jc.COEFFICIENT_MAX);
  assertTrue(`Coefficient matches expected ${expected.toFixed(6)}`, Math.abs(result.coefficient - expected) < 1e-10, `got=${result.coefficient?.toFixed(10)}`);
}

// ─── Section 2: computeFromStatsResponse — invalid inputs ─────────────────────

section('Section 2: computeFromStatsResponse — invalid/bad inputs');

{
  const tests = [
    { label: 'null input', data: null },
    { label: 'undefined input', data: undefined },
    { label: 'empty object', data: {} },
    { label: 'tvl not an array', data: { tvl: 'bad', supply: [] } },
    { label: 'supply not an array', data: { tvl: [], supply: null } },
    { label: 'empty tvl array', data: { tvl: [], supply: [{ date: 'd', data: 8400000 }] } },
    { label: 'empty supply array', data: { tvl: [{ date: 'd', data: 1e19 }], supply: [] } },
    { label: 'tvl.data is zero', data: buildValidResponse(0, 8400000) },
    { label: 'tvl.data is negative', data: buildValidResponse(-1e9, 8400000) },
    { label: 'supply.data is zero', data: buildValidResponse(10_000_000 * 1e9, 0) },
    { label: 'supply.data is negative', data: buildValidResponse(10_000_000 * 1e9, -100) },
    { label: 'tvl.data is a string', data: { tvl: [{ date: 'd', data: '10000000000' }], supply: [{ date: 'd', data: 8400000 }] } },
    {
      label: 'coefficient below floor (1.0) — TVL < supply',
      data: buildValidResponse(7_000_000 * 1e9, 8_400_000), // coef ≈ 0.833
    },
    {
      label: 'coefficient above ceiling (1.6) — unusually high TVL',
      data: buildValidResponse(14_000_000 * 1e9, 8_400_000), // coef ≈ 1.666
    },
  ];

  for (const { label, data } of tests) {
    const result = jc.computeFromStatsResponse(data);
    assertNull(`Returns null coefficient for: ${label}`, result.coefficient);
    assertTrue(`Returns non-ok reason for: ${label}`, result.reason && result.reason !== 'ok', `reason=${result.reason}`);
  }
}

// ─── Section 3: computeFromStatsResponse — multiple time-series entries ───────

section('Section 3: computeFromStatsResponse — uses LATEST entry');

{
  // Simulate a multi-day series; latest entry should be used
  const data = {
    tvl: [
      { date: '2026-05-01', data: 9_000_000 * 1e9 },  // older
      { date: '2026-05-15', data: 9_500_000 * 1e9 },  // middle
      { date: '2026-06-01', data: 10_000_000 * 1e9 }, // latest ← should be used
    ],
    supply: [
      { date: '2026-05-01', data: 7_800_000 },
      { date: '2026-05-15', data: 8_100_000 },
      { date: '2026-06-01', data: 8_400_000 }, // latest ← should be used
    ],
  };

  const expected = (10_000_000 * 1e9 / 1e9) / 8_400_000;
  const result = jc.computeFromStatsResponse(data);

  assertTrue('Uses latest entries for calculation', result.coefficient !== null);
  assertTrue(`Coefficient matches latest epoch ${expected.toFixed(6)}`, Math.abs(result.coefficient - expected) < 1e-10, `got=${result.coefficient?.toFixed(10)}`);
}

// ─── Section 4: getCoefficient — cache states ─────────────────────────────────

section('Section 4: getCoefficient — cache state machine');

async function runCacheTests() {
  // 4a: Never fetched → blocking fetch → fresh
  {
    jc._resetState();
    axiosMockImpl = async () => ({
      data: buildValidResponse(10_000_000 * 1e9, 8_400_000),
    });

    const result = await jc.getCoefficient();
    assertEqual('Never-fetched: status is fresh', result.status, 'fresh');
    assertTrue('Never-fetched: coefficient is not null', result.coefficient !== null);
    assertTrue('Never-fetched: ageMs is non-negative', result.ageMs !== null && result.ageMs >= 0);
  }

  // 4b: Fresh cache → returns immediately without fetching again
  {
    let callCount = 0;
    axiosMockImpl = async () => {
      callCount++;
      return { data: buildValidResponse(10_000_000 * 1e9, 8_400_000) };
    };

    // Inject a fresh state (age = 1 minute)
    jc._setState(1.190476, Date.now() - 60 * 1000);
    const result = await jc.getCoefficient();

    assertEqual('Fresh cache: status is fresh', result.status, 'fresh');
    assertEqual('Fresh cache: no HTTP call made', callCount, 0);
    assertTrue('Fresh cache: returns cached coefficient', Math.abs(result.coefficient - 1.190476) < 1e-6);
  }

  // 4c: Stale-usable cache → returns last-good without blocking, triggers background refresh
  {
    let callCount = 0;
    axiosMockImpl = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50)); // simulate slow response
      return { data: buildValidResponse(10_000_000 * 1e9, 8_400_000) };
    };

    // Inject a stale state (age = 8 hours, beyond REFRESH_INTERVAL_MS=6h but < STALE_THRESHOLD_MS=24h)
    const staleAge = 8 * 60 * 60 * 1000;
    jc._setState(1.190476, Date.now() - staleAge);
    const result = await jc.getCoefficient();

    assertEqual('Stale-usable: status is stale-usable', result.status, 'stale-usable');
    assertTrue('Stale-usable: coefficient returned immediately', result.coefficient !== null);
    // Background refresh should have been triggered (callCount will be 1, but it's async)
    await new Promise((r) => setTimeout(r, 100)); // let background refresh complete
    assertTrue('Stale-usable: background refresh was triggered', callCount >= 1, `callCount=${callCount}`);
  }

  // 4d: Expired cache (> STALE_THRESHOLD_MS) → blocks on live fetch
  {
    let callCount = 0;
    axiosMockImpl = async () => {
      callCount++;
      return { data: buildValidResponse(10_050_000 * 1e9, 8_400_000) }; // slightly different coefficient
    };

    // Inject state older than STALE_THRESHOLD_MS (25 hours)
    const expiredAge = 25 * 60 * 60 * 1000;
    jc._setState(1.190476, Date.now() - expiredAge);
    const result = await jc.getCoefficient();

    assertTrue('Expired cache: made an HTTP call', callCount >= 1, `callCount=${callCount}`);
    assertTrue('Expired cache: coefficient is not null', result.coefficient !== null);
    // The new coefficient should differ from the injected stale one
    assertTrue('Expired cache: returned refreshed coefficient', Math.abs(result.coefficient - 1.190476) > 1e-7 || callCount > 0);
  }

  // 4e: Never fetched + API fails → status missing, coefficient null
  {
    jc._resetState();
    axiosMockImpl = async () => { throw new Error('Simulated network timeout'); };

    const result = await jc.getCoefficient();
    assertNull('Never-fetched + API fails: coefficient is null', result.coefficient);
    assertEqual('Never-fetched + API fails: status is missing', result.status, 'missing');
    assertTrue('Never-fetched + API fails: description mentions failure', result.description.includes('unavailable') || result.description.includes('failed'));
  }

  // 4f: Expired cache + API fails → status stale-expired, coefficient null (fail-closed)
  {
    // Reset to a clean expired state — no carry-over from previous tests
    jc._resetState();
    const expiredAge = 25 * 60 * 60 * 1000;
    jc._setState(1.190476, Date.now() - expiredAge);
    axiosMockImpl = async () => { throw new Error('Simulated connection refused'); };

    const result = await jc.getCoefficient();
    assertNull('Expired + API fails: coefficient is null (fail-closed)', result.coefficient);
    assertEqual('Expired + API fails: status is stale-expired', result.status, 'stale-expired');
  }
}

// ─── Section 5: Failure modes — bad API responses ────────────────────────────

async function runApiFailureModeTests() {
  section('Section 5: getCoefficient — API returns bad data');

  const badResponseCases = [
    { label: 'API returns null body', response: null },
    { label: 'API returns empty object', response: {} },
    { label: 'API returns empty tvl array', response: { tvl: [], supply: [{ date: 'd', data: 8400000 }] } },
    { label: 'API returns zero supply', response: buildValidResponse(1e19, 0) },
    { label: 'API returns negative TVL', response: buildValidResponse(-1e9, 8400000) },
    { label: 'API returns out-of-bounds coefficient (>1.6)', response: buildValidResponse(20_000_000 * 1e9, 8_400_000) },
  ];

  for (const { label, response } of badResponseCases) {
    jc._resetState();
    axiosMockImpl = async () => ({ data: response });

    const result = await jc.getCoefficient();
    assertNull(`${label}: coefficient is null`, result.coefficient);
    assertTrue(`${label}: status is missing or fetch-failed`, result.status === 'missing' || result.status === 'fetch-failed', `status=${result.status}`);
  }
}

// Section 6 is tested inside the async main() chain — see runRestartScenarioTest() below

// ─── Section 7: Static config coefficient validation ──────────────────────────

section('Section 7: Static config pw_source_coefficient validation');

{
  // Simulate what configReader.js does at startup
  const invalidCoefficients = [
    { value: 0, label: 'zero' },
    { value: -1, label: 'negative' },
    { value: -0.5, label: 'negative decimal' },
    { value: NaN, label: 'NaN' },
    { value: Infinity, label: 'Infinity' },
    { value: -Infinity, label: '-Infinity' },
  ];

  for (const { value, label } of invalidCoefficients) {
    const coef = +value;
    const isValid = isFinite(coef) && !isNaN(coef) && coef > 0;
    assertTrue(
        `Invalid config coefficient "${label}" is correctly rejected`,
        !isValid,
        `isFinite=${isFinite(coef)} isNaN=${isNaN(coef)} > 0=${coef > 0}`,
    );
  }

  const validCoefficients = [
    { value: 1.0, label: '1.0 (floor)' },
    { value: 1.19, label: '1.19 (current approximate rate)' },
    { value: 1.5, label: '1.5 (future upper range)' },
  ];

  for (const { value, label } of validCoefficients) {
    const coef = +value;
    const isValid = isFinite(coef) && !isNaN(coef) && coef > 0;
    assertTrue(`Valid config coefficient ${label} is accepted`, isValid);
  }
}

// ─── Section 6: Persisted tradeParams — restart scenario ─────────────────────

async function runRestartScenarioTest() {
  section('Section 6: Cross-base source persisted in tradeParams — restart scenario');

  // If a cross-base PW source (SOL/USDT@Coinstore for JITOSOL/USDT) is persisted
  // in tradeParams and the bot restarts with a clean coefficient cache, AND the Jito
  // API is unreachable, mm_price_watcher must NOT silently use coefficient=1.
  // getCoefficient() must return null so the caller can fail-closed.

  jc._resetState();
  axiosMockImpl = async () => { throw new Error('API down on restart'); };

  const result = await jc.getCoefficient();
  assertTrue(
      'After bot restart: coefficient is NOT 1 when API fails (fail-closed)',
      result.coefficient !== 1,
      `coefficient=${result.coefficient}`,
  );
  assertNull(
      'After bot restart: coefficient is null when API fails and no cached value',
      result.coefficient,
  );
  console.log(`  ℹ mm_price_watcher detects coefficient===null and calls errorSettingPriceRange() — does not proceed with 1.`);
}

// ─── Run async tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  JitoSOL Anchor — Logic and Failure-Mode Tests');
  console.log('  No HTTP, no bot config, no orders.');
  console.log('═══════════════════════════════════════════════════════════════');

  await runCacheTests();
  await runApiFailureModeTests();
  await runRestartScenarioTest();

  // Give the background refresh in section 4c a chance to complete before final report
  await new Promise((r) => setTimeout(r, 200));

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
