/* global describe, it, expect */

const fs = require('fs');
const path = require('path');

const { buildSamples } = require('../scripts/alert-smoke');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

/** Every alert key raised anywhere in the bot */
const raisedKeys = () => {
  const keys = new Set();
  for (const file of ['helpers/botAlerts.js', 'trade/mm_price_watcher.js']) {
    for (const match of read(file).matchAll(/raise\('([a-z_]+)'/g)) keys.add(match[1]);
  }
  return [...keys];
};

describe('alert-smoke samples', () => {
  const samples = buildSamples(0);
  const has = (kind, key) => samples.some((s) => s.kind === kind && s.key === key);

  it('covers raise and clear for every key the bot can raise', () => {
    const keys = raisedKeys();
    expect(keys).toEqual(expect.arrayContaining([
      'wallet_warn', 'wallet_serious', 'wallet_fast', 'side_empty',
      'no_orders', 'no_trades', 'paused', 'backup_price', 'exchange_trouble',
    ]));
    for (const key of keys) {
      expect([key, has('raise', key)]).toEqual([key, true]);
      expect([key, has('clear', key)]).toEqual([key, true]);
    }
  });

  it('covers heartbeat, a reminder, both daily wording variants and an unknown key', () => {
    expect(has('heartbeat', 'heartbeat')).toBe(true);
    expect(samples.some((s) => s.kind === 'reminder')).toBe(true);
    const dailies = samples.filter((s) => s.kind === 'daily');
    expect(dailies.map((s) => s.data.badFills)).toEqual(expect.arrayContaining([true, false]));
    expect(dailies.some((s) => s.data.paused)).toBe(true);
    expect(samples.some((s) => s.key === 'smoke_unknown_key')).toBe(true);
  });

  it('covers both wallet directions', () => {
    for (const key of ['wallet_warn', 'wallet_serious']) {
      const sides = samples.filter((s) => s.kind === 'raise' && s.key === key).map((s) => s.data.lowSide);
      expect(sides.sort()).toEqual(['base', 'quote']);
    }
  });

  it('has data made of numbers, booleans, nulls, enums and count maps only', () => {
    for (const { data } of samples) {
      for (const value of Object.values(data)) {
        expect(['number', 'boolean', 'string', 'object']).toContain(typeof value);
        if (typeof value === 'string') expect(value).toMatch(/^[a-z_]+$/); // enum values, not prose
      }
    }
  });
});
