# Open-Source Component Inventory
## IINoT Lone Worker Safety — Blockchain India Challenge Submission

**Document purpose:** Satisfies the Blockchain India Challenge requirement that "all open-source components used must be clearly identified and documented in the submission, including version numbers and licenses."

---

## 1. Blockchain Infrastructure

| Component | Version | License | Role in solution |
|---|---|---|---|
| Hyperledger Fabric peer binary | v2.5.15 | Apache 2.0 | Peer node — maintains ledger copy, executes chaincode, endorses transactions |
| Hyperledger Fabric orderer binary | v2.5.15 | Apache 2.0 | Ordering service — sequences transactions into blocks using Raft consensus |
| Hyperledger Fabric CA binary | v1.5.17 | Apache 2.0 | Certificate authority — issues X.509 identities with role attributes |
| Hyperledger Fabric tools binary | v2.5.15 | Apache 2.0 | CLI tools — peer, configtxgen, osnadmin for network administration |
| hyperledger/fabric-peer (Docker) | 2.5.15 | Apache 2.0 | Peer container image |
| hyperledger/fabric-orderer (Docker) | 2.5.15 | Apache 2.0 | Orderer container image |
| hyperledger/fabric-ca (Docker) | latest | Apache 2.0 | Fabric CA container image |
| hyperledger/fabric-tools (Docker) | latest | Apache 2.0 | Admin CLI container image |
| hyperledger/fabric-nodeenv (Docker) | 2.5 | Apache 2.0 | Node.js chaincode build environment |

## 2. Smart Contract (safety-chaincode)

| Package | Version | License | Role in solution |
|---|---|---|---|
| fabric-contract-api | ^2.5.8 | Apache 2.0 | Contract base class, ctx.stub, ctx.clientIdentity APIs |
| fabric-shim | ^2.5.8 | Apache 2.0 | Chaincode runtime — peer-to-chaincode gRPC communication |

## 3. IoT Gateway Simulation and Tamper Detection (safety-simulation)

| Package | Version | License | Role in solution |
|---|---|---|---|
| @hyperledger/fabric-gateway | ^1.11.0 | Apache 2.0 | Fabric Gateway SDK — submits and evaluates transactions |
| @grpc/grpc-js | ^1.14.4 | Apache 2.0 | gRPC transport — TLS-encrypted peer connection |
| fabric-ca-client | ^2.2.20 | Apache 2.0 | Programmatic identity enrollment via Fabric CA |
| fabric-common | ^2.2.20 | Apache 2.0 | Shared utilities for fabric-ca-client |
| better-sqlite3 | ^12.11.1 | MIT | Off-chain SQLite storage + AFTER UPDATE trigger |
| uuid | ^14.0.0 | MIT | Unique incident ID generation |

## 4. Infrastructure and Runtime

| Component | Version | License | Role in solution |
|---|---|---|---|
| Docker Engine | 27.x | Apache 2.0 | Container runtime for all Fabric nodes |
| Docker Compose | v2.x | Apache 2.0 | Orchestrates all 7 containers |
| Node.js | v20 LTS | MIT | JavaScript runtime for chaincode and client apps |
| Ubuntu 22.04 LTS (WSL2) | 22.04 | GPL/Various | Linux environment for all Fabric tooling |
| Git | 2.34.x | GPL v2 | Version control for all source code |
| SQLite | 3.37.x | Public Domain | Embedded database for off-chain payload storage |

## 5. License compliance summary

| License | Components | Commercial use permitted |
|---|---|---|
| Apache 2.0 | All Hyperledger Fabric components, Gateway SDK, gRPC, Docker | Yes |
| MIT | better-sqlite3, uuid, Node.js | Yes |
| GPL v2 | Git (dev tool only, not a runtime dependency) | Yes |
| Public Domain | SQLite | Yes — no restrictions |

## 6. Original development vs open-source components

**Original development (startup's own work):**
- configtx.yaml — IINoT network topology, MSP IDs, endorsement policies
- docker/docker-compose.yaml — IINoT-specific container configuration
- scripts/network.sh — custom network orchestration script
- scripts/registerEnroll.sh — identity registration with role attributes
- safety-chaincode/lib/safetyContract.js — all business logic and role-based access control
- safety-simulation/simulateEvent.js — end-to-end IoT simulation
- safety-simulation/watchAndVerify.js — automated tamper detection watcher
- safety-simulation/setupTriggers.sql — SQLite trigger for instant tamper flagging
- safety-simulation/enrollIdentities.js — SDK-based identity enrollment
- safety-simulation/getHistory.js — audit trail query tool

**Open-source components used as infrastructure/libraries:**
All standard Hyperledger Fabric tooling and Node.js SDK packages listed in sections 1-4.
The fabric-samples/test-network was used only as a learning scaffold — the production
network (iinot-network) is an independent custom implementation.

---

*Document generated: June 2026 | Project: IINoT Lone Worker Safety Monitoring System*
