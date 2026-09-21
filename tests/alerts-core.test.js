/* global describe, it, expect, jest, beforeEach, afterEach */

const { createAlerts, parseAlertConfig } = require('../helpers/botAlerts');
const { makeAlerts, WEBHOOK_URL } = require('./helpers/alertsHarness');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('config', () => {
  it('applies defaults and reads overrides', () => {
    const defaults = parseAlertConfig({ alert_webhook_url: WEBHOOK_URL });
    expect(defaults.enabled).toBe(true);
    expect(defaults.heartbeatMs).toBe(10 * MINUTE);
    expect(defaults.reminderMs).toBe(6 * HOUR);

    const custom = parseAlertConfig({ alert_webhook_url: WEBHOOK_URL, alert_heartbeat_min: 5, alert_reminder_hours: 2 });
    expect(custom.heartbeatMs).toBe(5 * MINUTE);
    expect(custom.reminderMs).toBe(2 * HOUR);
  });

  it('ignores invalid numbers', () => {
    const parsed = parseAlertConfig({ alert_webhook_url: WEBHOOK_URL, alert_heartbeat_min: 'ten', alert_reminder_hours: -1 });
    expect(parsed.heartbeatMs).toBe(10 * MINUTE);
    expect(parsed.reminderMs).toBe(6 * HOUR);
  });
});

describe('off when unconfigured', () => {
  it('starts no timers and sends nothing without alert_webhook_url', () => {
    const post = jest.fn();
    const log = { log: jest.fn(), warn: jest.fn() };
    const alerts = createAlerts({ config: { notifyName: 'bot', pair: 'A/B' }, log, post });

    expect(alerts.start()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    alerts.raise('wallet_warn', { quoteShare: 20 });
    alerts.clear('wallet_warn');
    alerts.recordTrade();
    jest.advanceTimersByTime(24 * HOUR);

    expect(post).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(alerts.active.size).toBe(0);
  });

  it('treats a blank URL as missing', () => {
    expect(parseAlertConfig({ alert_webhook_url: '   ' }).enabled).toBe(false);
  });
});

describe('raise / clear / reminder', () => {
  it('sends the contract payload with the secret header and a 5 s timeout', () => {
    const { alerts, post } = makeAlerts();
    alerts.raise('wallet_warn', { quoteShare: 28 });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, payload, options] = post.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(payload).toEqual({
      bot: 'test-bot',
      pair: 'JITOSOL/USDT',
      ts: Date.now(),
      kind: 'raise',
      key: 'wallet_warn',
      data: { quoteShare: 28 },
    });
    expect(options.timeout).toBe(5000);
    expect(options.headers['X-Alert-Secret']).toBe('test-secret');
  });

  it('sends a raise once, however often it is raised', () => {
    const { alerts, sent } = makeAlerts();
    alerts.raise('backup_price', {});
    alerts.raise('backup_price', {});
    alerts.raise('backup_price', {});
    expect(sent().map((e) => e.kind)).toEqual(['raise']);
  });

  it('sends a reminder every alert_reminder_hours while raised', () => {
    const { alerts, sent } = makeAlerts({ config: { alert_reminder_hours: 6 } });
    const backup = () => sent().filter((e) => e.key === 'backup_price');
    alerts.start();
    alerts.raise('backup_price', { x: 1 });

    jest.advanceTimersByTime(6 * HOUR - MINUTE);
    expect(backup().map((e) => e.kind)).toEqual(['raise']);

    jest.advanceTimersByTime(MINUTE);
    expect(backup().map((e) => e.kind)).toEqual(['raise', 'reminder']);
    expect(backup()[1].data).toMatchObject({ x: 1, raisedMinAgo: 360 });

    jest.advanceTimersByTime(6 * HOUR);
    expect(backup().map((e) => e.kind)).toEqual(['raise', 'reminder', 'reminder']);
    alerts.stop();
  });

  it('sends no reminders for keys raised with remind: false', () => {
    const { alerts, sent } = makeAlerts({ status: { mmActive: false } });
    alerts.start(); // MM paused: raises 'paused' without reminders
    jest.advanceTimersByTime(24 * HOUR);
    expect(sent().map((e) => `${e.kind}:${e.key}`)).toEqual(['raise:paused']);
    alerts.stop();
  });

  it('clears only after a raise, and only once', () => {
    const { alerts, sent } = makeAlerts();
    alerts.clear('wallet_warn');
    expect(sent()).toHaveLength(0);

    alerts.raise('wallet_warn', {});
    alerts.clear('wallet_warn', { quoteShare: 40 });
    alerts.clear('wallet_warn');
    expect(sent().map((e) => `${e.kind}:${e.key}`)).toEqual(['raise:wallet_warn', 'clear:wallet_warn']);
  });

  it('counts raises for the daily report', () => {
    const { alerts } = makeAlerts();
    alerts.raise('wallet_warn', {});
    alerts.clear('wallet_warn', {});
    alerts.raise('wallet_warn', {});
    expect(alerts.raiseCounts.get('wallet_warn')).toBe(2);
  });
});

describe('sender errors', () => {
  it('swallows a rejected request and logs a warning', async () => {
    const { alerts, log } = makeAlerts({
      deps: { post: jest.fn(() => Promise.reject(new Error('timeout of 5000ms exceeded'))) },
    });

    expect(() => alerts.raise('wallet_warn', {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('timeout of 5000ms exceeded'));
  });

  it('swallows a synchronous throw', () => {
    const { alerts, log } = makeAlerts({
      deps: { post: jest.fn(() => {
        throw new Error('boom');
      }) },
    });

    expect(() => alerts.raise('wallet_warn', {})).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('never logs the secret', async () => {
    const { alerts, log } = makeAlerts({ deps: { post: jest.fn(() => Promise.reject(new Error('fail'))) } });
    alerts.start();
    alerts.raise('wallet_warn', {});
    await Promise.resolve();
    await Promise.resolve();
    const allLogs = [...log.log.mock.calls, ...log.warn.mock.calls].flat().join('\n');
    expect(allLogs).not.toContain('test-secret');
    alerts.stop();
  });
});

describe('heartbeat', () => {
  it('sends one on start, then every alert_heartbeat_min, with the payload shape', () => {
    const { alerts, sent } = makeAlerts({ config: { alert_heartbeat_min: 10 }, fairMid: 250.5 });
    alerts.start();

    const heartbeats = () => sent(true).filter((e) => e.kind === 'heartbeat');
    expect(heartbeats()).toHaveLength(1);

    jest.advanceTimersByTime(10 * MINUTE);
    expect(heartbeats()).toHaveLength(2);

    const beat = heartbeats()[1];
    expect(beat.key).toBe('heartbeat');
    expect(Object.keys(beat.data).sort()).toEqual([
      'asksOpen', 'bidsOpen', 'fairMid', 'lastLiqCycleTs', 'lastTradeTs',
      'liqActive', 'mmActive', 'pwActive', 'uptimeSec', 'walletShareQuote',
    ]);
    expect(beat.data).toMatchObject({ mmActive: true, liqActive: true, pwActive: true, fairMid: 250.5, uptimeSec: 600 });
    alerts.stop();
  });

  it('reports the last trade time', () => {
    const { alerts } = makeAlerts();
    alerts.recordTrade(1234);
    expect(alerts.heartbeatPayload().lastTradeTs).toBe(1234);
  });
});
