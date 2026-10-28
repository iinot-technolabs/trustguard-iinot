'use strict';
// Notifications (TG-016). Always logs; also sends Telegram messages when configured in
// escalation/.env (git-ignored):
//   TELEGRAM_BOT_TOKEN=123456:ABC...
//   TELEGRAM_CHAT_SUPERVISORS=11111111,22222222     (comma-separated chat ids per group)
//   TELEGRAM_CHAT_SAFETYOFFICER=33333333
//   TELEGRAM_CHAT_REGULATOR=44444444
const GROUP_ENV = { supervisors: 'TELEGRAM_CHAT_SUPERVISORS', safetyOfficer: 'TELEGRAM_CHAT_SAFETYOFFICER', regulator: 'TELEGRAM_CHAT_REGULATOR' };

function chatIds(groups) {
  const ids = new Set();
  for (const g of groups) for (const id of (process.env[GROUP_ENV[g]] || '').split(',').map(s => s.trim()).filter(Boolean)) ids.add(id);
  return [...ids];
}

async function send(groups, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = token ? chatIds(groups) : [];
  if (!ids.length) return { channel: 'log', sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const chat_id of ids) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) sent++; else { failed++; console.error(`   telegram ${chat_id}: HTTP ${r.status}`); }
    } catch (e) { failed++; console.error(`   telegram ${chat_id}: ${e.message}`); }
  }
  return { channel: 'telegram', sent, failed };
}

module.exports = { send, chatIds };
