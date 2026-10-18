import json, sqlite3

DB = '/home/upp_kishore/fabric/safety-simulation/offchain.db'
INCIDENT_ID = 'TTN-4047B74A'

conn = sqlite3.connect(DB)
cur = conn.cursor()

# Read current payload
cur.execute("SELECT raw_payload FROM raw_events WHERE incident_id = ?", (INCIDENT_ID,))
payload = json.loads(cur.fetchone()[0])

# Show before
print('BEFORE:')
print('  digital_in_3 (wakeReason):', payload['uplink_message']['decoded_payload']['digital_in_3'])
print('  latitude:', payload['uplink_message']['locations']['frm-payload']['latitude'])

# ── TAMPER: change SOS (4) to heartbeat (0) ──
payload['uplink_message']['decoded_payload']['digital_in_3'] = 0

print()
print('AFTER (tampered):')
print('  digital_in_3 (wakeReason):', payload['uplink_message']['decoded_payload']['digital_in_3'])

# Write back
cur.execute("UPDATE raw_events SET raw_payload = ? WHERE incident_id = ?",
            (json.dumps(payload), INCIDENT_ID))
conn.commit()
conn.close()
print()
print('Done — watchAndVerify.js will now flag this as TAMPER DETECTED')

