/**
 * Bot alerts: the bot watches itself and posts short events (keys + numbers) to an n8n webhook,
 * which turns them into Telegram messages and runs the dead-man (offline) check.
 *
 * Observation only: nothing here changes trading behaviour.
 * The whole feature is off when alert_webhook_url is not set: no timers, no requests.
 * Sending is fire-and-forget: 5 s timeout, all errors caught and logged with log.warn.
 *
 * Event contract: POST {alert_webhook_url}, header X-Alert-Secret, JSON
 * { bot, pair, ts, kind: 'raise' | 'clear' | 'reminder' | 'heartbeat' | 'daily', key, data }
 *
 * Trading modules call the exported hooks (recordLiqCycle, recordTrade, record429, …). The hooks never throw.
 * Tests use createAlerts() with injected dependencies instead of the default instance.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const SEND_TIMEOUT_MS = 5000;
const TICK_INTERVAL_MS = MINUTE;

const ALERT_DEFAULTS = {
  alert_heartbeat_min: 10,
  alert_reminder_hours: 6,
};

/**
 * Reads alert settings from the bot's config, applying defaults
 * @param {Object} config Bot's config (modules/configReader)
 * @return {Object} Parsed alert settings. enabled is false when alert_webhook_url is missing.
 */
function parseAlertConfig(config = {}) {
  const num = (key) => {
    const value = config[key];
    return typeof value === 'number' && isFinite(value) && value >= 0 ? value : ALERT_DEFAULTS[key];
  };

  const url = typeof config.alert_webhook_url === 'string' ? config.alert_webhook_url.trim() : '';

  return {
    enabled: Boolean(url),
    url,
    secret: typeof config.alert_webhook_secret === 'string' ? config.alert_webhook_secret : '',
    heartbeatMs: num('alert_heartbeat_min') * MINUTE,
    reminderMs: num('alert_reminder_hours') * HOUR,
  };
}

/**
 * Creates an alerts instance
 * @param {Object} deps
 * @param {Object} deps.config Bot's config
 * @param {Object} deps.log Logger with log/warn
 * @param {Function} [deps.post] (url, payload, options) => Promise. Defaults to axios.post
 * @param {Function} [deps.getStatus] () => { mmActive, liqActive, pwActive }
 * @param {Function} [deps.getFairMid] () => number | null
 * @return {Object} Alerts instance
 */
