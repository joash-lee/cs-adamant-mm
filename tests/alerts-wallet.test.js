/* global describe, it, expect, jest, beforeEach, afterEach */

const { makeAlerts } = require('./helpers/alertsHarness');

const MINUTE = 60 * 1000;
const FAIR = 100;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Wallet sample where the quote side is quoteShare % of the value (total 1000 USDT)
 * @param {number} quoteShare
 * @return {Object}
 */
const sample = (quoteShare) => ({ base: (1000 - quoteShare * 10) / FAIR, quote: quoteShare * 10, fairMid: FAIR });

const events = (sent) => sent().map((e) => `${e.kind}:${e.key}`);

// Level tests jump the split instantly; switch the fast-move check off there
const NO_FAST = { alert_wallet_fast_move_pts: 101 };

describe('wallet_warn / wallet_serious levels', () => {
  it('computes shares from value at fair mid', () => {
    const { alerts } = makeAlerts({ config: NO_FAST });
    const data = alerts.evaluateWallet({ base: 2, quote: 600, fairMid: 200 }); // 400 + 600
    expect(data).toMatchObject({ baseShare: 40, quoteShare: 60, lowSide: 'base' });
    expect(alerts.state.walletShareQuote).toBe(60);
  });

  it.each([
    ['too much base coin (unable to buy)', (share) => share, 'quote'],
    ['too much quote coin (unable to sell)', (share) => 100 - share, 'base'],
  ])('raises for %s with the right low side', (label, quoteShareOf, lowSide) => {
    const { alerts, sent } = makeAlerts({ config: NO_FAST });

    alerts.evaluateWallet(sample(quoteShareOf(30))); // exactly 30: not below
    expect(sent()).toHaveLength(0);

    alerts.evaluateWallet(sample(quoteShareOf(29.9)));
    expect(events(sent)).toEqual(['raise:wallet_warn']);
    expect(sent()[0].data.lowSide).toBe(lowSide);

    alerts.evaluateWallet(sample(quoteShareOf(15))); // exactly 15: still warn
    expect(events(sent)).toEqual(['raise:wallet_warn']);

    alerts.evaluateWallet(sample(quoteShareOf(14.9)));
    expect(events(sent)).toEqual(['raise:wallet_warn', 'raise:wallet_serious']);
    expect(sent()[1].data.lowSide).toBe(lowSide);
    expect(alerts.active.has('wallet_warn')).toBe(false); // serious replaces warn
  });

  it('does not flip-flop between 31 and 34%', () => {
    const { alerts, sent } = makeAlerts({ config: NO_FAST });
    alerts.evaluateWallet(sample(29));
    for (const share of [31, 34, 31, 33, 34.9, 31]) {
      alerts.evaluateWallet(sample(share));
    }
    expect(events(sent)).toEqual(['raise:wallet_warn']);

    alerts.evaluateWallet(sample(35)); // at the clear level
    expect(events(sent)).toEqual(['raise:wallet_warn', 'clear:wallet_warn']);
  });

  it('never raises in the 31–34% band from a clean state', () => {
    const { alerts, sent } = makeAlerts({ config: NO_FAST });
    for (const share of [31, 34, 32, 69, 66]) {
      alerts.evaluateWallet(sample(share));
    }
    expect(sent()).toHaveLength(0);
  });

  it('holds serious until the warn level, then warn until the clear level', () => {
    const { alerts, sent } = makeAlerts({ config: NO_FAST });
    alerts.evaluateWallet(sample(10));
    alerts.evaluateWallet(sample(16));
    alerts.evaluateWallet(sample(14));
    alerts.evaluateWallet(sample(29));
    expect(events(sent)).toEqual(['raise:wallet_serious']);

    alerts.evaluateWallet(sample(31)); // de-escalates to warn
    expect(events(sent)).toEqual(['raise:wallet_serious', 'raise:wallet_warn']);
    expect(alerts.active.has('wallet_serious')).toBe(false);

    alerts.evaluateWallet(sample(36));
    expect(events(sent)).toEqual(['raise:wallet_serious', 'raise:wallet_warn', 'clear:wallet_warn']);
  });

  it('clears serious directly on a big recovery', () => {
    const { alerts, sent } = makeAlerts({ config: NO_FAST });
    alerts.evaluateWallet(sample(10));
    alerts.evaluateWallet(sample(50));
    expect(events(sent)).toEqual(['raise:wallet_serious', 'clear:wallet_serious']);
  });

  it('skips the check when the fair mid is unknown', () => {
    const { alerts, sent } = makeAlerts({ config: NO_FAST });
    expect(alerts.evaluateWallet({ base: 100, quote: 1, fairMid: null })).toBeUndefined();
    expect(alerts.evaluateWallet({ base: 100, quote: 1, fairMid: 0 })).toBeUndefined();
    expect(sent()).toHaveLength(0);
    expect(alerts.state.walletShareQuote).toBeNull();
  });

  it('respects configured levels', () => {
    const { alerts, sent } = makeAlerts({ config: { ...NO_FAST, alert_wallet_warn_pct: 40, alert_wallet_clear_pct: 45 } });
    alerts.evaluateWallet(sample(39));
    expect(events(sent)).toEqual(['raise:wallet_warn']);
  });
});

