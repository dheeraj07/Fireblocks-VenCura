import { randomUUID } from "node:crypto";

import type { Pool, RowDataPacket } from "mysql2/promise";
import { createPool } from "mysql2/promise";

import { AppError } from "../lib/errors";
import type { EncryptedValue } from "../lib/crypto";
import type {
  AccountPolicyRecord,
  HdWalletRootRecord,
  TransferAssetInput,
  UserRecord,
  WalletAccountShareRecord,
  WalletAccountSpendRequestRecord,
  WalletAccountSignRequestRecord,
  WalletAccountTransactionEventRecord,
  WalletAccountRecord
} from "../types";
import type { AppStore } from "./store";

// Column lists used in SELECT queries, extracted to avoid repetition.
const COLS = {
  user: "id, email, password_hash, created_at, updated_at",

  hdWalletRoot:
    "id, user_id, custody_type, encrypted_root_secret, next_account_index, created_at, updated_at",

  walletAccount:
    "id, wallet_root_id, user_id, name, chain_id, account_index, derivation_path, address, created_at, updated_at",

  accountPolicy: "id, owner_user_id, name, rules, created_at, updated_at",

  walletAccountShare:
    "id, account_id, owner_user_id, shared_user_id, status, created_at, updated_at",

  signRequest:
    "id, account_id, actor_user_id, message_hash, signature, idempotency_key, payload_hash, status, created_at",

  transactionEvent:
    "id, account_id, chain_id, network, direction, asset, from_address, to_address, amount_raw, tx_hash, log_index, nonce, block_number, block_hash, status, source, event_key, idempotency_key, payload_hash, error_code, observed_at, created_at, updated_at",

  spendRequest:
    "id, share_id, account_id, requester_user_id, policy_ids, asset, to_address, amount_raw, idempotency_key, payload_hash, status, decided_by_user_id, decided_at, transaction_event_id, error_code, created_at, updated_at"
} as const;

function prefixCols(alias: string, cols: string): string {
  return cols.split(", ").map((c) => `${alias}.${c}`).join(", ");
}

