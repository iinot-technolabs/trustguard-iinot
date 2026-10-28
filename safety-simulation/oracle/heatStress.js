'use strict';
// Heat-stress helpers (TG-014). Shared by the oracle service and the risk scoring.
// Heat index: NOAA/NWS Rothfusz regression with Steadman fallback and NWS adjustments
// (https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml). Bands follow the NWS chart.

const cToF = c => c * 9 / 5 + 32;
const fToC = f => (f - 32) * 5 / 9;

function heatIndexC(tempC, rhPct) {
  if (!Number.isFinite(tempC) || !Number.isFinite(rhPct)) return null;
  const T = cToF(tempC), RH = Math.min(Math.max(rhPct, 0), 100);
  let hi = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);           // Steadman simple form
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH
       - 0.00683783 * T * T - 0.05481717 * RH * RH + 0.00122874 * T * T * RH
       + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;
    if (RH < 13 && T >= 80 && T <= 112) hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    if (RH > 85 && T >= 80 && T <= 87)  hi += ((RH - 85) / 10) * ((87 - T) / 5);
  }
  return Math.round(fToC(hi) * 10) / 10;
}

// NWS heat-index bands (°F thresholds 80 / 90 / 103 / 125)
function heatBand(hiC) {
  if (hiC == null) return 'UNKNOWN';
  const f = cToF(hiC);
  if (f >= 125) return 'EXTREME_DANGER';
  if (f >= 103) return 'DANGER';
  if (f >= 90)  return 'EXTREME_CAUTION';
  if (f >= 80)  return 'CAUTION';
  return 'NORMAL';
}

module.exports = { heatIndexC, heatBand, cToF, fToC };