describe('wallet_fast', () => {
  it('raises on a 15-point move within 60 minutes', () => {
    const { alerts, sent } = makeAlerts();
    alerts.evaluateWallet(sample(50));
    jest.advanceTimersByTime(30 * MINUTE);
    alerts.evaluateWallet(sample(40));
    jest.advanceTimersByTime(20 * MINUTE);
    alerts.evaluateWallet(sample(35.1)); // 14.9 points from 50: not yet
    expect(sent()).toHaveLength(0);

    jest.advanceTimersByTime(5 * MINUTE);
    alerts.evaluateWallet(sample(33));
    expect(events(sent)).toEqual(['raise:wallet_fast']);
    expect(sent()[0].data).toMatchObject({ fromQuoteShare: 50, toQuoteShare: 33, toBaseShare: 67, movedPts: 17, windowMin: 60 });
  });

  it('ignores the same move spread over more than 60 minutes', () => {
    const { alerts, sent } = makeAlerts();
    alerts.evaluateWallet(sample(50));
    jest.advanceTimersByTime(40 * MINUTE);
    alerts.evaluateWallet(sample(42));
    jest.advanceTimersByTime(40 * MINUTE); // the 50% sample is now 80 min old
    alerts.evaluateWallet(sample(34));
    expect(sent()).toHaveLength(0);
  });

  it('detects fast moves in both directions', () => {
    const { alerts, sent } = makeAlerts();
    alerts.evaluateWallet(sample(50));
    jest.advanceTimersByTime(10 * MINUTE);
    alerts.evaluateWallet(sample(66));
    expect(events(sent)).toEqual(['raise:wallet_fast']);
    expect(sent()[0].data.lowSide).toBe('base');
  });

  it('clears after 60 minutes without a fast move', () => {
    const { alerts, sent } = makeAlerts();
    alerts.start();
    alerts.evaluateWallet(sample(50));
    jest.advanceTimersByTime(10 * MINUTE);
    alerts.evaluateWallet(sample(66));

    const fast = () => events(sent).filter((e) => e.endsWith(':wallet_fast'));

    jest.advanceTimersByTime(59 * MINUTE);
    expect(fast()).toEqual(['raise:wallet_fast']);

    jest.advanceTimersByTime(MINUTE);
    expect(fast()).toEqual(['raise:wallet_fast', 'clear:wallet_fast']);
    alerts.stop();
  });
});

describe('side_empty', () => {
  it('raises after 5 consecutive cycles with no buy orders and clears when both sides return', () => {
    const { alerts, sent } = makeAlerts();
    for (let i = 0; i < 4; i++) alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 6 });
    expect(sent()).toHaveLength(0);

    alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 6 });
    expect(events(sent)).toEqual(['raise:side_empty']);
    expect(sent()[0].data).toMatchObject({ emptySide: 'buy', cycles: 5 });

    alerts.recordLiqCycle({ bidsOpen: 2, asksOpen: 6 });
    expect(events(sent)).toEqual(['raise:side_empty', 'clear:side_empty']);
  });

  it('names the sell side when asks are missing', () => {
    const { alerts, sent } = makeAlerts();
    for (let i = 0; i < 5; i++) alerts.recordLiqCycle({ bidsOpen: 4, asksOpen: 0 });
    expect(sent()[0].data.emptySide).toBe('sell');
  });

  it('resets the counter when both sides have orders, or the empty side changes', () => {
    const { alerts, sent } = makeAlerts();
    for (let i = 0; i < 4; i++) alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 6 });
    alerts.recordLiqCycle({ bidsOpen: 1, asksOpen: 6 });
    for (let i = 0; i < 4; i++) alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 6 });
    for (let i = 0; i < 4; i++) alerts.recordLiqCycle({ bidsOpen: 3, asksOpen: 0 });
    expect(sent()).toHaveLength(0);
  });

  it('does not count cycles with no orders on either side', () => {
    const { alerts, sent } = makeAlerts();
    for (let i = 0; i < 10; i++) alerts.recordLiqCycle({ bidsOpen: 0, asksOpen: 0 });
    expect(sent()).toHaveLength(0);
  });
});

describe('liq cycle → wallet check', () => {
  it('reads balances at most once a minute and records the cycle', async () => {
    const getBalances = jest.fn(async () => ({ base: 8.6, quote: 140 }));
    const { alerts, sent } = makeAlerts({ fairMid: FAIR, deps: { getBalances } });

    alerts.recordLiqCycle({ bidsOpen: 3, asksOpen: 4 });
    alerts.recordLiqCycle({ bidsOpen: 3, asksOpen: 4 });
    await Promise.resolve();
    await Promise.resolve();

    expect(getBalances).toHaveBeenCalledTimes(1);
    expect(alerts.state).toMatchObject({ bidsOpen: 3, asksOpen: 4, lastLiqCycleTs: Date.now() });
    expect(events(sent)).toEqual(['raise:wallet_serious']); // 860 / 1000 JITOSOL, 14% USDT

    jest.advanceTimersByTime(MINUTE);
    alerts.recordLiqCycle({ bidsOpen: 3, asksOpen: 4 });
    expect(getBalances).toHaveBeenCalledTimes(2);
  });

  it('survives a failing balance read', async () => {
    const { alerts, log } = makeAlerts({ fairMid: FAIR, deps: { getBalances: jest.fn(async () => {
      throw new Error('API down');
    }) } });

    expect(() => alerts.recordLiqCycle({ bidsOpen: 1, asksOpen: 1 })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('API down'));
  });
});
