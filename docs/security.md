# Security Considerations

This document summarizes the wallet API security design in two parts: controls currently implemented and planned improvements.

---

## Part 1: What Is Implemented

### Authentication

- **Argon2id password hashing** via the `argon2` library.
- **JWT tokens** (HS256 via `jose`) with 12-hour expiry. Every protected endpoint verifies the token and confirms the user still exists before proceeding. Tokens are stateless with no server-side session storage.

### Key Management

- **HD wallet architecture (BIP-39/BIP-44):** Each user gets one mnemonic. All accounts are derived deterministically via `m/44'/60'/{index}'/0/0`. Private keys are never stored — they are derived on demand from the encrypted root.
- **AES-256-GCM encryption at rest:** The mnemonic is encrypted before database storage. Each encrypted value has a unique 12-byte random IV and a 16-byte authentication tag, providing both confidentiality and integrity.
- **Derivation verification:** Before signing, the service verifies that the derived address matches the stored address to catch configuration mismatches.

### Input Validation & Injection Prevention

- **Zod schema validation** on every request body, path parameter, and query parameter at the route entry point. Invalid requests are rejected with structured 400 errors before reaching business logic.
- **Address validation:** All Ethereum addresses are validated and checksummed via `ethers.getAddress()`. Stored addresses are lowercased for consistent comparison.
- **Amount validation:** Transfer amounts must be positive integer strings. BigInt parsing prevents overflow or floating-point issues.
- **Token allowlist:** ERC-20 transfers are restricted to a configurable allowlist (`ERC20_TOKEN_ALLOWLIST`).

### Idempotency & Concurrency

- **Payload-hash verification:** Sign, send, and spend request endpoints require an `idempotencyKey`. On retry, a SHA-256 hash of the request payload is compared against the stored hash. Mismatched retries return 409 to prevent accidental double-spends.
- **Per-account locking:** `LockManager` serializes transaction sending per account to prevent nonce collisions. A double-check after lock acquisition handles concurrent identical requests.
- **Nonce management:** The server tracks the next expected nonce per account and compares with the on-chain pending nonce, using `Math.max()` to handle sync gaps.

### Account Sharing & Spend Policies

- **Owner-only control:** Only the account owner can create shares, set policies, and approve/reject spend requests.
- **Policy-based auto-approval:** Spend requests from shared users are evaluated against all attached policies. The strictest auto-approve limit determines whether immediate execution or owner approval is required.
- **Asset restriction:** If no policy covers the requested asset, the request is rejected (403).
- **Share revocation:** Owners can revoke shares at any time. Revoked shares block new spend requests and prevent approval of pending ones.

### Webhook Security

- **HMAC-SHA256 signature verification** for Alchemy webhook payloads using a pre-shared signing key. The raw body is captured before JSON parsing, and comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
- **Webhook ID validation** optionally rejects payloads from unexpected webhook configurations.


---

## Part 2: Target Architecture

### 1. Target Architecture: MPC + Nitro Enclaves + Tiered Wallets

The current system encrypts the full mnemonic with AES-256-GCM and decrypts it in process during signing. The target architecture moves signing into MPC ceremonies backed by AWS Nitro Enclaves and KMS-gated share decryption, so the full private key is never reconstructed in the app server, database, or enclave. This requires additional infrastructure (AWS Nitro Enclaves, KMS, MPC libraries, S3, and RDS), so the current simpler architecture remains the initial implementation.

#### Overview

The architecture combines three layers:

1. **MPC-TSS** — the private key is split into multiple shares. No single share can sign anything. All required shares participate in an MPC signing ceremony to produce a valid signature without ever reconstructing the full key.
2. **AWS Nitro Enclaves + KMS** — online shares are encrypted with separate KMS keys and can only be decrypted inside attested Nitro Enclaves. Even with full access to the DB and RDS, the shares are useless without the enclave environment.
3. **Three-tiered wallets (hot/warm/cold)** — each user gets three cryptographically independent wallets with separate MPC key pairs and different security profiles.

#### Tier 1: Hot Wallet — Operational Liquidity

**Purpose:** High-availability operational liquidity for immediate user transactions.

**Funds:** 5-10% of total platform assets — capped to minimize the attack surface.

**MPC Scheme:** 2-of-2 (both shares online, fully automated)

| Share | Storage | Decryption |
|---|---|---|
| Share 1 | Local DB (encrypted blob) | KMS-A inside Nitro Enclave 1 |
| Share 2 | AWS RDS (encrypted blob) | KMS-B inside Nitro Enclave 2 |

Each encrypted share is decrypted only inside its attested Nitro Enclave. The two enclave participants run the MPC signing protocol and return a signature without reconstructing the full private key in either enclave. Signing is fully automated with no human intervention.

#### Tier 2: Warm Wallet — Operational Buffer

**Purpose:** Secondary layer between hot and cold. Handles refilling the hot wallet and absorbing excess.

**Funds:** 10-20% of total platform assets.

**MPC Scheme:** 2-of-2 (both shares online, but transactions have a mandatory time lock)

| Share | Storage | Decryption |
|---|---|---|
| Share 1 | Server DB (encrypted blob) | KMS-A inside Nitro Enclave 1 |
| Share 2 | AWS RDS (encrypted blob) | KMS-B inside Nitro Enclave 2 |

