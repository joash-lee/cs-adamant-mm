/* global describe, it, expect */

/**
 * Guards scripts/fill-forensics.js against log-format drift: the fixture holds real bot log line shapes
 * (vanished FILLED / duplicate / NOT_FOUND, mm taker filled / part_filled + remainder / assumed filled).
 * If a log message in the bot changes wording, this test fails instead of the forensics silently miscounting.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'fill-forensics.js');
const fixture = path.join(__dirname, 'fixtures', 'forensics-sample.log');

function run(args) {
  return execFileSync(process.execPath, [script, ...args, fixture], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('fill-forensics', () => {
  const out = run(['--start-usdt', '1000', '--start-coin', '10', '--end-usdt', '1000', '--end-coin', '10']);

  it('classifies every fill signal', () => {
    expect(out).toMatch(/1 {2}vanished liq: FILLED/);
    expect(out).toMatch(/1 {2}vanished: duplicate line, skipped/);
    expect(out).toMatch(/1 {2}vanished, not a fill: NOT_FOUND/);
    expect(out).toMatch(/1 {2}mm-book status: part_filled/);
    expect(out).toMatch(/1 {2}vanished mm-book remainder: FILLED/);
    expect(out).toMatch(/1 {2}mm-book status: filled/);
    expect(out).toMatch(/UNCONFIRMED mm-book: 1 fills, bought 3.00/);
  });

  it('counts only confirmed fills: net zero coin, +1 USDT', () => {
    expect(out).toMatch(/Net from fills: 0.00 JITOSOL, \+1 USDT/);
  });

  it('reconciles on value and coins', () => {
    expect(out).toMatch(/Value and coin balances reconcile/);
  });
});
