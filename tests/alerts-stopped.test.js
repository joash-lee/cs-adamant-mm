/* global describe, it, expect, jest, beforeEach, afterEach */

const { makeAlerts } = require('./helpers/alertsHarness');

const MINUTE = 60 * 1000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

const events = (sent) => sent().map((e) => `${e.kind}:${e.key}`);
const eventsFor = (sent, key) => sent().filter((e) => e.key === key).map((e) => e.kind);

describe('no_orders', () => {
  it('raises after 10 minutes with no orders on either side, and clears when orders are back', () => {
    const { alerts, sent } = makeAlerts();
    alerts.start();
    alerts.recordLiqCycle({ bidsOpen: 3, asksOpen: 3 });

    // Liq keeps cycling but with nothing on the book
    for (let i = 0; i < 9; i++) {
      jest.advanceTimersByTime(MINUTE);
      alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 0 });
    }
    expect(eventsFor(sent, 'no_orders')).toEqual([]);

    jest.advanceTimersByTime(MINUTE);
    alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 0 });
    expect(eventsFor(sent, 'no_orders')).toEqual(['raise']);
    expect(sent().find((e) => e.key === 'no_orders').data).toMatchObject({ minutes: 10, bidsOpen: 0, asksOpen: 0, lastLiqCycleMinAgo: 1 });

    alerts.recordLiqCycle({ bidsOpen: 2, asksOpen: 1 });
    jest.advanceTimersByTime(MINUTE);
    expect(eventsFor(sent, 'no_orders')).toEqual(['raise', 'clear']);
    alerts.stop();
  });

  it('still raises when the liq loop is stuck and reports nothing', () => {
    const { alerts, sent } = makeAlerts();
    alerts.start();
    alerts.recordLiqCycle({ bidsOpen: 5, asksOpen: 5 });

    // No more liq cycles at all
    jest.advanceTimersByTime(10 * MINUTE);
    expect(eventsFor(sent, 'no_orders')).toEqual(['raise']);
    expect(sent().find((e) => e.key === 'no_orders').data).toMatchObject({ lastLiqCycleMinAgo: 10 });
    alerts.stop();
  });

  it('raises when liq never completed a cycle since it became active', () => {
    const { alerts, sent } = makeAlerts();
    alerts.start();
    jest.advanceTimersByTime(10 * MINUTE);
    expect(eventsFor(sent, 'no_orders')).toEqual(['raise']);
    expect(sent().find((e) => e.key === 'no_orders').data.lastLiqCycleMinAgo).toBeNull();
    alerts.stop();
  });

  it('is not checked while liq is inactive', () => {
    const { alerts, sent } = makeAlerts({ status: { liqActive: false } });
    alerts.start();
    alerts.recordTrade();
    jest.advanceTimersByTime(20 * MINUTE);
    expect(eventsFor(sent, 'no_orders')).toEqual([]);
    alerts.stop();
  });
});

describe('no_trades', () => {
  it('raises after 30 minutes without a trade while MM is active, clears on the next trade', () => {
    const { alerts, sent } = makeAlerts({ status: { liqActive: false } });
    alerts.start();
    alerts.recordTrade();

    jest.advanceTimersByTime(29 * MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual([]);

    jest.advanceTimersByTime(MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual(['raise']);
    expect(sent().find((e) => e.key === 'no_trades').data.minutes).toBe(30);

    alerts.recordTrade();
    jest.advanceTimersByTime(MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual(['raise', 'clear']);
    alerts.stop();
  });

  it('only counts time while MM is active', () => {
    const { alerts, sent, status } = makeAlerts({ status: { mmActive: false, liqActive: false } });
    alerts.start();
    jest.advanceTimersByTime(2 * 60 * MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual([]);

    status.mmActive = true; // resumed: the 30 minutes start now
    jest.advanceTimersByTime(29 * MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual([]);
    jest.advanceTimersByTime(2 * MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual(['raise']);
    alerts.stop();
  });

  it('is not raised for the depth policy, which makes no volume', () => {
    const { alerts, sent } = makeAlerts({ status: { liqActive: false, tradesExpected: false } });
    alerts.start();
    jest.advanceTimersByTime(3 * 60 * MINUTE);
    expect(eventsFor(sent, 'no_trades')).toEqual([]);
    alerts.stop();
  });
});

describe('paused / resumed', () => {
  it('sends paused once, nothing else while paused, and resumed when MM is back', () => {
    const { alerts, sent, status } = makeAlerts({ status: { mmActive: false, liqActive: false } });
    alerts.start();

    jest.advanceTimersByTime(MINUTE);
    expect(events(sent)).toEqual(['raise:paused']);

    jest.advanceTimersByTime(24 * 60 * MINUTE); // no reminders, no other stopped-trading alerts
    expect(events(sent)).toEqual(['raise:paused']);

    status.mmActive = true;
    status.liqActive = true;
    alerts.recordLiqCycle({ bidsOpen: 2, asksOpen: 2 });
    alerts.recordTrade();
    jest.advanceTimersByTime(MINUTE);
    expect(events(sent)).toEqual(['raise:paused', 'clear:paused']);
    alerts.stop();
  });

  it('forgets no_orders and no_trades when paused, without a clear message', () => {
    const { alerts, sent, status } = makeAlerts();
    alerts.start();
    jest.advanceTimersByTime(30 * MINUTE);
    expect(events(sent).sort()).toEqual(['raise:no_orders', 'raise:no_trades']);

    status.mmActive = false;
    status.liqActive = false;
    jest.advanceTimersByTime(MINUTE);
    expect(events(sent).slice(2)).toEqual(['raise:paused']);
    expect(alerts.active.has('no_orders')).toBe(false);
    expect(alerts.active.has('no_trades')).toBe(false);
    alerts.stop();
  });
});
