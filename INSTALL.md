# Installing TrustGuard IIoT

From a fresh Ubuntu 22.04 or 24.04 server to a running, designer-built Fabric network in about 20 minutes.
Everything that names the network (organisations, domains, ports, channel, identities) is set in the dashboard's
**Network Designer**. See [docs/NETWORK_CONFIG.md](docs/NETWORK_CONFIG.md).

## 1. Server

- 2 vCPU, 4 GB RAM, 40 GB disk; outbound internet (Docker Hub, GitHub, npm, Open-Meteo for the oracle).
- SSH with a key. Before going live, disable password login and add fail2ban (see *Hardening* below).

## 2. Install

```
git clone https://github.com/iinot-technolabs/trustguard-iinot.git /root/trustguard-iinot
cd /root/trustguard-iinot
bash install.sh --firewall          # firewall: only SSH (22) and the dashboard (80) stay open
```

The installer is safe to re-run after a `git pull`. It installs Docker, Node.js 20, jq and nginx, plus the Fabric
2.5.15 / CA 1.5.17 binaries in `./bin`. It writes `.env` with a random `AUTH_SECRET`, builds the dashboard and
starts `trustguard-backend` on 127.0.0.1:3001 behind nginx on port 80. Finally it asks for the first **admin** password.

Add `--public-ports "22 80 3003"` if ChirpStack's Basics Station bridge runs on the same server.

## 3. Design and deploy the network

1. Open `http://<server>/` and log in as the admin.
2. **Network Designer** sets the network name, channel and domain, and for each organisation its type
   (employer / regulator / insurer), whether it is in the network (the insurer toggle) and whether it must endorse
   every write. It also lists the identities and their roles (gateway, supervisor, auditor, oracle,
   claims-reviewer). Press **Validate & Save**: the server checks every rule and shows the endorsement policy it
   will use.
3. **Deploy**: CAs, orderer and peers start, the channel is created, the chaincode is committed with that policy,
   and the identities are enrolled into `wallet/`. The first deploy takes a few minutes while the chaincode image builds.

Shell equivalent: `cd iinot-network && cp ../examples/iinot-demo.network-config.json config/network-config.json && ./scripts/network.sh all`.

## 4. People, sites and services

```
cd /root/trustguard-iinot/safety-dashboard/backend
node scripts/manageUsers.js add asha supervisor        # also: auditor, claims-reviewer, admin
node scripts/manageUsers.js list
```

Per-client settings live in `config/client/` (created from the examples, never overwritten, not in git):

| File | What to set |
| --- | --- |
| `gateway.env` | `CHIRPSTACK_APP_ID` (ChirpStack → Applications → ID), broker host and credentials |
| `sites.json` | sites, coordinates, and which beacons are at each site (oracle + risk scoring) |
| `policy.json` | escalation timings, `dashboardUrl` |
| `escalation.env` | optional Telegram bot token and chat ids |
| `model-v1.json` | risk weights |

Then start the gateway, oracle and escalation services:

```
bash install.sh --enable-services
```

## 5. Check it

```
cd /root/trustguard-iinot/safety-simulation && node simulateEvent.js     # end-to-end smoke test, every role
cd /root/trustguard-iinot/iinot-network && ./scripts/network.sh status   # peers, channel, committed chaincode + policy
systemctl status trustguard-backend trustguard-gateway trustguard-oracle trustguard-escalation
```

## Operations

| Task | Command |
| --- | --- |
| Update the software | `git pull && bash install.sh` |
| Re-enrol identities | Admin page → *Enroll identities*, or `./scripts/network.sh identities` |
| Delete the network | `cd iinot-network && ./scripts/network.sh down` (ledgers and crypto are deleted; asks first) |
| Rotate CA and identity secrets | `down`, then delete `iinot-network/config/secrets/`, then deploy again |
| Logs | `journalctl -fu trustguard-backend` (also `-gateway`, `-oracle`, `-escalation`) |

This package performs **fresh installs**. Chaincode upgrades and adding an organisation to a running channel are
separate, rehearsed procedures, not part of the installer.

## Hardening before go-live

- **SSH:** key-only login and fail2ban (`PasswordAuthentication no`, `PermitRootLogin prohibit-password`); make sure your key works first.
- **HTTPS:** put a domain on the server and add a certificate (for example certbot for nginx), then open 443.
- **MQTT:** if ChirpStack runs here, keep Mosquitto's 1883 on 127.0.0.1; anyone who can publish there can fake an SOS.
- **Cloud VMs with Docker:** if networking stops after an unclean reboot, see change register TG-019 (networkd safety net).
- **Weather data:** Open-Meteo's free API is for non-commercial use; a paid deployment needs a subscription or another source.