export class MysqlStore implements AppStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private initializePromise?: Promise<void>;

  constructor(options: { connectionString: string } | { pool: Pool }) {
    if ("pool" in options) {
      this.pool = options.pool;
      this.ownsPool = false;
      return;
    }

    this.pool = createPool({
      uri: options.connectionString,
      timezone: "Z"
    });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    this.initializePromise ??= this.runMigrations();
    await this.initializePromise;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  // ── Users ──

  async createUser(email: string, passwordHash: string): Promise<UserRecord> {
    const normalizedEmail = email.trim().toLowerCase();
    const now = this.now();
    const userId = randomUUID();

    try {
      await this.execute(
        `INSERT INTO users (id, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, normalizedEmail, passwordHash, now, now]
      );
      return this.mapUser(await this.selectById("users", COLS.user, userId));
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError(409, "EMAIL_EXISTS", "A user with that email already exists.");
      }
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.user} FROM users WHERE email = ?`,
      [email.trim().toLowerCase()]
    );
    return rows[0] ? this.mapUser(rows[0]) : undefined;
  }

  async getUserById(userId: string): Promise<UserRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.user} FROM users WHERE id = ?`,
      [userId]
    );
    return rows[0] ? this.mapUser(rows[0]) : undefined;
  }

  // ── HD Wallet Roots ──

  async createHdWalletRoot(
    root: Omit<HdWalletRootRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<HdWalletRootRecord> {
    const now = this.now();
    const id = randomUUID();

    await this.execute(
      `INSERT INTO hd_wallet_roots
         (id, user_id, custody_type, encrypted_root_secret, next_account_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, root.userId, root.custodyType, JSON.stringify(root.encryptedRootSecret), root.nextAccountIndex, now, now]
    );
    return this.mapHdWalletRoot(await this.selectById("hd_wallet_roots", COLS.hdWalletRoot, id));
  }

  async getHdWalletRootByUserId(userId: string): Promise<HdWalletRootRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.hdWalletRoot} FROM hd_wallet_roots WHERE user_id = ?`,
      [userId]
    );
    return rows[0] ? this.mapHdWalletRoot(rows[0]) : undefined;
  }

  async setHdWalletRootNextAccountIndex(walletRootId: string, nextAccountIndex: number): Promise<void> {
    await this.execute(
      `UPDATE hd_wallet_roots SET next_account_index = ?, updated_at = ? WHERE id = ?`,
      [nextAccountIndex, this.now(), walletRootId]
    );
  }

  // ── Wallet Accounts ──

  async createWalletAccount(
    account: Omit<WalletAccountRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountRecord> {
    const now = this.now();
    const id = randomUUID();

    try {
      await this.execute(
        `INSERT INTO wallet_accounts
           (id, wallet_root_id, user_id, name, chain_id, account_index, derivation_path, address, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, account.walletRootId, account.userId, account.name, account.chainId,
         account.accountIndex, account.derivationPath, account.address.toLowerCase(), now, now]
      );
      return this.mapWalletAccount(await this.selectById("wallet_accounts", COLS.walletAccount, id));
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError(409, "DUPLICATE_ACCOUNT_NAME", "An account with that name already exists.");
      }
      throw error;
    }
  }

  async getWalletAccountById(accountId: string): Promise<WalletAccountRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccount} FROM wallet_accounts WHERE id = ?`,
      [accountId]
    );
    return rows[0] ? this.mapWalletAccount(rows[0]) : undefined;
  }

  async getWalletAccountByAddress(chainId: number, address: string): Promise<WalletAccountRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccount} FROM wallet_accounts WHERE chain_id = ? AND address = ? LIMIT 1`,
      [chainId, address.toLowerCase()]
    );
    return rows[0] ? this.mapWalletAccount(rows[0]) : undefined;
  }

  async listWalletAccountsByWalletRootId(walletRootId: string): Promise<WalletAccountRecord[]> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccount} FROM wallet_accounts WHERE wallet_root_id = ? ORDER BY account_index ASC`,
      [walletRootId]
    );
    return rows.map((row) => this.mapWalletAccount(row));
  }

  // ── Account Policies ──

  async createAccountPolicy(
    policy: Omit<AccountPolicyRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<AccountPolicyRecord> {
    const now = this.now();
    const id = randomUUID();

    await this.execute(
      `INSERT INTO account_policies (id, owner_user_id, name, rules, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, policy.ownerUserId, policy.name, JSON.stringify(policy.rules), now, now]
    );
    return this.mapAccountPolicy(await this.selectById("account_policies", COLS.accountPolicy, id));
  }

  async getAccountPolicyById(policyId: string): Promise<AccountPolicyRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.accountPolicy} FROM account_policies WHERE id = ?`,
      [policyId]
    );
    return rows[0] ? this.mapAccountPolicy(rows[0]) : undefined;
  }

  async listAccountPoliciesByOwnerUserId(ownerUserId: string): Promise<AccountPolicyRecord[]> {
    const rows = await this.query(
      `SELECT ${COLS.accountPolicy} FROM account_policies WHERE owner_user_id = ? ORDER BY created_at DESC, id DESC`,
      [ownerUserId]
    );
    return rows.map((row) => this.mapAccountPolicy(row));
  }

  async updateAccountPolicy(
    policyId: string,
    updates: Partial<Pick<AccountPolicyRecord, "name" | "rules">>
  ): Promise<AccountPolicyRecord> {
    const existing = await this.getAccountPolicyById(policyId);
    if (!existing) throw new AppError(404, "POLICY_NOT_FOUND", "Policy not found.");

    const next = {
      ...existing,
      name: updates.name ?? existing.name,
      rules: updates.rules ?? existing.rules,
      updatedAt: this.now()
    };

    await this.execute(
      `UPDATE account_policies SET name = ?, rules = ?, updated_at = ? WHERE id = ?`,
      [next.name, JSON.stringify(next.rules), next.updatedAt, policyId]
    );
    return this.mapAccountPolicy(await this.selectById("account_policies", COLS.accountPolicy, policyId));
  }

  // ── Wallet Account Shares ──

  async createWalletAccountShare(
    share: Omit<WalletAccountShareRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountShareRecord> {
    const now = this.now();
    const id = randomUUID();

    try {
      await this.execute(
        `INSERT INTO wallet_account_shares
           (id, account_id, owner_user_id, shared_user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, share.accountId, share.ownerUserId, share.sharedUserId, share.status, now, now]
      );
      return this.mapWalletAccountShare(
        await this.selectById("wallet_account_shares", COLS.walletAccountShare, id)
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new AppError(409, "SHARE_EXISTS", "That user already has access to this account.");
      }
      throw error;
    }
  }

  async getWalletAccountShareById(shareId: string): Promise<WalletAccountShareRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccountShare} FROM wallet_account_shares WHERE id = ?`,
      [shareId]
    );
    return rows[0] ? this.mapWalletAccountShare(rows[0]) : undefined;
  }

  async getWalletAccountShareByAccountAndUser(
    accountId: string,
    sharedUserId: string
  ): Promise<WalletAccountShareRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccountShare} FROM wallet_account_shares WHERE account_id = ? AND shared_user_id = ?`,
      [accountId, sharedUserId]
    );
    return rows[0] ? this.mapWalletAccountShare(rows[0]) : undefined;
  }

  async listWalletAccountSharesByAccount(accountId: string): Promise<WalletAccountShareRecord[]> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccountShare} FROM wallet_account_shares WHERE account_id = ? ORDER BY created_at DESC, id DESC`,
      [accountId]
    );
    return rows.map((row) => this.mapWalletAccountShare(row));
  }

  async listWalletAccountSharesBySharedUser(sharedUserId: string): Promise<WalletAccountShareRecord[]> {
    const rows = await this.query(
      `SELECT ${COLS.walletAccountShare} FROM wallet_account_shares WHERE shared_user_id = ? ORDER BY created_at DESC, id DESC`,
      [sharedUserId]
    );
    return rows.map((row) => this.mapWalletAccountShare(row));
  }

  async updateWalletAccountShare(
    shareId: string,
    updates: Partial<Pick<WalletAccountShareRecord, "status">>
  ): Promise<WalletAccountShareRecord> {
    const existing = await this.getWalletAccountShareById(shareId);
    if (!existing) throw new AppError(404, "SHARE_NOT_FOUND", "Share not found.");

    await this.execute(
      `UPDATE wallet_account_shares SET status = ?, updated_at = ? WHERE id = ?`,
      [updates.status ?? existing.status, this.now(), shareId]
    );
    return this.mapWalletAccountShare(
      await this.selectById("wallet_account_shares", COLS.walletAccountShare, shareId)
    );
  }

  // ── Share Policies (join table) ──

  async replaceWalletAccountSharePolicies(shareId: string, policyIds: string[]): Promise<void> {
    await this.execute(`DELETE FROM wallet_account_share_policies WHERE share_id = ?`, [shareId]);
    for (const policyId of policyIds) {
      await this.execute(
        `INSERT INTO wallet_account_share_policies (share_id, policy_id, created_at) VALUES (?, ?, ?)`,
        [shareId, policyId, this.now()]
      );
    }
  }

  async listWalletAccountSharePolicyIds(shareId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT policy_id FROM wallet_account_share_policies WHERE share_id = ? ORDER BY created_at ASC, policy_id ASC`,
      [shareId]
    );
    return rows.map((row) => String(row.policy_id));
  }

  // ── Spend Requests ──

  async createWalletAccountSpendRequest(
    request: Omit<WalletAccountSpendRequestRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountSpendRequestRecord> {
    const id = randomUUID();
    const now = this.now();

    await this.execute(
      `INSERT INTO wallet_account_spend_requests
         (id, share_id, account_id, requester_user_id, policy_ids, asset,
          to_address, amount_raw, idempotency_key, payload_hash, status,
          decided_by_user_id, decided_at, transaction_event_id, error_code,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, request.shareId, request.accountId, request.requesterUserId,
        JSON.stringify(request.policyIds), JSON.stringify(request.asset),
        request.toAddress.toLowerCase(), request.amountRaw,
        request.idempotencyKey, request.payloadHash, request.status,
        request.decidedByUserId ?? null, request.decidedAt ? this.toMysqlDatetime(request.decidedAt) : null,
        request.transactionEventId ?? null, request.errorCode ?? null,
        now, now
      ]
    );
    return this.mapWalletAccountSpendRequest(
      await this.selectById("wallet_account_spend_requests", COLS.spendRequest, id)
    );
  }

  async getWalletAccountSpendRequestById(
    spendRequestId: string
  ): Promise<WalletAccountSpendRequestRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.spendRequest} FROM wallet_account_spend_requests WHERE id = ?`,
      [spendRequestId]
    );
    return rows[0] ? this.mapWalletAccountSpendRequest(rows[0]) : undefined;
  }

  async getWalletAccountSpendRequestByShareAndIdempotencyKey(
    shareId: string,
    idempotencyKey: string
  ): Promise<WalletAccountSpendRequestRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.spendRequest} FROM wallet_account_spend_requests WHERE share_id = ? AND idempotency_key = ?`,
      [shareId, idempotencyKey]
    );
    return rows[0] ? this.mapWalletAccountSpendRequest(rows[0]) : undefined;
  }

  async listWalletAccountSpendRequestsForUser(
    userId: string
  ): Promise<WalletAccountSpendRequestRecord[]> {
    const rows = await this.query(
      `SELECT ${prefixCols("r", COLS.spendRequest)}
       FROM wallet_account_spend_requests r
       INNER JOIN wallet_account_shares s ON s.id = r.share_id
       WHERE r.requester_user_id = ? OR s.owner_user_id = ?
       ORDER BY r.created_at DESC, r.id DESC`,
      [userId, userId]
    );
    return rows.map((row) => this.mapWalletAccountSpendRequest(row));
  }

  async updateWalletAccountSpendRequest(
    spendRequestId: string,
    updates: Partial<
      Omit<WalletAccountSpendRequestRecord, "id" | "shareId" | "accountId" | "requesterUserId" | "createdAt">
    >
  ): Promise<WalletAccountSpendRequestRecord> {
    const existing = await this.getWalletAccountSpendRequestById(spendRequestId);
    if (!existing) throw new AppError(404, "SPEND_REQUEST_NOT_FOUND", "Spend request not found.");

    const next = { ...existing, ...updates, updatedAt: this.now() };

    await this.execute(
      `UPDATE wallet_account_spend_requests
       SET policy_ids = ?, asset = ?, to_address = ?, amount_raw = ?,
           idempotency_key = ?, payload_hash = ?, status = ?,
           decided_by_user_id = ?, decided_at = ?, transaction_event_id = ?,
           error_code = ?, updated_at = ?
       WHERE id = ?`,
      [
        JSON.stringify(next.policyIds), JSON.stringify(next.asset),
        next.toAddress.toLowerCase(), next.amountRaw,
        next.idempotencyKey, next.payloadHash, next.status,
        next.decidedByUserId ?? null, next.decidedAt ? this.toMysqlDatetime(next.decidedAt) : null,
        next.transactionEventId ?? null, next.errorCode ?? null,
        next.updatedAt, spendRequestId
      ]
    );
    return this.mapWalletAccountSpendRequest(
      await this.selectById("wallet_account_spend_requests", COLS.spendRequest, spendRequestId)
    );
  }

  // ── Sign Requests ──

  async getWalletAccountSignRequest(
    accountId: string,
    idempotencyKey: string
  ): Promise<WalletAccountSignRequestRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.signRequest} FROM wallet_account_sign_requests WHERE account_id = ? AND idempotency_key = ?`,
      [accountId, idempotencyKey]
    );
    return rows[0] ? this.mapWalletAccountSignRequest(rows[0]) : undefined;
  }

  async saveWalletAccountSignRequest(
    record: Omit<WalletAccountSignRequestRecord, "id" | "createdAt">
  ): Promise<WalletAccountSignRequestRecord> {
    const id = randomUUID();
    const createdAt = this.now();

    await this.execute(
      `INSERT INTO wallet_account_sign_requests
         (id, account_id, actor_user_id, message_hash, signature, idempotency_key, payload_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, record.accountId, record.actorUserId, record.messageHash, record.signature,
       record.idempotencyKey, record.payloadHash, record.status, createdAt]
    );
    return this.mapWalletAccountSignRequest(
      await this.selectById("wallet_account_sign_requests", COLS.signRequest, id)
    );
  }

  // ── Transaction Events ──

  async getWalletAccountTransactionEventById(
    eventId: string
  ): Promise<WalletAccountTransactionEventRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.transactionEvent} FROM wallet_account_transaction_events WHERE id = ?`,
      [eventId]
    );
    return rows[0] ? this.mapWalletAccountTransactionEvent(rows[0]) : undefined;
  }

  async getWalletAccountTransactionEventByIdempotencyKey(
    accountId: string,
    idempotencyKey: string
  ): Promise<WalletAccountTransactionEventRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.transactionEvent} FROM wallet_account_transaction_events WHERE account_id = ? AND idempotency_key = ?`,
      [accountId, idempotencyKey]
    );
    return rows[0] ? this.mapWalletAccountTransactionEvent(rows[0]) : undefined;
  }

  async getWalletAccountTransactionEventByTxHash(
    txHash: string
  ): Promise<WalletAccountTransactionEventRecord | undefined> {
    const rows = await this.query(
      `SELECT ${COLS.transactionEvent} FROM wallet_account_transaction_events
       WHERE tx_hash = ? ORDER BY created_at DESC LIMIT 1`,
      [txHash]
    );
    return rows[0] ? this.mapWalletAccountTransactionEvent(rows[0]) : undefined;
  }

  async upsertWalletAccountTransactionEvent(
    record: Omit<WalletAccountTransactionEventRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountTransactionEventRecord> {
    const id = randomUUID();
    const now = this.now();

    await this.execute(
      `INSERT INTO wallet_account_transaction_events
         (id, account_id, chain_id, network, direction, asset,
          from_address, to_address, amount_raw, tx_hash, log_index, nonce,
          block_number, block_hash, status, source, event_key,
          idempotency_key, payload_hash, error_code, observed_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         account_id = VALUES(account_id), chain_id = VALUES(chain_id),
         network = VALUES(network), direction = VALUES(direction),
         asset = VALUES(asset), from_address = VALUES(from_address),
         to_address = VALUES(to_address), amount_raw = VALUES(amount_raw),
         tx_hash = VALUES(tx_hash), log_index = VALUES(log_index),
         nonce = VALUES(nonce), block_number = VALUES(block_number),
         block_hash = VALUES(block_hash), status = VALUES(status),
         source = VALUES(source),
         idempotency_key = COALESCE(VALUES(idempotency_key), idempotency_key),
         payload_hash = COALESCE(VALUES(payload_hash), payload_hash),
         error_code = VALUES(error_code), observed_at = VALUES(observed_at),
         updated_at = VALUES(updated_at)`,
      [
        id, record.accountId, record.chainId, record.network, record.direction,
        JSON.stringify(record.asset), record.fromAddress.toLowerCase(),
        record.toAddress.toLowerCase(), record.amountRaw, record.txHash.toLowerCase(),
        record.logIndex ?? null, record.nonce ?? null,
        record.blockNumber ?? null, record.blockHash?.toLowerCase() ?? null,
        record.status, record.source, record.eventKey,
        record.idempotencyKey ?? null, record.payloadHash ?? null,
        record.errorCode ?? null, record.observedAt ? this.toMysqlDatetime(record.observedAt) : null,
        now, now
      ]
    );

    // Upsert may have used existing row's id, so look up by event_key.
    const rows = await this.query(
      `SELECT ${COLS.transactionEvent} FROM wallet_account_transaction_events WHERE event_key = ?`,
      [record.eventKey]
    );
    return this.mapWalletAccountTransactionEvent(rows[0]);
  }

  async listWalletAccountTransactionEvents(
    accountId: string,
    limit = 50
  ): Promise<WalletAccountTransactionEventRecord[]> {
    const safeLimit = this.normalizeListLimit(limit);
    const rows = await this.query(
      `SELECT ${COLS.transactionEvent} FROM wallet_account_transaction_events
       WHERE account_id = ?
       ORDER BY COALESCE(observed_at, created_at) DESC, created_at DESC, id DESC
       LIMIT ${safeLimit}`,
      [accountId]
    );
    return rows.map((row) => this.mapWalletAccountTransactionEvent(row));
  }

  async listWalletAccountTransactionEventsByUserId(
    userId: string,
    limit = 50
  ): Promise<WalletAccountTransactionEventRecord[]> {
    const safeLimit = this.normalizeListLimit(limit);
    const rows = await this.query(
      `SELECT ${prefixCols("e", COLS.transactionEvent)}
       FROM wallet_account_transaction_events e
       INNER JOIN wallet_accounts a ON a.id = e.account_id
       WHERE a.user_id = ?
       ORDER BY COALESCE(e.observed_at, e.created_at) DESC, e.created_at DESC, e.id DESC
       LIMIT ${safeLimit}`,
      [userId]
    );
    return rows.map((row) => this.mapWalletAccountTransactionEvent(row));
  }

  // ── Nonces ──

  async getNextAccountNonce(accountId: string): Promise<number | undefined> {
    const rows = await this.query(
      `SELECT next_nonce FROM wallet_account_nonces WHERE account_id = ?`,
      [accountId]
    );
    return rows[0] ? Number(rows[0].next_nonce) : undefined;
  }

  async setNextAccountNonce(accountId: string, nextNonce: number): Promise<void> {
    await this.execute(
      `INSERT INTO wallet_account_nonces (account_id, next_nonce) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE next_nonce = VALUES(next_nonce)`,
      [accountId, nextNonce]
    );
  }

  // ── Private helpers ──

  private async runMigrations(): Promise<void> {
    const statements = [
      `SET FOREIGN_KEY_CHECKS = 0`,
      `DROP TABLE IF EXISTS wallet_nonces`,
      `DROP TABLE IF EXISTS sign_requests`,
      `DROP TABLE IF EXISTS transactions`,
      `DROP TABLE IF EXISTS wallets`,
      `DROP TABLE IF EXISTS wallet_account_transactions`,
      `SET FOREIGN_KEY_CHECKS = 1`,

      `CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS hd_wallet_roots (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        user_id VARCHAR(36) CHARACTER SET ascii NOT NULL UNIQUE,
        custody_type VARCHAR(255) NOT NULL,
        encrypted_root_secret JSON NOT NULL,
        next_account_index INT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_accounts (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        wallet_root_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        user_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        name VARCHAR(255) NOT NULL,
        chain_id INT NOT NULL,
        account_index INT NOT NULL,
        derivation_path VARCHAR(255) NOT NULL,
        address VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_wallet_root_name (wallet_root_id, name),
        UNIQUE KEY uq_wallet_chain_index (wallet_root_id, chain_id, account_index),
        UNIQUE KEY uq_wallet_chain_address (wallet_root_id, chain_id, address),
        FOREIGN KEY (wallet_root_id) REFERENCES hd_wallet_roots(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS account_policies (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        owner_user_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        name VARCHAR(255) NOT NULL,
        rules JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_account_shares (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        account_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        owner_user_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        shared_user_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        status VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_account_shared_user (account_id, shared_user_id),
        FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (shared_user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_account_share_policies (
        share_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        policy_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (share_id, policy_id),
        FOREIGN KEY (share_id) REFERENCES wallet_account_shares(id) ON DELETE CASCADE,
        FOREIGN KEY (policy_id) REFERENCES account_policies(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_account_sign_requests (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        account_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        actor_user_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        message_hash TEXT NOT NULL,
        signature TEXT NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_sign_account_idempotency (account_id, idempotency_key),
        FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_account_transaction_events (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        account_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        chain_id INT NOT NULL,
        network VARCHAR(255) NOT NULL,
        direction VARCHAR(255) NOT NULL,
        asset JSON NOT NULL,
        from_address VARCHAR(255) NOT NULL,
        to_address VARCHAR(255) NOT NULL,
        amount_raw TEXT NOT NULL,
        tx_hash VARCHAR(255) NOT NULL,
        log_index VARCHAR(255),
        nonce VARCHAR(255),
        block_number VARCHAR(255),
        block_hash VARCHAR(255),
        status VARCHAR(255) NOT NULL,
        source VARCHAR(255) NOT NULL,
        event_key VARCHAR(255) NOT NULL UNIQUE,
        idempotency_key VARCHAR(255),
        UNIQUE KEY idx_events_account_idempotency (account_id, idempotency_key),
        payload_hash VARCHAR(255),
        error_code VARCHAR(255),
        observed_at DATETIME(3),
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_account_spend_requests (
        id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        share_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        account_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        requester_user_id VARCHAR(36) CHARACTER SET ascii NOT NULL,
        policy_ids JSON NOT NULL,
        asset JSON NOT NULL,
        to_address VARCHAR(255) NOT NULL,
        amount_raw TEXT NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL,
        decided_by_user_id VARCHAR(36) CHARACTER SET ascii,
        decided_at DATETIME(3),
        transaction_event_id VARCHAR(36) CHARACTER SET ascii,
        error_code VARCHAR(255),
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_share_idempotency (share_id, idempotency_key),
        FOREIGN KEY (share_id) REFERENCES wallet_account_shares(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (transaction_event_id) REFERENCES wallet_account_transaction_events(id) ON DELETE SET NULL
      ) ENGINE=InnoDB`,

      `CREATE TABLE IF NOT EXISTS wallet_account_nonces (
        account_id VARCHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
        next_nonce INT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`
    ];

    for (const statement of statements) {
      await this.pool.execute(statement);
    }

    // Add unique constraint on account name per wallet root (safe for existing databases).
    try {
      await this.pool.execute(
        `ALTER TABLE wallet_accounts ADD UNIQUE KEY uq_wallet_root_name (wallet_root_id, name)`
      );
    } catch {
      // Constraint already exists — ignore.
    }
  }

  /** Run INSERT/UPDATE/DELETE. */
  private async execute(sql: string, values?: (string | number | null)[]): Promise<void> {
    await this.initialize();
    await this.pool.execute(sql, values);
  }

  /** Run SELECT, return rows. */
  private async query(sql: string, values?: (string | number | null)[]): Promise<RowDataPacket[]> {
    await this.initialize();
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, values);
    return rows;
  }

  /** SELECT * FROM table WHERE id = ? — used after INSERT to replace PG's RETURNING. */
  private async selectById(table: string, columns: string, id: string): Promise<RowDataPacket> {
    const rows = await this.query(`SELECT ${columns} FROM ${table} WHERE id = ?`, [id]);
    return rows[0];
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ER_DUP_ENTRY"
    );
  }

  private normalizeListLimit(limit: number): number {
    return Math.min(Math.max(Math.trunc(limit), 1), 100);
  }

  /** Return current UTC timestamp in MySQL DATETIME(3) format. */
  private now(): string {
    return new Date().toISOString().replace("T", " ").replace("Z", "");
  }

  /** Convert an ISO string or Date to MySQL DATETIME(3) format for writes. */
  private toMysqlDatetime(value: string): string {
    return value.replace("T", " ").replace("Z", "");
  }

  // ── Row mappers ──

  private mapUser(row: RowDataPacket): UserRecord {
    return {
      id: String(row.id),
      email: String(row.email),
      passwordHash: String(row.password_hash),
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private mapHdWalletRoot(row: RowDataPacket): HdWalletRootRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      custodyType: row.custody_type as HdWalletRootRecord["custodyType"],
      encryptedRootSecret: this.parseJson(row.encrypted_root_secret) as EncryptedValue,
      nextAccountIndex: Number(row.next_account_index),
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private mapWalletAccount(row: RowDataPacket): WalletAccountRecord {
    return {
      id: String(row.id),
      walletRootId: String(row.wallet_root_id),
      userId: String(row.user_id),
      name: String(row.name),
      chainId: Number(row.chain_id),
      accountIndex: Number(row.account_index),
      derivationPath: String(row.derivation_path),
      address: String(row.address),
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private mapAccountPolicy(row: RowDataPacket): AccountPolicyRecord {
    return {
      id: String(row.id),
      ownerUserId: String(row.owner_user_id),
      name: String(row.name),
      rules: this.parseJson(row.rules) as AccountPolicyRecord["rules"],
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private mapWalletAccountShare(row: RowDataPacket): WalletAccountShareRecord {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      ownerUserId: String(row.owner_user_id),
      sharedUserId: String(row.shared_user_id),
      status: row.status as WalletAccountShareRecord["status"],
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private mapWalletAccountSpendRequest(row: RowDataPacket): WalletAccountSpendRequestRecord {
    return {
      id: String(row.id),
      shareId: String(row.share_id),
      accountId: String(row.account_id),
      requesterUserId: String(row.requester_user_id),
      policyIds: this.parseJson(row.policy_ids) as string[],
      asset: this.parseJson(row.asset) as TransferAssetInput,
      toAddress: String(row.to_address),
      amountRaw: String(row.amount_raw),
      idempotencyKey: String(row.idempotency_key),
      payloadHash: String(row.payload_hash),
      status: row.status as WalletAccountSpendRequestRecord["status"],
      decidedByUserId: row.decided_by_user_id ? String(row.decided_by_user_id) : undefined,
      decidedAt: row.decided_at ? this.toIsoString(row.decided_at) : undefined,
      transactionEventId: row.transaction_event_id ? String(row.transaction_event_id) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined,
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private mapWalletAccountSignRequest(row: RowDataPacket): WalletAccountSignRequestRecord {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      actorUserId: String(row.actor_user_id),
      messageHash: String(row.message_hash),
      signature: String(row.signature),
      idempotencyKey: String(row.idempotency_key),
      payloadHash: String(row.payload_hash),
      status: row.status as WalletAccountSignRequestRecord["status"],
      createdAt: this.toIsoString(row.created_at)
    };
  }

  private mapWalletAccountTransactionEvent(row: RowDataPacket): WalletAccountTransactionEventRecord {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      chainId: Number(row.chain_id),
      network: String(row.network),
      direction: row.direction as WalletAccountTransactionEventRecord["direction"],
      asset: this.parseJson(row.asset) as TransferAssetInput,
      fromAddress: String(row.from_address),
      toAddress: String(row.to_address),
      amountRaw: String(row.amount_raw),
      txHash: String(row.tx_hash),
      logIndex: row.log_index ? String(row.log_index) : undefined,
      nonce: row.nonce ? String(row.nonce) : undefined,
      blockNumber: row.block_number ? String(row.block_number) : undefined,
      blockHash: row.block_hash ? String(row.block_hash) : undefined,
      status: row.status as WalletAccountTransactionEventRecord["status"],
      source: row.source as WalletAccountTransactionEventRecord["source"],
      eventKey: String(row.event_key),
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
      payloadHash: row.payload_hash ? String(row.payload_hash) : undefined,
      errorCode: row.error_code ? String(row.error_code) : undefined,
      observedAt: row.observed_at ? this.toIsoString(row.observed_at) : undefined,
      createdAt: this.toIsoString(row.created_at),
      updatedAt: this.toIsoString(row.updated_at)
    };
  }

  private parseJson(value: unknown): unknown {
    if (typeof value === "string") {
      return JSON.parse(value);
    }
    return value;
  }

  private toIsoString(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return new Date(String(value)).toISOString();
  }
}
