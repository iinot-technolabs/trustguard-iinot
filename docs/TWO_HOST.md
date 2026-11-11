# Two hosts: each organisation on its own server (TG-031)

In the MVP every organisation's peer, CA and keys run on one server, so whoever runs that server holds
everyone's keys (doc 05, F22). For a pilot each organisation must run its own node. This guide splits a
network over two servers: **host 1** runs the orderer and the employer, **host 2** runs the regulator.
The regulator's private keys are created on host 2 and never leave it. Only public material moves
between the hosts: CA and TLS CA certificates, the channel's first block and the chaincode package.

The chaincode, the endorsement policy (employer AND regulator), the dashboard and the services stay the
same. Without `config/host.json` everything runs on one server, as before.

## What you need

- Two Ubuntu 22.04/24.04 servers that can reach each other, with the same time (NTP on both).
- On each: Docker with Compose v2, `jq`, `openssl`, and the Fabric binaries in `bin/` (`install.sh` does this).
  On a server that already runs a TrustGuard network, use a **second checkout** with its own names and
  ports (for example `examples/two-host-proof.network-config.json`) and do **not** run `install.sh` in it:
  link the binaries and the simulation modules from the first checkout instead (step 1).
- Firewall: the orderer and peer ports are published on `publishAddress` so the other host can reach
  them. Docker-published ports bypass `ufw`; allow them only from the other host (provider security
  group, or the `DOCKER-USER` rules in step 2).

## Ports (two-host proof example)

| Host | Port | Open to |
|---|---|---|
| host 1 | 27050 orderer, 27051 employer peer | host 2 only |
| host 2 | 28051 regulator peer | host 1 only |

CA, orderer admin and operations ports stay on 127.0.0.1.

## Steps

1. **Both hosts: the same network config, and each host's `host.json`.**
   ```bash
   git clone https://github.com/iinot-technolabs/trustguard-iinot.git /root/tg-proof && cd /root/tg-proof
   # on a server that already has /root/trustguard-iinot installed:
   ln -s /root/trustguard-iinot/bin bin
   ln -s /root/trustguard-iinot/safety-simulation/node_modules safety-simulation/node_modules
   # on a fresh server instead:  bash install.sh
   mkdir -p iinot-network/config
   cp examples/two-host-proof.network-config.json iinot-network/config/network-config.json
   ```
   Host 1, `iinot-network/config/host.json` (HOST2_IP = host 2's address):
   ```json
   { "thisHost":   { "orgs": ["TwoHostEmployerMSP"], "orderer": true, "publishAddress": "0.0.0.0" },
     "otherHosts": [ { "address": "HOST2_IP", "orgs": ["TwoHostRegulatorMSP"], "orderer": false } ] }
   ```
   Host 2:
   ```json
   { "thisHost":   { "orgs": ["TwoHostRegulatorMSP"], "orderer": false, "publishAddress": "0.0.0.0" },
     "otherHosts": [ { "address": "HOST1_IP", "orgs": ["TwoHostEmployerMSP"], "orderer": true } ] }
   ```

2. **Firewall** (if the provider has no security groups). `IF` = the public interface (`ip route get 1.1.1.1`).
   ```bash
   # host 1
   iptables -I DOCKER-USER -i "$IF" -p tcp -m multiport --dports 27050,27051 ! -s HOST2_IP -j DROP
   # host 2
   iptables -I DOCKER-USER -i "$IF" -p tcp --dport 28051 ! -s HOST1_IP -j DROP
   ```

3. **Both hosts: start this host's part.** `cd iinot-network && ./scripts/network.sh up`
   (CAs, identities and nodes of this host only; writes the other host's node names into `/etc/hosts`).

4. **Exchange public bundles.**
   ```bash
   ./scripts/network.sh export-org            # prints the files and a sha256; no private keys (checked)
   # copy exports/public-*.tgz to the other host, then there:
   ./scripts/network.sh import-org /root/public-TwoHostRegulatorMSP.tgz      # on host 1
   ./scripts/network.sh import-org /root/public-TwoHostEmployerMSP_TwoHostOrdererMSP.tgz   # on host 2
   ```
   Import refuses a bundle with any private key, or one that would replace this host's own organisation.

5. **Channel.** Host 1: `./scripts/network.sh channel`. Copy `channel-artifacts/tg-twohost-channel.block`
   to host 2's `iinot-network/channel-artifacts/`, then host 2: `./scripts/network.sh channel`.

6. **Chaincode.** Host 1: `./scripts/network.sh deploy` (installs and approves for the employer, then waits
   for the regulator; exit code 3). Copy `channel-artifacts/safetycc_1.4.tar.gz` to host 2's
   `channel-artifacts/`. Host 2: `./scripts/network.sh deploy` (approves for the regulator).
   Host 1: `./scripts/network.sh deploy` (commits with both endorsements). Host 2:
   `./scripts/network.sh deploy` once more (starts the chaincode on its peer).

7. **Rules and identities.** Host 1: `./scripts/network.sh rules`, then `./scripts/network.sh identities`
   (gateway1, supervisor1). Host 2: `./scripts/network.sh identities` (auditor1).

8. **Evidence.**
   ```bash
   ./scripts/two-host-evidence.sh            # both hosts: keys by organisation, CA fingerprints, block height and hash
   ./scripts/two-host-evidence.sh --sos      # host 1: one test SOS, endorsed by the employer AND the regulator
   docker stop peer0.regulator.twohost.trustguard.in          # host 2
   ./scripts/two-host-evidence.sh --refused  # host 1: a test SOS is refused without the regulator
   docker start peer0.regulator.twohost.trustguard.in         # host 2; it catches up from the orderer
   ./scripts/two-host-evidence.sh            # both hosts: the same height and latest block hash again
   ```

## Proven on two cloud VMs (11 Nov 2026)

Test VM (orderer + employer) and a second VM (regulator), CloudPe, Ubuntu 22.04: 0 regulator key files and
0 regulator identities on the employer's VM (whole-disk search: none); the same CA fingerprints on both;
a test SOS endorsed by both organisations' peers; refused while the regulator's peer was stopped; after the
restart both peers at the same height and latest block hash.

## Notes

- `network.sh all` refuses to run when `config/host.json` exists: the steps above need both hosts.
- Users of an organisation are enrolled on that organisation's host. A dashboard on host 1 can sign in as
  the employer's users; the regulator's auditor works against host 2's own peer.
- `network.sh down` on each host removes only that host's part.
- This places one ordering node. The pilot topology (doc 12 §9) adds three or more ordering nodes across
  organisations; that needs generator support for a Raft cluster (pilot preparation).
