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
const DAY = 24 * HOUR;

const SEND_TIMEOUT_MS = 5000;
const TICK_INTERVAL_MS = MINUTE;
const WALLET_CHECK_INTERVAL_MS = MINUTE; // Balance reads for wallet alerts, at most once a minute
const RATE_LIMIT_WINDOW_MS = 5 * MINUTE; // alert_429_count is per this window

const ALERT_DEFAULTS = {
  alert_heartbeat_min: 10,
  alert_reminder_hours: 6,
  alert_wallet_warn_pct: 30,
  alert_wallet_serious_pct: 15,
  alert_wallet_clear_pct: 35,
  alert_wallet_fast_move_pts: 15,
  alert_wallet_fast_window_min: 60,
  alert_empty_side_cycles: 5,
  alert_no_orders_min: 10,
  alert_no_trades_min: 30,
  alert_429_count: 30,
  alert_trouble_clear_min: 30,
  alert_daily_utc_hour: 1,
  alert_bad_fills_pct: 1,
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
    walletWarnPct: num('alert_wallet_warn_pct'),
    walletSeriousPct: num('alert_wallet_serious_pct'),
    walletClearPct: num('alert_wallet_clear_pct'),
    walletFastPts: num('alert_wallet_fast_move_pts'),
    walletFastWindowMs: num('alert_wallet_fast_window_min') * MINUTE,
    emptySideCycles: num('alert_empty_side_cycles'),
    noOrdersMs: num('alert_no_orders_min') * MINUTE,
    noTradesMs: num('alert_no_trades_min') * MINUTE,
    count429: num('alert_429_count'),
    troubleClearMs: num('alert_trouble_clear_min') * MINUTE,
    dailyUtcHour: num('alert_daily_utc_hour') % 24,
    badFillsPct: num('alert_bad_fills_pct'),
  };
}

/**
 * Creates an alerts instance
 * @param {Object} deps
 * @param {Object} deps.config Bot's config
 * @param {Object} deps.log Logger with log/warn
 * @param {Function} [deps.post] (url, payload, options) => Promise. Defaults to axios.post
 * @param {Function} [deps.getStatus] () => { mmActive, liqActive, pwActive, tradesExpected }
 * @param {Function} [deps.getFairMid] () => number | null
 * @param {Function} [deps.getBalances] async () => { base, quote } | null, free + locked amounts
 * @param {Function} [deps.readFills] (sinceTs, nowTs) => Array of fill lines (helpers/fillLog.js)
 * @return {Object} Alerts instance
 */
