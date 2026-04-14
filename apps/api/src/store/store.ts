import type {
  AccountPolicyRecord,
  HdWalletRootRecord,
  UserRecord,
  WalletAccountShareRecord,
  WalletAccountSpendRequestRecord,
  WalletAccountSignRequestRecord,
  WalletAccountTransactionEventRecord,
  WalletAccountRecord
} from "../types";

export interface AppStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createUser(email: string, passwordHash: string): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  getUserById(userId: string): Promise<UserRecord | undefined>;
  createHdWalletRoot(
    root: Omit<HdWalletRootRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<HdWalletRootRecord>;
  getHdWalletRootByUserId(userId: string): Promise<HdWalletRootRecord | undefined>;
  createWalletAccount(
    account: Omit<WalletAccountRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountRecord>;
  getWalletAccountById(accountId: string): Promise<WalletAccountRecord | undefined>;
  getWalletAccountByAddress(
    chainId: number,
    address: string
  ): Promise<WalletAccountRecord | undefined>;
  listWalletAccountsByWalletRootId(walletRootId: string): Promise<WalletAccountRecord[]>;
  setHdWalletRootNextAccountIndex(walletRootId: string, nextAccountIndex: number): Promise<void>;
  createAccountPolicy(
    policy: Omit<AccountPolicyRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<AccountPolicyRecord>;
  getAccountPolicyById(policyId: string): Promise<AccountPolicyRecord | undefined>;
  listAccountPoliciesByOwnerUserId(ownerUserId: string): Promise<AccountPolicyRecord[]>;
  updateAccountPolicy(
    policyId: string,
    updates: Partial<Pick<AccountPolicyRecord, "name" | "rules">>
  ): Promise<AccountPolicyRecord>;
  createWalletAccountShare(
    share: Omit<WalletAccountShareRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountShareRecord>;
  getWalletAccountShareById(shareId: string): Promise<WalletAccountShareRecord | undefined>;
  getWalletAccountShareByAccountAndUser(
    accountId: string,
    sharedUserId: string
  ): Promise<WalletAccountShareRecord | undefined>;
  listWalletAccountSharesByAccount(accountId: string): Promise<WalletAccountShareRecord[]>;
  listWalletAccountSharesBySharedUser(sharedUserId: string): Promise<WalletAccountShareRecord[]>;
  updateWalletAccountShare(
    shareId: string,
    updates: Partial<Pick<WalletAccountShareRecord, "status">>
  ): Promise<WalletAccountShareRecord>;
  replaceWalletAccountSharePolicies(shareId: string, policyIds: string[]): Promise<void>;
  listWalletAccountSharePolicyIds(shareId: string): Promise<string[]>;
  createWalletAccountSpendRequest(
    request: Omit<WalletAccountSpendRequestRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountSpendRequestRecord>;
  getWalletAccountSpendRequestById(
    spendRequestId: string
  ): Promise<WalletAccountSpendRequestRecord | undefined>;
  getWalletAccountSpendRequestByShareAndIdempotencyKey(
    shareId: string,
    idempotencyKey: string
  ): Promise<WalletAccountSpendRequestRecord | undefined>;
  listWalletAccountSpendRequestsForUser(
    userId: string
  ): Promise<WalletAccountSpendRequestRecord[]>;
  updateWalletAccountSpendRequest(
    spendRequestId: string,
    updates: Partial<
      Omit<
        WalletAccountSpendRequestRecord,
        "id" | "shareId" | "accountId" | "requesterUserId" | "createdAt"
      >
    >
  ): Promise<WalletAccountSpendRequestRecord>;
  getWalletAccountSignRequest(
    accountId: string,
    idempotencyKey: string
  ): Promise<WalletAccountSignRequestRecord | undefined>;
  saveWalletAccountSignRequest(
    record: Omit<WalletAccountSignRequestRecord, "id" | "createdAt">
  ): Promise<WalletAccountSignRequestRecord>;
  getWalletAccountTransactionEventById(
    eventId: string
  ): Promise<WalletAccountTransactionEventRecord | undefined>;
  getWalletAccountTransactionEventByIdempotencyKey(
    accountId: string,
    idempotencyKey: string
  ): Promise<WalletAccountTransactionEventRecord | undefined>;
  getWalletAccountTransactionEventByTxHash(
    txHash: string
  ): Promise<WalletAccountTransactionEventRecord | undefined>;
  upsertWalletAccountTransactionEvent(
    record: Omit<WalletAccountTransactionEventRecord, "id" | "createdAt" | "updatedAt">
  ): Promise<WalletAccountTransactionEventRecord>;
  listWalletAccountTransactionEvents(
    accountId: string,
    limit?: number
  ): Promise<WalletAccountTransactionEventRecord[]>;
  listWalletAccountTransactionEventsByUserId(
    userId: string,
    limit?: number
  ): Promise<WalletAccountTransactionEventRecord[]>;
  getNextAccountNonce(accountId: string): Promise<number | undefined>;
  setNextAccountNonce(accountId: string, nextNonce: number): Promise<void>;
}
