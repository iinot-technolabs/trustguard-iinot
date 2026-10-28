// node test/heatStress.test.js — checks against the NWS heat index chart
const assert = require('assert');
const { heatIndexC, heatBand, fToC } = require('../oracle/heatStress');
const cases = [ // [°F, RH%, chart °F]
  [80, 40, 80], [90, 50, 95], [90, 70, 106], [96, 60, 116], [100, 40, 109], [86, 90, 105], [104, 40, 119],
];
for (const [tf, rh, chartF] of cases) {
  const got = heatIndexC(fToC(tf), rh);
  assert(Math.abs(got - fToC(chartF)) <= 1.2, `${tf}°F ${rh}% → ${got}°C, chart ${fToC(chartF).toFixed(1)}°C`);
}
assert.strictEqual(heatBand(25), 'NORMAL'); assert.strictEqual(heatBand(30), 'CAUTION');
assert.strictEqual(heatBand(35), 'EXTREME_CAUTION'); assert.strictEqual(heatBand(45), 'DANGER');
assert.strictEqual(heatBand(55), 'EXTREME_DANGER'); assert.strictEqual(heatIndexC(NaN, 50), null);
console.log(`heatStress: ${cases.length} chart points + 6 band checks passed`);
