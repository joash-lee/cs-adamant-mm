/**
 * Test harness for helpers/botAlerts.js: an alerts instance with a mocked network and a recording logger
 */

/* global jest */

const { createAlerts } = require('../../helpers/botAlerts');

const WEBHOOK_URL = 'https://n8n.example.test/webhook/tradebot-alerts';

/**
 * @param {Object} [options]
 * @param {Object} [options.config] Extra config keys
 * @param {Object} [options.status] Initial status returned by getStatus()
 * @param {number|null} [options.fairMid]
 * @param {Object} [options.deps] Extra dependencies passed to createAlerts
 * @return {Object} { alerts, post, log, sent, status, setFairMid }
 */
function makeAlerts({ config = {}, status = {}, fairMid = null, deps = {} } = {}) {
  const post = jest.fn(() => Promise.resolve({ status: 200 }));
  const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const currentStatus = { mmActive: true, liqActive: true, pwActive: true, ...status };
  let currentFairMid = fairMid;

  const alerts = createAlerts({
    config: {
      notifyName: 'test-bot',
      pair: 'JITOSOL/USDT',
      coin1: 'JITOSOL',
      coin2: 'USDT',
      alert_webhook_url: WEBHOOK_URL,
      alert_webhook_secret: 'test-secret',
      ...config,
    },
    log,
    post,
    getStatus: () => currentStatus,
    getFairMid: () => currentFairMid,
    ...deps,
  });

  /** Events sent so far, without heartbeats unless asked */
  const sent = (withHeartbeats = false) => post.mock.calls
      .map((call) => call[1])
      .filter((payload) => withHeartbeats || payload.kind !== 'heartbeat');

  return {
    alerts,
    post,
    log,
    sent,
    status: currentStatus,
    setFairMid(value) {
      currentFairMid = value;
    },
  };
}

module.exports = { makeAlerts, WEBHOOK_URL };