function createAlerts(deps) {
  const { config, log } = deps;
  const settings = parseAlertConfig(config);
  const post = deps.post || ((url, payload, options) => require('axios').post(url, payload, options));
  const getStatus = deps.getStatus || (() => ({ mmActive: false, liqActive: false, pwActive: false }));
  const getFairMid = deps.getFairMid || (() => null);

  const startedAt = Date.now();

  let isStarted = false;
  let heartbeatTimer;
  let tickTimer;

  /** Alert keys currently raised: key -> { raisedAt, lastSentAt, data, remind } */
  const active = new Map();
  /** Raise counts since the last daily report: key -> count */
  const raiseCounts = new Map();

  // Latest observations from trading modules, reported in the heartbeat
  const state = {
    bidsOpen: null,
    asksOpen: null,
    lastLiqCycleTs: null,
    lastTradeTs: null,
    walletShareQuote: null,
  };

  /**
   * Posts an event to the webhook. Never throws, never awaited by callers.
   * @param {string} kind raise | clear | reminder | heartbeat | daily
   * @param {string} key Alert key
   * @param {Object} [data] Numbers only
   */
  function send(kind, key, data = {}) {
    if (!settings.enabled) return;

    const payload = {
      bot: config.notifyName,
      pair: config.pair,
      ts: Date.now(),
      kind,
      key,
      data,
    };

    try {
      Promise.resolve(post(settings.url, payload, {
        timeout: SEND_TIMEOUT_MS,
        headers: { 'X-Alert-Secret': settings.secret },
      })).then(() => {
        if (kind !== 'heartbeat') {
          log.log(`Bot alerts: Sent ${kind} '${key}'.`);
        }
      }).catch((e) => {
        log.warn(`Bot alerts: Unable to send ${kind} '${key}': ${e?.message || e}.`);
      });
    } catch (e) {
      log.warn(`Bot alerts: Unable to send ${kind} '${key}': ${e?.message || e}.`);
    }
  }

  /**
   * Raises an alert. Sends on the first raise; while raised, the tick sends reminders every alert_reminder_hours.
   * @param {string} key Alert key
   * @param {Object} [data] Numbers only
   * @param {Object} [options]
   * @param {boolean} [options.remind=true] Send reminders while raised
   */
  function raise(key, data = {}, { remind = true } = {}) {
    if (!settings.enabled) return;

    const now = Date.now();
    const current = active.get(key);

    if (current) {
      current.data = data;
      return;
    }

    active.set(key, { raisedAt: now, lastSentAt: now, data, remind });
    raiseCounts.set(key, (raiseCounts.get(key) || 0) + 1);
    send('raise', key, data);
  }

  /**
   * Clears an alert. Sends once, only if the key was raised.
   * @param {string} key Alert key
   * @param {Object} [data] Numbers only
   */
  function clear(key, data = {}) {
    if (!active.has(key)) return;

    active.delete(key);
    send('clear', key, data);
  }

  /**
   * Forgets a raised alert without sending anything. Used when one level replaces another.
   * @param {string} key Alert key
   */
  function drop(key) {
    active.delete(key);
  }

  function sendReminders() {
    const now = Date.now();

    for (const [key, alert] of active) {
      if (alert.remind && settings.reminderMs > 0 && now - alert.lastSentAt >= settings.reminderMs) {
        alert.lastSentAt = now;
        send('reminder', key, { ...alert.data, raisedMinAgo: Math.round((now - alert.raisedAt) / MINUTE) });
      }
    }
  }

  function heartbeatPayload() {
    const status = getStatus();
    const fairMid = getFairMid();

    return {
      mmActive: Boolean(status.mmActive),
      liqActive: Boolean(status.liqActive),
      pwActive: Boolean(status.pwActive),
      bidsOpen: state.bidsOpen,
      asksOpen: state.asksOpen,
      lastLiqCycleTs: state.lastLiqCycleTs,
      lastTradeTs: state.lastTradeTs,
      walletShareQuote: state.walletShareQuote,
      fairMid: typeof fairMid === 'number' && isFinite(fairMid) ? fairMid : null,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  }

  function sendHeartbeat() {
    try {
      send('heartbeat', 'heartbeat', heartbeatPayload());
    } catch (e) {
      log.warn(`Bot alerts: Error while sending heartbeat: ${e}.`);
    }
  }

  /**
   * Periodic evaluator for the timer-based checks. Runs every 60 s.
   */
  function tick() {
    try {
      sendReminders();
    } catch (e) {
      log.warn(`Bot alerts: Error in the evaluator tick: ${e}.`);
    }
  }

  return {
    settings,
    state,
    active,
    raiseCounts,

    /**
     * Starts the heartbeat and the evaluator tick. No-op when alert_webhook_url is not set.
     * @return {boolean} If started
     */
    start() {
      if (!settings.enabled) {
        log.log('Bot alerts: Disabled, alert_webhook_url is not set.');
        return false;
      }

      if (isStarted) return true;
      isStarted = true;

      let host = settings.url;
      try {
        host = new URL(settings.url).host;
      } catch {
        // Keep the raw value for the log line
      }

      log.log(`Bot alerts: Started. Sending events to ${host}, heartbeat every ${settings.heartbeatMs / MINUTE} min.`);

      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, settings.heartbeatMs);
      tickTimer = setInterval(tick, TICK_INTERVAL_MS);

      return true;
    },

    stop() {
      clearInterval(heartbeatTimer);
      clearInterval(tickTimer);
      isStarted = false;
    },

    raise,
    clear,
    drop,
    send,
    tick,
    heartbeatPayload,

    /**
     * Records a trade (mm execution or fill) for the no_trades check
     * @param {number} [ts] Trade timestamp
     */
    recordTrade(ts = Date.now()) {
      state.lastTradeTs = ts;
    },
  };
}

let instance;

/**
 * Returns the default instance wired to the bot's modules. Created lazily, so requiring this file
 * doesn't load the config or trading modules (and doesn't create require cycles).
 * @return {Object} Alerts instance
 */
function getInstance() {
  if (!instance) {
    const config = require('../modules/configReader');
    const log = require('./log');
    const constants = require('./const');

    instance = createAlerts({
      config,
      log,
      getStatus() {
        const tradeParams = require('../trade/settings/tradeParams_' + config.exchange);

        return {
          mmActive: Boolean(tradeParams.mm_isActive),
          liqActive: Boolean(
              tradeParams.mm_isActive &&
              tradeParams.mm_isLiquidityActive &&
              constants.MM_POLICIES_REGULAR.includes(tradeParams.mm_Policy) &&
              !config.perpetual,
          ),
          pwActive: Boolean(tradeParams.mm_isPriceWatcherActive),
        };
      },
      getFairMid() {
        const pw = require('../trade/mm_price_watcher');
        return typeof pw.getFairMid === 'function' ? pw.getFairMid() : null;
      },
    });
  }

  return instance;
}

/**
 * Wraps a hook so it can never throw into trading code
 * @param {string} name Method name on the instance
 * @return {Function}
 */
function safeHook(name) {
  return (...args) => {
    try {
      return getInstance()[name](...args);
    } catch (e) {
      try {
        require('./log').warn(`Bot alerts: Error in ${name}(): ${e}.`);
      } catch {
        // Nothing else to do
      }
    }
  };
}

module.exports = {
  ALERT_DEFAULTS,
  parseAlertConfig,
  createAlerts,
  getInstance,

  start: safeHook('start'),
  raise: safeHook('raise'),
  clear: safeHook('clear'),
  recordTrade: safeHook('recordTrade'),
};
