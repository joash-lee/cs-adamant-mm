'use strict';

/**
 * JitoSOL OKX PW logic tests — cross-base coefficient gating and source labels.
 * Run: node tests/jitosol-okx-pw-logic.js
 */

const { isOkxAuthError } = require('../trade/api/okx_errors');

let passed = 0;
let failed = 0;

function pass(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  failed++;
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

function assertTrue(label, value, detail) {
  if (value) pass(label);
  else fail(label, detail);
}

function assertEqual(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Mirrors mm_price_watcher cross-base detection.
 * @param {string} targetCoin1
 * @param {string} tradedCoin1
 * @returns {boolean}
 */
function isCrossBaseSource(targetCoin1, tradedCoin1) {
  return targetCoin1 !== tradedCoin1;
}

/**
 * Mirrors active source label logic from computeRangeFromSource.
 */
function buildActiveSourceLabel(sourceString, targetExchange, isCrossBase, okxAuthMode, isFallback) {
  if (isFallback) {
    return isCrossBase ?
        `${sourceString} (fallback, cross-base, coefficient applied)` :
        `${sourceString} (fallback)`;
  }
  if (targetExchange.toLowerCase() === 'okx' && !isCrossBase) {
    return `${sourceString} (direct, ${okxAuthMode || 'keyless'}, no coefficient)`;
  }
  if (isCrossBase) {
    return `${sourceString} (cross-base, coefficient applied)`;
  }
  return `${sourceString} (direct, no coefficient)`;
}

/**
 * Applies coefficient only when cross-base (mirrors computeRangeFromSource rules).
 */
function applyCoefficientIfNeeded(l, h, isCrossBase, coef) {
  if (!isCrossBase) {
    return { l, h, applied: null };
  }
  if (coef === null || coef === undefined) {
    return { ok: false };
  }
  return { ok: true, l: l * coef, h: h * coef, applied: coef };
}

section('Cross-base detection');

assertTrue('JITOSOL/USDT@OKX is NOT cross-base for JITOSOL/USDT bot', !isCrossBaseSource('JITOSOL', 'JITOSOL'));
assertTrue('SOL/USDT@Coinstore IS cross-base for JITOSOL/USDT bot', isCrossBaseSource('SOL', 'JITOSOL'));

section('Coefficient application');

{
  const direct = applyCoefficientIfNeeded(94, 95, false, 1.285);
  assertTrue('Direct OKX path skips coefficient', direct.applied === null);
  assertEqual('Direct path l unchanged', direct.l, 94);
}

{
  const fallback = applyCoefficientIfNeeded(73, 74, true, 1.285282);
  assertTrue('Coinstore fallback applies coefficient', fallback.applied === 1.285282);
  assertEqual('Fallback l multiplied', fallback.l, 73 * 1.285282);
}

{
  const failClosed = applyCoefficientIfNeeded(73, 74, true, null);
  assertTrue('Cross-base without coef fails closed', failClosed.ok === false);
}

section('Active source labels');

assertEqual(
    'OKX direct authenticated label',
    buildActiveSourceLabel('JITOSOL/USDT@OKX', 'OKX', false, 'authenticated', false),
    'JITOSOL/USDT@OKX (direct, authenticated, no coefficient)',
);

assertEqual(
    'OKX keyless label',
    buildActiveSourceLabel('JITOSOL/USDT@OKX', 'OKX', false, 'keyless', false),
    'JITOSOL/USDT@OKX (direct, keyless, no coefficient)',
);

assertEqual(
    'Coinstore fallback label',
    buildActiveSourceLabel('SOL/USDT@Coinstore', 'Coinstore', true, null, true),
    'SOL/USDT@Coinstore (fallback, cross-base, coefficient applied)',
);

section('Auth error detection for keyless retry gate');

assertTrue('50113 triggers keyless retry path', isOkxAuthError(401, '50113'));
assertTrue('429 does not trigger Coinstore fallback tier', !isOkxAuthError(429, '50011'));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
