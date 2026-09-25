/**
 * Smoke test for CurrencyAPI.sliceSeries `partial` semantics (issue #23).
 * Run: node test/slice-series-partial.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(root, '../js/api.js'), 'utf8');
const sandbox = {
  console, Date, Math, JSON, Array, Object, Number, String, Boolean, Error,
  Map, Set, Promise, Infinity, NaN, isFinite, isNaN, parseInt, parseFloat,
  undefined, URL,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
// Browser classic scripts expose top-level class bindings on `window`; Node's
// vm does not, so re-export the binding onto the sandbox global.
vm.runInContext(`${code}\n;globalThis.CurrencyAPI = CurrencyAPI;`, sandbox, { filename: 'api.js' });

const CurrencyAPI = sandbox.CurrencyAPI;
assert.equal(typeof CurrencyAPI?.sliceSeries, 'function');

const timeframe = Object.keys(CurrencyAPI.TIMEFRAMES || CurrencyAPI.TIME_FRAMES || {}).find((k) => /y/i.test(k))
  || Object.keys(CurrencyAPI.TIMEFRAMES || {})[Object.keys(CurrencyAPI.TIMEFRAMES || {}).length - 1];
assert.ok(timeframe, 'expected a long timeframe key');

function seriesFrom(dates, values) {
  return { available: true, reason: null, dates, values };
}

{
  const dates = [];
  const values = [];
  const end = Date.UTC(2024, 11, 31);
  for (let i = 420; i >= 0; i--) {
    const t = end - i * 86400000;
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    dates.push(new Date(t).toISOString().slice(0, 10));
    values.push(1 + i * 0.0001);
  }
  const sliced = CurrencyAPI.sliceSeries(seriesFrom(dates, values), timeframe);
  assert.equal(sliced.partial, false, `full coverage must not be partial for ${timeframe}`);
}

{
  const short = seriesFrom(
    ['2024-11-01', '2024-11-04', '2024-11-05', '2024-12-31'],
    [1.1, 1.11, 1.12, 1.13],
  );
  const sliced = CurrencyAPI.sliceSeries(short, timeframe);
  assert.equal(sliced.partial, true, `short history must be partial for ${timeframe}`);
  assert.equal(sliced.dates[0], '2024-11-01');
}

console.log(`slice-series-partial: ok (timeframe=${timeframe})`);
