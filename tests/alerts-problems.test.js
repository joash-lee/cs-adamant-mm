/* global describe, it, expect, jest, beforeEach, afterEach */

const fs = require('fs');
const path = require('path');

const { makeAlerts } = require('./helpers/alertsHarness');

const MINUTE = 60 * 1000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-21T12:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

const troubleEvents = (sent) => sent().filter((e) => e.key === 'exchange_trouble');

describe('exchange_trouble from HTTP 429s', () => {
  it('does not raise on 29 in 5 minutes, raises on the 30th', () => {
    const { alerts, sent } = makeAlerts();
    for (let i = 0; i < 29; i++) {
      alerts.record429();
      jest.advanceTimersByTime(10 * 1000);
    }
    expect(troubleEvents(sent)).toHaveLength(0);

    alerts.record429();
    expect(troubleEvents(sent).map((e) => e.kind)).toEqual(['raise']);
    expect(troubleEvents(sent)[0].data).toEqual({ reason: 'rate_limit', count429: 30, windowMin: 5 });
  });

  it('only counts 429s within the last 5 minutes', () => {
    const { alerts, sent } = makeAlerts();
    for (let i = 0; i < 20; i++) alerts.record429();
    jest.advanceTimersByTime(5 * MINUTE + 1);
    for (let i = 0; i < 20; i++) alerts.record429();
    expect(troubleEvents(sent)).toHaveLength(0);
  });

  it('respects alert_429_count', () => {
    const { alerts, sent } = makeAlerts({ config: { alert_429_count: 3 } });
    alerts.record429();
    alerts.record429();
    alerts.record429();
    expect(troubleEvents(sent)).toHaveLength(1);
  });
});

describe('exchange_trouble clearing', () => {
  it('clears after 30 minutes without trouble, and a new signal restarts the clock', () => {
    const { alerts, sent } = makeAlerts();
    alerts.start();
    alerts.reportExchangeTrouble('open_orders_failed');
    expect(troubleEvents(sent)[0].data).toEqual({ reason: 'open_orders_failed' });

    jest.advanceTimersByTime(20 * MINUTE);
    alerts.reportExchangeTrouble('false_empty'); // still raised: no second message
    expect(troubleEvents(sent).map((e) => e.kind)).toEqual(['raise']);

    jest.advanceTimersByTime(29 * MINUTE);
    expect(troubleEvents(sent).map((e) => e.kind)).toEqual(['raise']);

    jest.advanceTimersByTime(MINUTE);
    expect(troubleEvents(sent).map((e) => e.kind)).toEqual(['raise', 'clear']);
    alerts.stop();
  });
});

describe('backup_price', () => {
  it('raises once while on the backup source and clears when the primary is back', () => {
    const { alerts, sent } = makeAlerts();
    alerts.raise('backup_price', {});
    alerts.raise('backup_price', {});
    alerts.clear('backup_price', {});
    alerts.clear('backup_price', {});
    expect(sent().map((e) => `${e.kind}:${e.key}`)).toEqual(['raise:backup_price', 'clear:backup_price']);
  });
});

describe('trouble signal wiring (source)', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  /**
   * Returns the source lines from the line matching `marker` up to the next blank line
   * @param {string} source
   * @param {string} marker
   * @return {Array<string>}
   */
  const blocksAfter = (source, marker) => {
    const lines = source.split('\n');
    const blocks = [];
    lines.forEach((line, i) => {
      if (line.includes(marker)) {
        const block = [];
        for (let j = i; j < lines.length && lines[j].trim() !== ''; j++) block.push(lines[j]);
        blocks.push(block.join('\n'));
      }
    });
    return blocks;
  };

  it('"Probably it doesn\'t exist anymore" (the normal fully-filled path) does not report trouble', () => {
    const blocks = blocksAfter(read('trade/orderCollector.js'), 'Probably it doesn\'t exist anymore');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).not.toContain('botAlerts');
    }
  });

  it('"Unable to receive … open orders" reports open_orders_failed', () => {
    const source = read('trade/orderCollector.js');
    const at = source.indexOf('open orders${onWhichAccount} from exchange to close Unknown orders');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 400)).toContain('reportExchangeTrouble(\'open_orders_failed\')');
    expect(source.match(/reportExchangeTrouble/g)).toHaveLength(1);
  });

  it('the false-empty order list reports false_empty', () => {
    const source = read('trade/orderUtils.js');
    const at = source.indexOf('API returned false empty order list');
    expect(source.slice(at, at + 800)).toContain('reportExchangeTrouble(\'false_empty\')');
  });

  it('Coinstore counts HTTP 429 only', () => {
    const source = read('trade/api/coinstore_api.js');
    expect(source).toMatch(/if \(httpCode === 429\) \{\s*try \{\s*require\('\.\.\/\.\.\/helpers\/botAlerts'\)\.record429\(\)/);
  });
});