function createAlerts(deps) {
  const { config, log } = deps;
  const settings = parseAlertConfig(config);
  const post = deps.post || ((url, payload, options) => require('axios').post(url, payload, options));
  const getStatus = deps.getStatus || (() => ({ mmActive: false, liqActive: false, pwActive: false }));
  const getFairMid = deps.getFairMid || (() => null);
  const getBalances = deps.getBalances || (async () => null);
  const readFills = deps.readFills || (() => []);

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
    ordersSeenTs: null, // Last liq cycle with at least one order open
  };

  // Stopped-trading checks: since when MM and liq are active (null = inactive)
  const activity = {
    mmActiveSince: null,
    liqActiveSince: null,
    lastMmActiveTs: null,
  };

  // Daily report
  const daily = {
    lastSentDay: null, // UTC date of the last report, guards against double sends
  };

  // exchange_trouble
  const trouble = {
    hits429: [], // Timestamps of HTTP 429 responses within the window
    lastTroubleTs: 0,
  };

  // Wallet alerts
  const wallet = {
    lastCheckTs: 0,
    isCheckInProgress: false,
    samples: [], // { ts, quoteShare } within the fast-move window
    lastFastMoveTs: 0,
    emptySide: null, // 'buy' | 'sell': the side with no liq orders
    emptySideCycles: 0,
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

  const round1 = (value) => Math.round(value * 10) / 10;

  /**
   * Evaluates side_empty after a liq cycle: one side has no liq orders for N consecutive cycles
   * @param {number} bidsOpen
   * @param {number} asksOpen
   */
  function evaluateSideEmpty(bidsOpen, asksOpen) {
    if (bidsOpen > 0 && asksOpen > 0) {
      wallet.emptySide = null;
      wallet.emptySideCycles = 0;
      clear('side_empty', { bidsOpen, asksOpen });
      return;
    }

    if (bidsOpen === 0 && asksOpen === 0) {
      // No orders at all is the no_orders case; don't count it as one-sided
      wallet.emptySide = null;
      wallet.emptySideCycles = 0;
      return;
    }

    const emptySide = bidsOpen === 0 ? 'buy' : 'sell';

    if (wallet.emptySide === emptySide) {
      wallet.emptySideCycles += 1;
    } else {
      wallet.emptySide = emptySide;
      wallet.emptySideCycles = 1;
    }

    if (wallet.emptySideCycles >= settings.emptySideCycles) {
      raise('side_empty', { emptySide, cycles: wallet.emptySideCycles, bidsOpen, asksOpen });
    }
  }

  /**
   * Wallet level with hysteresis: serious holds until the weaker side is back to the warn level,
   * warn holds until it's above the clear level
   * @param {number} weakerShare Weaker side's share of wallet value, %
   * @return {'serious' | 'warn' | null}
   */
  function walletLevel(weakerShare) {
    const current = active.has('wallet_serious') ? 'serious' : active.has('wallet_warn') ? 'warn' : null;

    if (weakerShare < settings.walletSeriousPct) return 'serious';
    if (current === 'serious' && weakerShare < settings.walletWarnPct) return 'serious';
    if (weakerShare < settings.walletWarnPct) return 'warn';
    if (current && weakerShare < settings.walletClearPct) return 'warn';
    return null;
  }

  /**
   * Evaluates wallet_warn, wallet_serious and wallet_fast from one balance sample
   * Share = value of each side / total, using free + locked balances and the fair mid
   * @param {Object} sample
   * @param {number} sample.base Base coin amount, free + locked
   * @param {number} sample.quote Quote coin amount, free + locked
   * @param {number|null} sample.fairMid
   * @return {Object|undefined} Computed shares, undefined when skipped
   */
  function evaluateWallet({ base, quote, fairMid }) {
    if (!(typeof fairMid === 'number' && isFinite(fairMid) && fairMid > 0)) return;
    if (!isFinite(base) || !isFinite(quote) || base < 0 || quote < 0) return;

    const baseValue = base * fairMid;
    const total = baseValue + quote;
    if (!(total > 0)) return;

    const now = Date.now();
    const quoteShare = quote / total * 100;
    const baseShare = 100 - quoteShare;
    const lowSide = quoteShare < baseShare ? 'quote' : 'base';
    const weakerShare = Math.min(quoteShare, baseShare);

    state.walletShareQuote = round1(quoteShare);

    const data = {
      baseShare: round1(baseShare),
      quoteShare: round1(quoteShare),
      lowSide, // 'quote': too much base coin, the bot will be unable to buy. 'base': unable to sell
      baseAmount: base,
      quoteAmount: quote,
      fairMid,
    };

    // Levels are exclusive: one replaces the other without a clear message

    const level = walletLevel(weakerShare);

    if (level === 'serious') {
      drop('wallet_warn');
      raise('wallet_serious', data);
    } else if (level === 'warn') {
      drop('wallet_serious');
      raise('wallet_warn', data);
    } else {
      clear('wallet_serious', data);
      clear('wallet_warn', data);
    }

    // Fast move: compare with every sample in the window, take the biggest move

    wallet.samples = wallet.samples.filter((s) => now - s.ts <= settings.walletFastWindowMs);

    let from;
    for (const s of wallet.samples) {
      if (!from || Math.abs(quoteShare - s.quoteShare) > Math.abs(quoteShare - from.quoteShare)) {
        from = s;
      }
    }

    wallet.samples.push({ ts: now, quoteShare });

    if (from && Math.abs(quoteShare - from.quoteShare) >= settings.walletFastPts) {
      wallet.lastFastMoveTs = now;
      raise('wallet_fast', {
        fromQuoteShare: round1(from.quoteShare),
        fromBaseShare: round1(100 - from.quoteShare),
        toQuoteShare: round1(quoteShare),
        toBaseShare: round1(baseShare),
        movedPts: round1(Math.abs(quoteShare - from.quoteShare)),
        windowMin: Math.round(settings.walletFastWindowMs / MINUTE),
        lowSide,
      });
    }

    return data;
  }

  /**
   * Reads balances and evaluates the wallet alerts. Fire-and-forget from the liq cycle.
   */
  async function checkWallet() {
    if (wallet.isCheckInProgress) return;
    wallet.isCheckInProgress = true;

    try {
      const balances = await getBalances();
      if (balances) {
        evaluateWallet({ base: +balances.base, quote: +balances.quote, fairMid: getFairMid() });
      }
    } catch (e) {
      log.warn(`Bot alerts: Unable to check the wallet balance: ${e}.`);
    } finally {
      wallet.isCheckInProgress = false;
    }
  }

  /**
   * Evaluates paused, no_orders and no_trades. Runs in the tick, so a stuck liq loop is still caught.
   * @param {Object} status getStatus() result
   */
  function evaluateActivity(status) {
    const now = Date.now();

    if (!status.mmActive) {
      // Paused: only the paused info, sent once. Forget the other stopped-trading alerts without a clear message
      activity.mmActiveSince = null;
      activity.liqActiveSince = null;
      drop('no_orders');
      drop('no_trades');
      raise('paused', {}, { remind: false });
      return;
    }

    activity.lastMmActiveTs = now;
    if (activity.mmActiveSince === null) {
      activity.mmActiveSince = now;
    }

    clear('paused', {}); // ▶️ resumed

    // no_trades: MM active (and expected to trade), no mm execution or fill for N minutes

    if (status.tradesExpected !== false) {
      const tradeRefTs = Math.max(state.lastTradeTs || 0, activity.mmActiveSince);
      const minutesWithoutTrades = (now - tradeRefTs) / MINUTE;

      if (now - tradeRefTs >= settings.noTradesMs) {
        raise('no_trades', { minutes: Math.round(minutesWithoutTrades), lastTradeTs: state.lastTradeTs });
      } else {
        clear('no_trades', {});
      }
    } else {
      drop('no_trades');
    }

    // no_orders: liq active, and no liq cycle with orders open for N minutes (covers a stuck liq loop)

    if (status.liqActive) {
      if (activity.liqActiveSince === null) {
        activity.liqActiveSince = now;
      }

      const ordersRefTs = Math.max(state.ordersSeenTs || 0, activity.liqActiveSince);

      if (now - ordersRefTs >= settings.noOrdersMs) {
        raise('no_orders', {
          minutes: Math.round((now - ordersRefTs) / MINUTE),
          bidsOpen: state.bidsOpen,
          asksOpen: state.asksOpen,
          lastLiqCycleMinAgo: state.lastLiqCycleTs ? Math.round((now - state.lastLiqCycleTs) / MINUTE) : null,
        });
      } else {
        clear('no_orders', { bidsOpen: state.bidsOpen, asksOpen: state.asksOpen });
      }
    } else {
      activity.liqActiveSince = null;
      drop('no_orders');
    }
  }

  /**
   * Raises exchange_trouble. It clears after alert_trouble_clear_min without trouble.
   * @param {'rate_limit' | 'open_orders_failed' | 'false_empty'} reason
   * @param {Object} [data] Numbers only
   */
  function reportExchangeTrouble(reason, data = {}) {
    if (!settings.enabled) return;

    trouble.lastTroubleTs = Date.now();
    raise('exchange_trouble', { reason, ...data });
  }

  function prune429(now) {
    while (trouble.hits429.length && now - trouble.hits429[0] > RATE_LIMIT_WINDOW_MS) {
      trouble.hits429.shift();
    }
  }

  /**
   * Builds and sends the daily report: last 24 h of the fill log, one balance read, alert counts
   */
  async function sendDaily() {
    const now = Date.now();

    // Take the counts first, so raises during the awaits below go to the next report
    const alertCounts = {};
    for (const [key, count] of raiseCounts) {
      if (key !== 'paused') alertCounts[key] = count; // paused is info, reported as the paused flag
    }
    raiseCounts.clear();

    const status = getStatus();
    const paused = !status.mmActive && (activity.lastMmActiveTs === null || now - activity.lastMmActiveTs >= DAY);

    let fills = [];
    try {
      fills = readFills(now - DAY, now) || [];
    } catch (e) {
      log.warn(`Bot alerts: Unable to read the fill log for the daily report: ${e}.`);
    }

    let balances = null;
    try {
      balances = await getBalances();
    } catch (e) {
      log.warn(`Bot alerts: Unable to read balances for the daily report: ${e}.`);
    }

    send('daily', 'daily', buildDailyReport({ fills, balances, alertCounts, paused, badFillsPct: settings.badFillsPct }));
  }

  /**
   * Sends the daily report once per UTC day, in the alert_daily_utc_hour hour
   */
  function checkDaily() {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);

    if (now.getUTCHours() === settings.dailyUtcHour && daily.lastSentDay !== day) {
      daily.lastSentDay = day;
      sendDaily().catch((e) => log.warn(`Bot alerts: Unable to send the daily report: ${e}.`));
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
      const now = Date.now();

      evaluateActivity(getStatus());

      prune429(now);
      if (active.has('exchange_trouble') && now - trouble.lastTroubleTs >= settings.troubleClearMs) {
        clear('exchange_trouble', {});
      }

      if (active.has('wallet_fast') && now - wallet.lastFastMoveTs >= settings.walletFastWindowMs) {
        clear('wallet_fast', {});
      }

      sendReminders();
      checkDaily();
    } catch (e) {
      log.warn(`Bot alerts: Error in the evaluator tick: ${e}.`);
    }
  }

  return {
    settings,
    state,
    activity,
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
      tick(); // Starts the stopped-trading clocks now, and reports paused right away
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
    evaluateWallet,
    checkWallet,
    reportExchangeTrouble,
    sendDaily,

    /**
     * Records an HTTP 429 (rate limit) response from the exchange
     * Raises exchange_trouble when there are alert_429_count of them within 5 minutes
     */
    record429() {
      if (!settings.enabled) return;

      const now = Date.now();
      trouble.hits429.push(now);
      prune429(now);

      if (trouble.hits429.length >= settings.count429) {
        reportExchangeTrouble('rate_limit', { count429: trouble.hits429.length, windowMin: RATE_LIMIT_WINDOW_MS / MINUTE });
      }
    },

    /**
     * Records a finished liq cycle: open liq orders on each side (depth + ss)
     * Evaluates side_empty and, at most once a minute, the wallet balance alerts
     * @param {Object} cycle
     * @param {number} cycle.bidsOpen
     * @param {number} cycle.asksOpen
     */
    recordLiqCycle({ bidsOpen, asksOpen }) {
      if (!settings.enabled) return;

      const now = Date.now();

      state.bidsOpen = bidsOpen;
      state.asksOpen = asksOpen;
      state.lastLiqCycleTs = now;

      if (bidsOpen + asksOpen > 0) {
        state.ordersSeenTs = now;
      }

      evaluateSideEmpty(bidsOpen, asksOpen);

      if (now - wallet.lastCheckTs >= WALLET_CHECK_INTERVAL_MS) {
        wallet.lastCheckTs = now;
        checkWallet(); // Not awaited: never slow the liq loop
      }
    },

    /**
     * Records a trade (mm execution or fill) for the no_trades check
     * @param {number} [ts] Trade timestamp
     */
    recordTrade(ts = Date.now()) {
      state.lastTradeTs = ts;
    },
  };
}

