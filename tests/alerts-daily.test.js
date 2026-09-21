/* global describe, it, expect, jest, beforeEach, afterEach */

const path = require('path');

const { buildDailyReport } = require('../helpers/botAlerts');
const { readFillsSince } = require('../helpers/fillLog');
const { makeAlerts } = require('./helpers/alertsHarness');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FIXTURES = path.join(__dirname, 'fixtures');
const REPORT_TIME = Date.parse('2026-09-22T01:00:00Z');

const fixtureFills = () => readFillsSince(FIXTURES, REPORT_TIME - DAY, REPORT_TIME);

describe('daily report data', () => {
  it('counts trades against outsiders only and averages vs fair by quote', () => {
    const report = buildDailyReport({
      fills: fixtureFills(),
      balances: { base: 28.5, quote: 2140 },
      alertCounts: {},
      paused: false,
      badFillsPct: 1,
    });

    expect(report).toMatchObject({
      trades: 4, // 3 liq + 1 mm-taker
      selfTrades: 2, // mm-self excluded from trades and from the average
      selfTradeQuote: 2000,
      tradeQuote: 992,
      // (0.5 × 199 − 1 × 198 − 1.5 × 394) / (199 + 198 + 394); the fill with an unknown fair is skipped
      avgVsFairPct: -0.87,
      badFills: false,
      badFillsPct: 1,
      baseAmount: 28.5,
      quoteAmount: 2140,
      alerts: {},
      alertsTotal: 0,
      paused: false,
    });
  });

  it('flags bad fills when the average is worse than −alert_bad_fills_pct', () => {
    const report = buildDailyReport({ fills: fixtureFills(), balances: null, alertCounts: {}, paused: false, badFillsPct: 0.5 });
    expect(report.badFills).toBe(true);
    expect(report.baseAmount).toBeNull();
  });

  it('has no average and no warning without trades', () => {
    const report = buildDailyReport({ fills: [], balances: null, alertCounts: {}, paused: true, badFillsPct: 1 });
    expect(report).toMatchObject({ trades: 0, avgVsFairPct: null, badFills: false, paused: true });
  });

  it('totals the alert counts', () => {
    const report = buildDailyReport({
      fills: [], balances: null, alertCounts: { wallet_warn: 2, backup_price: 1 }, paused: false, badFillsPct: 1,
    });
    expect(report.alertsTotal).toBe(3);
  });
});

describe('daily scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const dailies = (sent) => sent().filter((e) => e.kind === 'daily');

  it('sends once per UTC day at alert_daily_utc_hour, never twice in that hour', async () => {
    jest.setSystemTime(new Date('2026-09-21T23:30:00Z'));
    const readFills = jest.fn(() => []);
    const getBalances = async () => ({ base: 1, quote: 2 });
    const { alerts, sent } = makeAlerts({ status: { liqActive: false }, deps: { readFills, getBalances } });
    alerts.start();

    jest.advanceTimersByTime(89 * MINUTE); // 00:59
    expect(dailies(sent)).toHaveLength(0);

    jest.advanceTimersByTime(MINUTE); // 01:00
    await Promise.resolve();
    await Promise.resolve();
    expect(dailies(sent)).toHaveLength(1);
    expect(readFills).toHaveBeenCalledWith(Date.now() - DAY, Date.now());
    expect(dailies(sent)[0]).toMatchObject({ key: 'daily', data: { baseAmount: 1, quoteAmount: 2 } });

    jest.advanceTimersByTime(59 * MINUTE); // rest of the hour
    await Promise.resolve();
    expect(dailies(sent)).toHaveLength(1);

    jest.advanceTimersByTime(DAY); // next day
    await Promise.resolve();
    await Promise.resolve();
    expect(dailies(sent)).toHaveLength(2);
    alerts.stop();
  });

  it('reports alert raises since the last report, without paused, then resets them', async () => {
    jest.setSystemTime(new Date('2026-09-22T00:59:30Z'));
    const { alerts, sent } = makeAlerts({ status: { liqActive: false } });
    alerts.raise('wallet_warn', {});
    alerts.clear('wallet_warn', {});
    alerts.raise('wallet_warn', {});
    alerts.raise('backup_price', {});
    alerts.raise('paused', {}, { remind: false });

    await alerts.sendDaily();
    expect(dailies(sent)[0].data).toMatchObject({ alerts: { wallet_warn: 2, backup_price: 1 }, alertsTotal: 3 });

    await alerts.sendDaily();
    expect(dailies(sent)[1].data).toMatchObject({ alerts: {}, alertsTotal: 0 });
  });

  it('marks the day paused when MM was not active in the last 24 h', async () => {
    jest.setSystemTime(new Date('2026-09-21T00:00:00Z'));
    const { alerts, sent, status } = makeAlerts({ status: { liqActive: false } });
    alerts.start(); // MM active now

    status.mmActive = false;
    jest.advanceTimersByTime(HOUR);
    await alerts.sendDaily();
    expect(dailies(sent)[0].data.paused).toBe(false); // was active an hour ago

    jest.advanceTimersByTime(DAY);
    await alerts.sendDaily();
    expect(dailies(sent).at(-1).data.paused).toBe(true);
    alerts.stop();
  });
});
