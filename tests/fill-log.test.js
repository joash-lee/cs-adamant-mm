/* global describe, it, expect, jest, beforeEach, afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  computeVsFairPct,
  fillFileName,
  createFillLog,
  readFillsSince,
} = require('../helpers/fillLog');

const log = { log: jest.fn(), warn: jest.fn() };

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-log-'));
  log.warn.mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Records synchronously so the file can be read back right away */
const syncAppend = (file, data, cb) => {
  fs.appendFileSync(file, data);
  cb(null);
};

describe('vsFairPct', () => {
  it('is positive when the bot sells above fair and negative below', () => {
    expect(computeVsFairPct('sell', 101, 100)).toBeCloseTo(1);
    expect(computeVsFairPct('sell', 99, 100)).toBeCloseTo(-1);
  });

  it('is positive when the bot buys below fair and negative above', () => {
    expect(computeVsFairPct('buy', 99, 100)).toBeCloseTo(1);
    expect(computeVsFairPct('buy', 102, 100)).toBeCloseTo(-2);
  });

  it('is null when fair is unknown', () => {
    expect(computeVsFairPct('buy', 100, null)).toBeNull();
    expect(computeVsFairPct('sell', 100, 0)).toBeNull();
    expect(computeVsFairPct('sell', 100, NaN)).toBeNull();
  });
});

describe('file name', () => {
  it('rolls per UTC day', () => {
    expect(fillFileName(Date.parse('2026-09-21T23:59:59.999Z'))).toBe('fills-2026-09-21.jsonl');
    expect(fillFileName(Date.parse('2026-09-22T00:00:00.000Z'))).toBe('fills-2026-09-22.jsonl');
    // 07:30 in Singapore on the 22nd is still the 21st in UTC
    expect(fillFileName(Date.parse('2026-09-22T07:30:00+08:00'))).toBe('fills-2026-09-21.jsonl');
  });
});

describe('record', () => {
  it('writes one JSON line per fill with fair and vsFairPct', () => {
    const fillLog = createFillLog({ dir, enabled: true, getFairMid: () => 200, log, appendFile: syncAppend });
    const ts = Date.parse('2026-09-21T10:00:00Z');

    fillLog.record({ ts, source: 'liq', side: 'buy', price: 198, amount: 2, quote: 396 });
    fillLog.record({ ts: ts + 1, source: 'mm-taker', side: 'sell', price: 202, amount: 1 });

    const lines = fs.readFileSync(path.join(dir, 'fills-2026-09-21.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ ts, source: 'liq', side: 'buy', price: 198, amount: 2, quote: 396, fair: 200, vsFairPct: 1 });
    expect(lines[1]).toMatchObject({ source: 'mm-taker', side: 'sell', quote: 202, fair: 200, vsFairPct: 1 });
  });

  it('writes fair: null when the fair price is unknown, and never crashes', () => {
    const fillLog = createFillLog({
      dir,
      enabled: true,
      getFairMid: () => {
        throw new Error('PW not ready');
      },
      log,
      appendFile: syncAppend,
    });

    const line = fillLog.record({ ts: Date.parse('2026-09-21T10:00:00Z'), source: 'liq', side: 'sell', price: 1, amount: 1 });
    expect(line).toMatchObject({ fair: null, vsFairPct: null });
  });

  it('splits fills around midnight UTC into two files', () => {
    const fillLog = createFillLog({ dir, enabled: true, getFairMid: () => 1, log, appendFile: syncAppend });
    fillLog.record({ ts: Date.parse('2026-09-21T23:59:00Z'), source: 'liq', side: 'buy', price: 1, amount: 1 });
    fillLog.record({ ts: Date.parse('2026-09-22T00:01:00Z'), source: 'liq', side: 'buy', price: 1, amount: 1 });
    expect(fs.readdirSync(dir).sort()).toEqual(['fills-2026-09-21.jsonl', 'fills-2026-09-22.jsonl']);
  });

  it('tags self-trades mm-self as given', () => {
    const fillLog = createFillLog({ dir, enabled: true, getFairMid: () => 100, log, appendFile: syncAppend });
    const line = fillLog.record({ ts: Date.parse('2026-09-21T10:00:00Z'), source: 'mm-self', side: 'buy', price: 100, amount: 1 });
    expect(line.source).toBe('mm-self');
  });

  it('tells alerts about every trade, even with the file disabled, but writes nothing', () => {
    const onTrade = jest.fn();
    const fillLog = createFillLog({ dir, enabled: false, getFairMid: () => 100, log, onTrade, appendFile: syncAppend });
    fillLog.record({ ts: 42, source: 'liq', side: 'buy', price: 100, amount: 1 });
    expect(onTrade).toHaveBeenCalledWith(42);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('ignores zero-amount fills', () => {
    const onTrade = jest.fn();
    const fillLog = createFillLog({ dir, enabled: true, getFairMid: () => 100, log, onTrade, appendFile: syncAppend });
    expect(fillLog.record({ source: 'liq', side: 'buy', price: 100, amount: 0 })).toBeUndefined();
    expect(onTrade).not.toHaveBeenCalled();
  });

  it('logs a write error instead of throwing', () => {
    const fillLog = createFillLog({
      dir, enabled: true, getFairMid: () => 100, log,
      appendFile: (file, data, cb) => cb(new Error('EACCES')),
    });
    expect(() => fillLog.record({ source: 'liq', side: 'buy', price: 100, amount: 1 })).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});

describe('readFillsSince', () => {
  it('reads the last 24 h across yesterday and today, skipping broken lines', () => {
    const now = Date.parse('2026-09-22T01:00:00Z');
    fs.writeFileSync(path.join(dir, 'fills-2026-09-20.jsonl'), JSON.stringify({ ts: Date.parse('2026-09-20T12:00:00Z') }) + '\n');
    fs.writeFileSync(path.join(dir, 'fills-2026-09-21.jsonl'), [
      JSON.stringify({ ts: Date.parse('2026-09-21T00:30:00Z') }), // older than 24 h
      JSON.stringify({ ts: Date.parse('2026-09-21T02:00:00Z') }),
      '{broken',
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'fills-2026-09-22.jsonl'), JSON.stringify({ ts: Date.parse('2026-09-22T00:30:00Z') }) + '\n');

    const fills = readFillsSince(dir, now - 24 * 60 * 60 * 1000, now);
    expect(fills.map((f) => new Date(f.ts).toISOString())).toEqual([
      '2026-09-21T02:00:00.000Z',
      '2026-09-22T00:30:00.000Z',
    ]);
  });
});
