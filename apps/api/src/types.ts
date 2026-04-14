import type { EncryptedValue } from "./lib/crypto";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface HdWalletRootRecord {
  id: string;
  userId: string;
  custodyType: "local_hd";
  encryptedRootSecret: EncryptedValue;
  nextAccountIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletAccountRecord {
  id: string;
  walletRootId: string;
  userId: string;
  name: string;
  chainId: number;
  accountIndex: number;
  derivationPath: string;
  address: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPolicyRules {
  assetRules: Array<{
    asset: TransferAssetInput;
    autoApproveLimitRaw: string;
  }>;
}

export interface AccountPolicyRecord {
  id: string;
  ownerUserId: string;
  name: string;
  rules: AccountPolicyRules;
  createdAt: string;
  updatedAt: string;
}

export interface WalletAccountShareRecord {
  id: string;
  accountId: string;
  ownerUserId: string;
  sharedUserId: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface WalletAccountSpendRequestRecord {
  id: string;
  shareId: string;
  accountId: string;
  requesterUserId: string;
  policyIds: string[];
  asset: TransferAssetInput;
  toAddress: string;
  amountRaw: string;
  idempotencyKey: string;
  payloadHash: string;
  status: "pending" | "rejected" | "broadcasted" | "failed";
  decidedByUserId?: string;
  decidedAt?: string;
  transactionEventId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletAccountSignRequestRecord {
  id: string;
  accountId: string;
  actorUserId: string;
  messageHash: string;
  signature: string;
  idempotencyKey: string;
  payloadHash: string;
  status: "completed";
  createdAt: string;
}

interface NativeAssetInput {
  type: "native";
}

interface Erc20AssetInput {
  type: "erc20";
  tokenAddress: string;
}

export type TransferAssetInput = NativeAssetInput | Erc20AssetInput;

type TransactionStatus = "broadcasted" | "confirmed" | "failed";

export type AccountTransactionEventDirection = "incoming" | "outgoing";
export type AccountTransactionEventStatus = TransactionStatus | "removed";
type AccountTransactionEventSource = "alchemy_address_activity" | "api_send";

export interface WalletAccountTransactionEventRecord {
  id: string;
  accountId: string;
  chainId: number;
  network: string;
  direction: AccountTransactionEventDirection;
  asset: TransferAssetInput;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  txHash: string;
  logIndex?: string;
  nonce?: string;
  blockNumber?: string;
  blockHash?: string;
  status: AccountTransactionEventStatus;
  source: AccountTransactionEventSource;
  eventKey: string;
  idempotencyKey?: string;
  payloadHash?: string;
  errorCode?: string;
  observedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
}
