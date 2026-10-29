'use strict';
/**
 * enrollIdentities.js — kept for compatibility with older docs and scripts.
 *
 * App identities (gateway, supervisor, auditor, oracle, claims-reviewer) are defined in the
 * Network Designer, registered with random secrets during `network.sh up`, and enrolled into
 * the shared wallet (<TG_HOME>/wallet/<name>/) by `network.sh identities`. This wrapper just
 * runs that step, so it works for any network the designer produced.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const TG_HOME = path.resolve(process.env.TG_HOME || path.join(__dirname, '..'));
const script = path.join(TG_HOME, 'iinot-network', 'scripts', 'network.sh');

const r = spawnSync('bash', [script, 'identities'], { stdio: 'inherit', env: { ...process.env, TG_HOME } });
process.exit(r.status === null ? 1 : r.status);
