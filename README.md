# VenCura — Custodial Wallet API

A custodial HD wallet platform built on Ethereum Sepolia. Users register, get an HD wallet, derive multiple accounts, sign messages, send native ETH and ERC-20 tokens, share accounts with other users via policy-controlled spend requests, and view on-chain transaction history — all through a REST API.

**GitHub:** [https://github.com/dheeraj07/Fireblocks-VenCura](https://github.com/dheeraj07/Fireblocks-VenCura)
**Frontend:** [https://authentic-nourishment-production-db95.up.railway.app](https://authentic-nourishment-production-db95.up.railway.app/)
**API Server:** [https://testfire-production.up.railway.app](https://testfire-production.up.railway.app)
**API Docs:** [https://authentic-nourishment-production-db95.up.railway.app/api-docs.html](https://authentic-nourishment-production-db95.up.railway.app/api-docs.html)
**Database Docs:** [https://dbdocs.io/nalubolu.d/wallet_api](https://dbdocs.io/nalubolu.d/wallet_api)

## Architecture

```
Frontend (Vanilla JS)          API (Fastify + TypeScript)          MySQL
  index.html  ──────────────►  /v1/auth/*                    ◄──► users
  main.js                      /v1/accounts/*                ◄──► wallet_accounts
  api-docs.html (Swagger)      /v1/policies/*                ◄──► account_policies
                                /v1/spend-requests/*          ◄──► spend_requests
                                /v1/transactions/*            ◄──► transaction_events
                                /v1/webhooks/alchemy/*
                                        │
                                        ▼
                                  Ethereum Sepolia
```

**Key design decisions:**
- **AppStore interface** (`store/store.ts`) — all 37 DB methods behind a single interface. Services never touch SQL directly.
- **HD wallet (BIP-39/BIP-44)** — one mnemonic per user, unlimited accounts derived deterministically. Private keys are never stored; they are derived on demand from the AES-256-GCM encrypted root.
- **Modular services** — each service has a single responsibility: `AuthService`, `HdWalletService`, `WalletTransactionService`, `AccountSharingService`, `SpendRequestService`, `PolicyService`, `TransactionService`.

## Requirements Coverage

| Requirement | Implementation |
|---|---|
| Create accounts/wallets | `POST /v1/accounts` — HD-derived, unlimited per user, unique names enforced |
| getBalance() | `GET /v1/accounts/:id/balances` — native ETH + ERC-20 tokens |
| signMessage(msg) | `POST /v1/accounts/:id/sign-message` — ECDSA with idempotency |
| sendTransaction(to, amount) | `POST /v1/accounts/:id/send-transaction` — native + ERC-20, nonce management |
| Basic client side | Frontend with auth, account management, sign/send UI, Swagger docs |
| Native + tokens | ERC-20 via configurable allowlist (`ERC20_TOKEN_ALLOWLIST`), `GET /v1/tokens` exposes the list with on-chain symbol/decimals |

**Optional features implemented:**
- Multiple accounts per user (HD derivation)
- Account sharing with policy-controlled spend limits
- Transaction history (on-chain via Alchemy webhooks + API sends)
- Security hardened (see `docs/security.md`)

## Project Structure

```
apps/api/src/
  app.ts              # Route definitions, service wiring, error handler
  config.ts           # AppConfig, environment loading
  schemas.ts          # Zod validation schemas for all endpoints
  middleware.ts       # parseSchema helper
  server.ts           # Entry point
  types.ts            # Record types and interfaces
  store/
    store.ts          # AppStore interface (DB-agnostic contract)
    mysql-store.ts    # MySQL implementation (mysql2/promise)
  services/
    auth-service.ts                       # Argon2 + JWT
    hd-wallet-service.ts                  # HD wallet lifecycle
    wallet-transaction-service.ts         # Sign + send with locking
    account-sharing-service.ts            # Share CRUD
    spend-request-service.ts              # Policy evaluation + spend flow
    policy-service.ts                     # Policy CRUD + validation
    transaction-service.ts                # Transaction history queries
    blockchain-service.ts                 # Ethers provider wrapper
    alchemy-transaction-history-service.ts # Webhook ingestion
    account-address-registrar.ts          # Alchemy webhook address registration
  lib/
    crypto.ts          # AES-256-GCM encrypt/decrypt
    errors.ts          # Typed application errors
    lock-manager.ts    # Per-account concurrency control
    asset-validators.ts # Shared asset/address/amount validation

apps/api/test/         # 12 test files, 85+ security tests
frontend/              # Vanilla JS client, Swagger UI
docs/
  security.md          # Security writeup (implemented + target architecture)
  openapi.yaml         # OpenAPI 3.0 spec
  schema.dbml          # Database schema (dbdocs)
```

## Running Locally

**Prerequisites:** Node.js 20+, MySQL 8+

```bash
git clone <repo-url> && cd VenCura
npm install

# Start MySQL and create the database
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS wallet_api"

# Configure environment
cp .env.example .env   # Or set DATABASE_URL, RPC_URL, etc.

# Start the API (auto-runs migrations)
npm run dev
```

The server starts on `http://localhost:3000`. The frontend is a separate service deployed from `/frontend`.

## Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MySQL connection string |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `ENCRYPTION_SECRET` | Secret for AES-256-GCM mnemonic encryption |
| `RPC_URL` | Ethereum RPC endpoint (Sepolia) |
| `CHAIN_ID` | Network chain ID (11155111 for Sepolia) |
| `ERC20_TOKEN_ALLOWLIST` | Comma-separated ERC-20 contract addresses |
| `HOST` | Server bind address (default `0.0.0.0`) |
| `PORT` | Server port (default `3000`) |
| `ALCHEMY_WEBHOOK_SIGNING_KEY` | HMAC-SHA256 key for Alchemy webhook verification |
| `ALCHEMY_WEBHOOK_ID` | Expected Alchemy webhook ID |
| `ALCHEMY_WEBHOOK_NETWORK` | Alchemy webhook network label (e.g. `ETH_SEPOLIA`) |
| `ALCHEMY_WEBHOOK_CHAIN_ID` | Chain ID for Alchemy webhook events |
| `ALCHEMY_NOTIFY_AUTH_TOKEN` | Alchemy Notify API auth token for address registration |
| `ALCHEMY_WEBHOOK_UPDATE_URL` | Alchemy webhook address update endpoint |
| `TRANSACTION_HISTORY_NETWORK` | Network label for API-sent transaction events |

## Testing

```bash
# Requires Docker (for MySQL testcontainers)
npm test
```

Tests use `@testcontainers/mysql` to spin up isolated MySQL instances per test. No shared state between tests.

**Test suites:**
- `auth.test.ts` — registration, login, token validation
- `hd-accounts.test.ts` — account creation, signing, transactions, ERC-20 transfers
- `account-sharing.test.ts` — share CRUD, access control
- `account-sharing-spend.test.ts` — spend request workflow with policy evaluation
- `account-policies.test.ts` — policy CRUD, validation, ownership
- `security-auth.test.ts` — 29 tests: unauthenticated access, invalid tokens, cross-instance isolation
- `security-ownership.test.ts` — 13 tests: cross-user access prevention on all endpoints
- `security-sharing-policies.test.ts` — 15 tests: policy limits, revocation, decision isolation
- `security-input-validation.test.ts` — 27 tests: SQL injection, XSS, UUID validation, malformed inputs
- `alchemy-transaction-history.test.ts` — Alchemy webhook ingestion and event normalization
- `alchemy-webhook-address-registrar.test.ts` — Address registration with Alchemy webhooks
- `mysql-storage.test.ts` — MySQL store implementation and migrations

## API Overview

All endpoints except `/health`, `/v1/auth/register`, `/v1/auth/login`, and `/v1/tokens` require `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/v1/tokens` | List supported ERC-20 tokens (symbol, decimals) |
| POST | `/v1/auth/register` | Create account, returns JWT |
| POST | `/v1/auth/login` | Authenticate, returns JWT |
| GET | `/v1/auth/me` | Return the authenticated user |
| GET | `/v1/accounts` | List owned + shared accounts |
| POST | `/v1/accounts` | Create new HD-derived account (unique name enforced) |
| GET | `/v1/accounts/:id/balances` | Native + ERC-20 balances |
| GET | `/v1/accounts/:id/transactions` | Transaction history for one account |
| POST | `/v1/accounts/:id/sign-message` | Sign arbitrary message |
| POST | `/v1/accounts/:id/send-transaction` | Send ETH or ERC-20 |
| POST | `/v1/accounts/:id/shares` | Share account with another user |
| GET | `/v1/accounts/:id/shares` | List shares for an owned account |
| POST | `/v1/accounts/:id/shares/:shareId/update` | Update share status or policies |
| POST | `/v1/accounts/:id/shared-spend-requests` | Request spend on shared account |
| POST | `/v1/policies` | Create spend policy |
| GET | `/v1/policies` | List policies owned by the authenticated user |
| POST | `/v1/policies/:policyId/update` | Update a policy |
| GET | `/v1/spend-requests` | List spend requests visible to the user |
| POST | `/v1/spend-requests/:id/decision` | Approve/reject spend request |
| GET | `/v1/transactions` | Transaction history across all accounts |
| GET | `/v1/transactions/hash/:txHash` | Look up a transaction by hash |
| POST | `/v1/webhooks/alchemy/address-activity` | Ingest Alchemy address activity webhook |

Full OpenAPI spec: `docs/openapi.yaml` or the Swagger UI on the frontend.

## Security

Detailed in [`docs/security.md`](docs/security.md). Summary of what's implemented:

- **Argon2id** password hashing
- **AES-256-GCM** encryption at rest for mnemonics (unique IV + auth tag per value)
- **JWT** authentication on all protected endpoints
- **Zod** schema validation at every entry point
- **Parameterized queries** (mysql2 prepared statements) — no SQL injection surface
- **Idempotency** with SHA-256 payload hashing to prevent double-spends
- **Per-account locking** for nonce management
- **Policy-based access control** for shared account spend limits
- **HMAC-SHA256** webhook signature verification with timing-safe comparison

The security doc also covers the **target architecture**: a three-tiered wallet system (hot/warm/cold) using MPC threshold signatures, AWS Nitro Enclaves, and KMS — designed so the private key never exists in complete form anywhere.

## Weaknesses and Known Limitations

- **Single encryption key** — all mnemonics encrypted with the same `ENCRYPTION_SECRET`. Production would use per-user key wrapping via KMS.
- **In-memory locks** — `LockManager` is single-process. Horizontal scaling requires a queue-based model (SQS/BullMQ).
- **No token revocation** — JWTs cannot be revoked before expiry. A Redis blocklist or refresh token rotation would address this.
- **No rate limiting** — removed for simplicity. Production would add per-IP and per-account rate limits.
- **Key exists in memory during signing** — the mnemonic is decrypted in the app process. The target architecture (Nitro Enclaves + MPC) eliminates this.

## Documentation

| Document | Description |
|---|---|
| [`docs/security.md`](docs/security.md) | Security analysis: implemented controls + target MPC/Nitro/tiered architecture |
| [`docs/openapi.yaml`](docs/openapi.yaml) | OpenAPI 3.0 specification |
| [`docs/schema.dbml`](docs/schema.dbml) | Database schema (viewable on dbdocs) |

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Fastify |
| Database | MySQL 8 (mysql2/promise) |
| Blockchain | ethers.js v6, Ethereum Sepolia |
| Auth | Argon2 + JWT (jose) |
| Validation | Zod |
| Testing | Vitest + Supertest + Testcontainers |
| Deployment | Railway |