Both shares are online, but every transaction has a **mandatory X minutes delay**. During this window, the team is notified and can cancel suspicious activity before funds move. Access is restricted through internal networking controls such as firewalls and VPNs.

**Auto-sweep:** A background job automatically sweeps excess from hot → warm, and replenishes the hot wallet from warm when hot wallet balances run low. This runs without human intervention since both tiers have online shares.

#### Tier 3: Cold Wallet — Primary Reserve

**Purpose:** Bulk storage for the majority of platform assets.

**Funds:** 65-70% of total platform assets.

**MPC Scheme:** 3-of-3 (2 shares online, 1 share on air-gapped HSM)

| Share | Storage | Decryption |
|---|---|---|
| Share 1 | AWS RDS (encrypted blob) | KMS-A inside Nitro Enclave 1 |
| Share 2 | AWS RDS (encrypted blob) | KMS-B inside Nitro Enclave 2 |
| Share 3 | Air-gapped HSM (no network) | Decrypted locally on the HSM |

Transactions require a physical, multi-step process: the HSM is retrieved from secure storage, temporarily connected to participate in the MPC signing ceremony with the two Nitro Enclaves, then disconnected and locked away. The three MPC participants (2 Nitro Enclaves + 1 HSM) exchange signing rounds to produce a valid signature; the HSM participates as the third MPC party. Refilling warm from cold always requires this manual ceremony.

#### Fund Flow

A **sidecar service** continuously monitors all three wallet tiers and keeps them in balance:

```
Cold (65-70%)  ◄──────────────►  Warm (10-20%)  ◄──────────────►  Hot (5-10%)
                                                                   ◄── user transactions
```

| Direction | Trigger | Execution |
|---|---|---|
| Hot → Warm | Hot balance exceeds max threshold | Automatic |
| Warm → Hot | Hot balance drops below min threshold | Automatic |
| Warm → Cold | Warm balance exceeds max threshold | Automatic |
| Cold → Warm | Warm balance drops below min threshold | Manual (HSM ceremony and team approval required) |

All directions except Cold → Warm are fully automated by the sidecar. Cold → Warm requires the manual HSM ceremony because the air-gapped share requires a controlled manual signing process.

#### Key Share Refresh

Periodically rotate shares without changing the public key or wallet addresses. This provides forward secrecy: even if an attacker obtains a share at time T, it is cryptographically worthless after the next refresh.

#### Current vs Target Comparison

| Component | Current Implementation | Target Architecture |
|---|---|---|
| Key generation | `HDNodeWallet.createRandom()` | Hot: MPC DKG 2-of-2. Warm: MPC DKG 2-of-2. Cold: MPC DKG 3-of-3. |
| Key storage | AES-GCM encrypted mnemonic in DB | Hot: 1 share in local DB + 1 share in AWS RDS. Warm: 2 shares in DB + RDS. Cold: 2 shares in RDS + 1 on air-gapped HSM. |
| Wallet model | 1 wallet per user, uniform security | 3 wallets per user (hot/warm/cold), independent key pairs |
| Signing | Decrypt mnemonic in app server, sign locally | Hot: MPC between 2 enclaves. Warm: MPC between 2 enclaves. Cold: MPC between 2 enclaves + HSM. |
| Key rotation | Not supported | MPC key share refresh (new shares, same public key) |
| Fund management | Manual | Auto-sweep between tiers, manual cold ceremony |


### 2. Infrastructure & Scaling

- **Distributed locks:** `LockManager` is in-memory and single-process. For horizontal scaling, introduce a queue-based processing model (e.g., SQS) where transaction signing requests are serialized per account through a queue, eliminating the need for in-process locks entirely.
- **Rate limiting:** Add per-IP and per-user limits for auth, signing, send, and webhook endpoints.
- **CORS/security headers:** Add explicit allowed origins plus standard security headers (`helmet`-style defaults). Avoid wildcard CORS in production.
- **JWT refresh/revocation:** Move to short-lived access tokens plus refresh tokens stored server-side with revocation support for logout, compromise, and password reset.

### 3. Policy Engine Enhancement (TAP-style)

The current policy system evaluates auto-approve limits per asset. Future versions can add:

- **Rule-based controls:** Who can initiate, from which account, to which destination, under what conditions.
- **Sequential evaluation:** Most restrictive rules evaluated first.
- **Configurable conditions:** time-of-day windows, destination allowlists/blocklists, velocity limits (e.g., max 5 ETH per 24 hours across all spend requests).


---

## Summary

The current implementation covers the fundamentals: authenticated encryption for keys, Argon2 for passwords, parameterized queries, input validation at every boundary, idempotency with hash verification, and policy-based access control. The target architecture combines MPC-TSS with AWS Nitro Enclaves, KMS-gated decryption, and three-tiered wallets (hot/warm/cold), ensuring the private key never exists in complete form anywhere. Hot (5-10%, 2-of-2 MPC, fully automated), warm (10-20%, 2-of-2 MPC with X minute time lock), and cold (65-70%, 3-of-3 MPC with air-gapped HSM) provide defense in depth. Because this target architecture requires additional infrastructure and engineering investment, the current simpler architecture remains the practical starting point.