/**
 * Builds the daily report data (numbers only; n8n writes the words)
 * @param {Object} params
 * @param {Array<Object>} params.fills Fill lines of the last 24 h
 * @param {Object|null} params.balances { base, quote }, free + locked
 * @param {Object} params.alertCounts Raises per key
 * @param {boolean} params.paused MM paused all day
 * @param {number} params.badFillsPct Warn when the average vs fair is worse than −this
 * @return {Object}
 */
function buildDailyReport({ fills, balances, alertCounts, paused, badFillsPct }) {
  const { summarizeFills } = require('./fillLog');
  const summary = summarizeFills(fills, badFillsPct);
  const alertsTotal = Object.values(alertCounts).reduce((sum, count) => sum + count, 0);

  return {
    ...summary, // trades, selfTrades, selfTradeQuote, tradeQuote, avgVsFairPct, badFills
    badFillsPct,
    baseAmount: balances ? +balances.base : null,
    quoteAmount: balances ? +balances.quote : null,
    alerts: alertCounts,
    alertsTotal,
    paused: Boolean(paused),
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
          tradesExpected: tradeParams.mm_Policy !== 'depth', // depth policy doesn't create volume
        };
      },
      getFairMid() {
        const pw = require('../trade/mm_price_watcher');
        return typeof pw.getFairMid === 'function' ? pw.getFairMid() : null;
      },
      async getBalances() {
        const orderUtils = require('../trade/orderUtils');
        const balances = await orderUtils.getBalancesCached(false, 'botAlerts');

        if (!Array.isArray(balances)) return null;

        const amount = (code) => {
          const coin = balances.find((b) => b.code === code);
          return coin ? (+coin.free || 0) + (+coin.freezed || 0) : 0;
        };

        return { base: amount(config.coin1), quote: amount(config.coin2) };
      },
      readFills(sinceTs, nowTs) {
        const path = require('path');
        return require('./fillLog').readFillsSince(path.resolve('./logs'), sinceTs, nowTs); // Same folder as helpers/log.js
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
  buildDailyReport,
  getInstance,

  start: safeHook('start'),
  raise: safeHook('raise'),
  clear: safeHook('clear'),
  recordTrade: safeHook('recordTrade'),
  recordLiqCycle: safeHook('recordLiqCycle'),
  record429: safeHook('record429'),
  reportExchangeTrouble: safeHook('reportExchangeTrouble'),
};
