'use strict';

/**
 * Unit tests for OKX publicMarketGet auth-first + keyless retry.
 * Run: node tests/okx-api-auth-fallback.test.js
 */

const Module = require('module');
const path = require('path');
const { isOkxAuthError } = require('../trade/api/okx_errors');

let passed = 0;
let failed = 0;
let axiosCallCount = 0;
let axiosMockImpl;

const logMock = {
  log: () => {},
  warn: () => {},
  info: () => {},
  error: () => {},
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'axios' || request.endsWith('/axios')) {
    return (...args) => {
      axiosCallCount++;
      return axiosMockImpl(...args);
    };
  }
  if (request.includes(`${path.sep}helpers${path.sep}notify`)) {
    return () => {};
  }
  if (request.includes('configReader')) {
    return {
      notifyName: 'test-bot',
      exchange: 'coinstore',
      exchangeName: 'Coinstore',
    };
  }
  if (request.includes('tradeParams_')) {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

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

function loadFreshOkxApi() {
  delete require.cache[require.resolve('../trade/api/okx_api')];
  const OkxAPI = require('../trade/api/okx_api');
  const api = OkxAPI();
  api.setConfig('https://www.okx.com', 'test-key', 'test-secret', 'test-pass', logMock);
  return api;
}

async function main() {
  section('okx_errors.isOkxAuthError');
  assertTrue('HTTP 401 is auth error', isOkxAuthError(401, null));
  assertTrue('OKX code 50111 is auth error', isOkxAuthError(200, '50111'));
  assertTrue('OKX code 50113 is auth error', isOkxAuthError(200, '50113'));
  assertTrue('HTTP 429 is not auth error', !isOkxAuthError(429, '50011'));

  section('publicMarketGet: auth failure → keyless success');
  axiosCallCount = 0;
  const authHeaders = [];

  axiosMockImpl = async (config) => {
    if (axiosCallCount === 1) {
      authHeaders.push(config.headers?.['OK-ACCESS-KEY']);
      const error = new Error('Unauthorized');
      error.response = {
        status: 401,
        data: { code: '50113', msg: 'Invalid sign' },
      };
      throw error;
    }

    authHeaders.push(config.headers?.['OK-ACCESS-KEY']);
    return {
      status: 200,
      data: {
        code: '0',
        data: [{ instId: 'JITOSOL-USDT', bidPx: '100', askPx: '101' }],
      },
    };
  };

  const api = loadFreshOkxApi();
  const data = await api.publicMarketGet('/api/v5/market/ticker', { instId: 'JITOSOL-USDT' });

  assertTrue('Keyless retry returns ticker data', Array.isArray(data) && data[0]?.instId === 'JITOSOL-USDT');
  assertTrue('Two axios calls (auth then keyless)', axiosCallCount === 2);
  assertTrue('First call used auth header', Boolean(authHeaders[0]));
  assertTrue('Second call had no auth header', !authHeaders[1]);
  assertTrue('Auth mode is keyless after retry', api.getLastAuthMode() === 'keyless');

  section('publicMarketGet: 429 does not retry keyless');
  axiosCallCount = 0;

  axiosMockImpl = async () => {
    const error = new Error('Rate limit');
    error.response = {
      status: 429,
      data: { code: '50011', msg: 'Too many requests' },
    };
    throw error;
  };

  const api2 = loadFreshOkxApi();
  let threw429 = false;

  try {
    await api2.publicMarketGet('/api/v5/market/ticker', { instId: 'JITOSOL-USDT' });
  } catch (e) {
    threw429 = true;
    assertTrue('429 error has isTemporary flag', e.isTemporary === true);
  }

  assertTrue('Single axios call on 429 (no keyless retry)', axiosCallCount === 1);
  assertTrue('429 propagates to caller', threw429);

  section('publicMarketGet: authenticated success');
  axiosCallCount = 0;

  axiosMockImpl = async () => ({
    status: 200,
    data: { code: '0', data: [{ instId: 'JITOSOL-USDT' }] },
  });

  const api3 = loadFreshOkxApi();
  await api3.publicMarketGet('/api/v5/market/ticker', { instId: 'JITOSOL-USDT' });

  assertTrue('Single call on auth success', axiosCallCount === 1);
  assertTrue('Auth mode is authenticated', api3.getLastAuthMode() === 'authenticated');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => {
  Module._load = originalLoad;
});
