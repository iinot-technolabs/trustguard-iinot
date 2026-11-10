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
| `version` | `"1.4"` | Package label is `<name>_<version>`. 1.4 or later is needed for the Rules Designer rules |
| `sequence` | `1` | Fresh installs use 1 |
| `path`, `lang` | `"safety-chaincode"`, `"node"` | Path relative to the install folder |

The **endorsement policy is not typed in**. It is built from the organisations marked `endorses: true`, as
`AND('<msp>.peer', …)`, and passed to approve and commit, and `network.sh` checks the committed definition against
it. This keeps the regulator's signature mandatory even when an insurer joins. With three organisations, Fabric's
default MAJORITY would let employer + insurer write without the regulator. An old free-text
`endorsementPolicy` value is ignored with a warning.

### `rules` (written by the Rules Designer)

Optional. Saved by the Rules Designer (`PUT /api/rules`); the Network Designer keeps it when it saves the network.
`network.sh rules` (and `network.sh all`, right after the chaincode is committed) stores it on the channel with
chaincode 1.4 `SetRules`; with no `rules` block the defaults below (today's behaviour) are stored. A part left out
of a saved `rules` block keeps the built-in behaviour.

```json
"rules": {
  "eventTypes": [ { "name": "SOS", "riskScore": 8, "statutory": "Factories Act 1948 s.88 (notice of accident)" },
                  { "name": "FALL", "riskScore": 7, "statutory": "Factories Act 1948 s.88 (notice of accident)" },
                  { "name": "INACTIVITY", "riskScore": 5, "statutory": "" } ],
  "access": { "listAllIncidents": ["supervisor"] },
  "escalation": { "levels": [ { "level": 1, "afterMinutes": 5 }, { "level": 2, "afterMinutes": 15 },
                              { "level": 3, "afterMinutes": 240, "minRisk": 90 } ] },
  "targets": { "ackMinutes": 5, "resolveHours": 24 },
  "reportTypes": [ { "code": "FORM18", "name": "Form 18: notice of accident (Factories Act 1948 s.88)", "deadlineHours": 12 } ]
}
```

| Part | What the chaincode does with it |
| --- | --- |
| `eventTypes[]` | Every new incident with that event type gets `classification` = severity (score ≥ 9 critical, ≥ 7 high, ≥ 4 medium, else low), the statutory reference and the rules version. Its risk score is raised to the floor `riskScore × 10` if the gateway sent less (the original is kept in `classification.reportedRiskScore`). An event type not listed is still recorded, marked `UNCLASSIFIED`: a rule never drops a safety alarm. Default floors (80/70/50) are at or below the risk model's base scores, so the defaults do not change today's risk scores |
| `escalation.levels[]` | Automatic escalation (1–5 levels, minutes from the alert, optional minimum risk). The escalation service reads them from the ledger (every 5 minutes) and the chaincode refuses an automatic escalation (gateway identity) before its level's time or past the last level; a supervisor can still escalate by hand. Who is notified at each level stays in the escalation service's `policy.json` (matched by level number), because phone numbers are personal data |
| `targets` | Response targets of the compliance score: acknowledged within `ackMinutes`, resolved with an outcome within `resolveHours`. "Never escalated past L1" is due after level 2's time. `GetComplianceScore` returns the targets and rules version it used |
| `reportTypes[]` | Statutory reports that can be filed (code, name, deadline in hours). `FORM18` is filled in the dashboard; any other type (a state's own accident form) is filed by attaching the completed form (PDF/PNG/JPG, ≤ 8 MB): the file stays in `safety-dashboard/backend/data/report-files/`, the ledger records its SHA-256 and filing time, and each report is checked against its own deadline |
| `access.<group>` | Roles allowed for that group of functions. A rule can only narrow the built-in roles; groups left out keep them. Groups: `logIncident`, `acknowledge`, `resolve`, `escalate`, `oracleData`, `workerAssignments`, `statutoryReporting`, `listAllIncidents`, `incidentHistory`, `claimsQueries`, `complianceScore` (list and built-in roles: `safety-chaincode/lib/ruleGroups.js`) |

Who can change the rules: an organisation admin (certificate OU `admin`) of an endorsing organisation. The change is
endorsed like any write (every endorsing peer runs the same checks), versioned, and kept in the ledger history
(`GetRulesHistory`, shown in the Rules Designer). The first `SetRules` names the admin organisations (the endorsing
ones); deploy sets it right after the chaincode commit.

## Commands

```
cd iinot-network
./scripts/network.sh generate     # validate + generate only
./scripts/network.sh all          # fresh install: generate, CAs + identities, orderer + peers, channel, chaincode, rules, wallet
./scripts/network.sh rules        # store the saved Rules Designer rules on the channel (chaincode 1.4)
./scripts/network.sh status       # channel membership and committed chaincode (version, sequence, approvals, policy check)
./scripts/network.sh identities   # re-enrol the app users into <install>/wallet
./scripts/network.sh down         # delete this network (asks first; -y to skip)
```

`channel`, `deploy` and `identities` can be re-run after a failure; they skip steps that are already done.
`all` and `up` refuse to run over an existing network.
