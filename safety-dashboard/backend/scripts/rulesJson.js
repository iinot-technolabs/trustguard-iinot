'use strict';
// rulesJson.js <network-config.json> — print the SetRules payload for the saved rules
// (defaults if none are saved). Used by: iinot-network/scripts/network.sh rules   (TG-028)
const fs = require('fs');
const { buildModel, ConfigError } = require('../lib/networkModel');
const { savedOrDefault, normalizeRules } = require('../lib/rulesModel');
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const model = buildModel(cfg, {});
  const { rules, saved } = savedOrDefault(cfg, { migrate: false });
  const { ledger, warnings } = normalizeRules(rules, model);
  for (const w of warnings) process.stderr.write(`[WARN] ${w}\n`);
  process.stderr.write(`[INFO] Rules: ${saved ? 'saved in the Rules Designer' : 'defaults (none saved yet)'} · ${ledger.eventTypes.length} event types · ` +
    `${Object.keys(ledger.access).length} restricted groups · escalation ${ledger.escalation ? ledger.escalation.levels.map(l => l.afterMinutes + ' min').join(' / ') : 'built-in'} · ` +
    `reports ${ledger.reportTypes ? ledger.reportTypes.map(r => `${r.code} ${r.deadlineHours} h`).join(', ') : 'built-in'} · admins ${ledger.adminMsps.join(', ')}\n`);
  process.stdout.write(JSON.stringify(ledger));
} catch (e) {
  process.stderr.write(`[ERROR] ${e instanceof ConfigError ? e.problems.join('; ') : e.message}\n`);
  process.exit(1);
}
