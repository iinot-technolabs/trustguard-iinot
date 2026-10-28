# Network configuration (`network-config.json`)

A TrustGuard network is described by one file, written by the dashboard's **Network Designer**. It is saved at
`iinot-network/config/network-config.json`. Nothing else names an organisation, domain, port, channel or
chaincode: the deploy scripts read every value from this file. A new state, department or industry is a new
configuration, not new code.

Worked examples:

| File | What it shows |
| --- | --- |
| `examples/iinot-demo.network-config.json` | The IINoT reference deployment: employer, regulator and insurer, AND(employer, regulator) |
| `examples/tg-mining.network-config.json` | A mining network with no IINoT names: operator, DGMS, Labour Department (non-endorsing), insurer switched off |

## What the deploy builds from it

`network.sh generate` (run automatically by **Deploy**) validates the file and writes:

| Output | Used by |
| --- | --- |
| `iinot-network/docker/docker-compose.yaml` | CAs, orderer and peers (ports published on `network.bindAddress`) |
| `iinot-network/configtx.yaml` | the channel genesis block (orgs, BatchTimeout, batch size) |
| `iinot-network/config/network.derived.json` | `network.sh`, `registerEnroll.sh` (every derived name and port) |
| `iinot-network/config/app.env` | backend, gateway, oracle, escalation: channel, chaincode, MSP IDs, peer endpoints, TLS paths |
| `iinot-network/config/secrets/` (0600) | random CA, admin and user enrolment secrets; created once and kept until deleted |

None of these is committed to git.

## Fields

### `network`

| Field | Example | Notes |
| --- | --- | --- |
| `name` | `"IINoT Lone Worker Safety Network"` | Display name |
| `channel` | `"iinot-safety-channel"` | Lowercase letters, digits, `.` and `-`; starts with a letter |
| `genesisProfile` | `"IINoTSafetyGenesis"` | Letters and digits |
| `dockerNetworkName` | `"iinot_network"` | Docker network for peers and chaincode containers |
| `bindAddress` | `"127.0.0.1"` | Where Fabric ports are published. Keep `127.0.0.1` on a single host; `0.0.0.0` only with a firewall |
| `fabricVersion`, `fabricCAVersion` | `"2.5.15"`, `"1.5.17"` | Image tags |

### `orderer`

`mspId`, `domain`, `port`, `adminPort`, `operationsPort`, `caPort`, `caName`, `caFolderName`, and the batch settings
`batchTimeout` (default `"500ms"`, allowed 50 ms – 10 s), `maxMessageCount`, `absoluteMaxBytes`, `preferredMaxBytes`.
The orderer host is `orderer.<domain>`, or the domain itself if it already starts with `orderer.`.

### `organizations[]`

| Field | Example | Notes |
| --- | --- | --- |
| `id` | `"IINoTIndustryMSP"` | MSP ID; letters and digits; unique |
| `name` | `"Employer / Factory Owner"` | Display name |
| `type` | `"employer"` · `"regulator"` · `"insurer"` | At least one employer (the first hosts the gateway), any number of regulators, at most one insurer. Inferred from the name if missing |
| `enabled` | `true` | `false` leaves the org out of the network (the insurer toggle) |
| `endorses` | `true` | Must this org's peer endorse every write? Default: `true` except for the insurer |
| `domain` | `"iinot-industry.com"` | Peer host is `peer0.<domain>` |
| `peerPort`, `chaincodePort`, `operationsPort`, `caPort` | `7051`, `7052`, `17051`, `7054` | 1024–65535; every port in the file must be unique |
| `caName`, `caFolderName` | `"ca-iinot-industry"`, `"iinot-industry"` | CA name and its data folder |
| `roles[]` | `{ "name": "gateway1", "attrs": "role.gateway:ecert" }` | App identities. `attrs` may also be `role=gateway:ecert` or just `gateway`. Roles the chaincode checks: `gateway`, `supervisor`, `auditor`, `claims-reviewer`, `oracle`. Names are unique across the network |

### `chaincode`

| Field | Example | Notes |
| --- | --- | --- |
| `name` | `"safetycc"` | |
| `version` | `"1.3"` | Package label is `<name>_<version>` |
| `sequence` | `1` | Fresh installs use 1 |
| `path`, `lang` | `"safety-chaincode"`, `"node"` | Path relative to the install folder |

The **endorsement policy is not typed in**. It is built from the organisations marked `endorses: true`, as
`AND('<msp>.peer', …)`, and passed to approve and commit, and `network.sh` checks the committed definition against
it. This keeps the regulator's signature mandatory even when an insurer joins. With three organisations, Fabric's
default MAJORITY would let employer + insurer write without the regulator. An old free-text
`endorsementPolicy` value is ignored with a warning.

## Commands

```
cd iinot-network
./scripts/network.sh generate     # validate + generate only
./scripts/network.sh all          # fresh install: generate, CAs + identities, orderer + peers, channel, chaincode, wallet
./scripts/network.sh status       # channel membership and committed chaincode (version, sequence, approvals, policy check)
./scripts/network.sh identities   # re-enrol the app users into <install>/wallet
./scripts/network.sh down         # delete this network (asks first; -y to skip)
```

`channel`, `deploy` and `identities` can be re-run after a failure; they skip steps that are already done.
`all` and `up` refuse to run over an existing network.
