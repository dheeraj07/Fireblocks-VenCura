import { createHash } from "node:crypto";

import { getAddress } from "ethers";

import { AppError } from "../lib/errors";
import { normalizeTransferAsset, normalizeAddress, normalizeAmount, assetKey } from "../lib/asset-validators";
import type { AppStore } from "../store/store";
import type {
  AccountPolicyRecord,
  TransferAssetInput,
  WalletAccountSpendRequestRecord
} from "../types";
import type { WalletTransactionService } from "./wallet-transaction-service";

export class SpendRequestService {
  private readonly supportedErc20Tokens: Set<string>;

  constructor(
    private readonly store: AppStore,
    private readonly walletTransactionService: WalletTransactionService,
    supportedErc20Tokens: string[]
  ) {
    this.supportedErc20Tokens = new Set(
      supportedErc20Tokens.map((token) => getAddress(token).toLowerCase())
    );
  }

  async createSpendRequest(input: {
    requesterUserId: string;
    accountId: string;
    to: string;
    amount: string;
    asset: TransferAssetInput;
    idempotencyKey: string;
  }) {
    const share = await this.getActiveSharedAccount(input.requesterUserId, input.accountId);
    const toAddress = normalizeAddress(input.to);
    const amountRaw = normalizeAmount(input.amount);
    const asset = normalizeTransferAsset(input.asset, this.supportedErc20Tokens);
    const payloadHash = this.hashSpendPayload({ accountId: share.accountId, toAddress, amountRaw, asset });

    const existing = await this.store.getWalletAccountSpendRequestByShareAndIdempotencyKey(
      share.id,
      input.idempotencyKey
    );

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different payload.");
      }
      return this.toSpendRequestResponse(existing);
    }

    const policyIds = await this.store.listWalletAccountSharePolicyIds(share.id);
    const shouldExecuteImmediately = await this.shouldExecuteImmediately({
      ownerUserId: share.ownerUserId,
      policyIds,
      asset,
      amountRaw
    });

    const spendRequest = await this.store.createWalletAccountSpendRequest({
      shareId: share.id,
      accountId: share.accountId,
      requesterUserId: input.requesterUserId,
      policyIds,
      asset,
      toAddress,
      amountRaw,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      status: "pending"
    });

    if (!shouldExecuteImmediately) {
      return this.toSpendRequestResponse(spendRequest);
    }

    return this.executeSpendRequest({
      spendRequest,
      ownerUserId: share.ownerUserId,
      decidedByUserId: share.ownerUserId
    });
  }

  async listSpendRequests(userId: string) {
    const spendRequests = await this.store.listWalletAccountSpendRequestsForUser(userId);

    return {
      spendRequests: await Promise.all(
        spendRequests.map((spendRequest) => this.toSpendRequestResponse(spendRequest))
      )
    };
  }

  async decideSpendRequest(input: {
    ownerUserId: string;
    spendRequestId: string;
    decision: "approve" | "reject";
  }) {
    const spendRequest = await this.getSpendRequestForOwner(input.ownerUserId, input.spendRequestId);
    const share = await this.store.getWalletAccountShareById(spendRequest.shareId);

    if (!share || share.ownerUserId !== input.ownerUserId) {
      throw new AppError(404, "SPEND_REQUEST_NOT_FOUND", "Spend request not found.");
    }

    if (spendRequest.status !== "pending") {
      if (input.decision === "approve" && spendRequest.status === "broadcasted") {
        return this.toSpendRequestResponse(spendRequest);
      }
      if (input.decision === "reject" && spendRequest.status === "rejected") {
        return this.toSpendRequestResponse(spendRequest);
      }
      throw new AppError(409, "SPEND_REQUEST_ALREADY_DECIDED", "Spend request was already decided.");
    }

    if (input.decision === "reject") {
      const rejected = await this.store.updateWalletAccountSpendRequest(spendRequest.id, {
        status: "rejected",
        decidedByUserId: input.ownerUserId,
        decidedAt: new Date().toISOString()
      });
      return this.toSpendRequestResponse(rejected);
    }

    if (share.status !== "active") {
      throw new AppError(409, "SHARE_REVOKED", "Share is revoked.");
    }

    return this.executeSpendRequest({
      spendRequest,
      ownerUserId: share.ownerUserId,
      decidedByUserId: input.ownerUserId
    });
  }

  // ── Private helpers ──

  private async getActiveSharedAccount(sharedUserId: string, accountId: string) {
    const share = await this.store.getWalletAccountShareByAccountAndUser(accountId, sharedUserId);
    const account = await this.store.getWalletAccountById(accountId);

    if (!share || share.status !== "active" || !account || account.id !== share.accountId) {
      throw new AppError(404, "SHARED_ACCOUNT_NOT_FOUND", "Shared account not found.");
    }

    return share;
  }

  private async getSpendRequestForOwner(ownerUserId: string, spendRequestId: string) {
    const spendRequest = await this.store.getWalletAccountSpendRequestById(spendRequestId);
    const account = spendRequest
      ? await this.store.getWalletAccountById(spendRequest.accountId)
      : undefined;

    if (!spendRequest || !account || account.userId !== ownerUserId) {
      throw new AppError(404, "SPEND_REQUEST_NOT_FOUND", "Spend request not found.");
    }

    return spendRequest;
  }

  private async shouldExecuteImmediately(input: {
    ownerUserId: string;
    policyIds: string[];
    asset: TransferAssetInput;
    amountRaw: string;
  }): Promise<boolean> {
    if (input.policyIds.length === 0) {
      return true;
    }

    const policies = await Promise.all(
      input.policyIds.map(async (policyId) => {
        const policy = await this.store.getAccountPolicyById(policyId);

        if (!policy || policy.ownerUserId !== input.ownerUserId) {
          throw new AppError(404, "POLICY_NOT_FOUND", "Policy not found.");
        }

        return policy;
      })
    );

    const matchingLimits = policies.map((policy) =>
      this.getPolicyAutoApproveLimit(policy, input.asset)
    );

    if (matchingLimits.some((limit) => limit === undefined)) {
      throw new AppError(403, "ASSET_NOT_ALLOWED", "Shared user cannot transact with this asset.");
    }

    const strictestLimit = matchingLimits.reduce<bigint | undefined>((minimum, limit) => {
      if (limit === undefined) return minimum;
      return minimum === undefined || limit < minimum ? limit : minimum;
    }, undefined);

    return strictestLimit !== undefined && BigInt(input.amountRaw) <= strictestLimit;
  }

  private getPolicyAutoApproveLimit(
    policy: AccountPolicyRecord,
    asset: TransferAssetInput
  ): bigint | undefined {
    const rule = policy.rules.assetRules.find(
      (assetRule) => assetKey(assetRule.asset) === assetKey(asset)
    );
    return rule ? BigInt(rule.autoApproveLimitRaw) : undefined;
  }

  private async executeSpendRequest(input: {
    spendRequest: WalletAccountSpendRequestRecord;
    ownerUserId: string;
    decidedByUserId: string;
  }) {
    const decidedAt = new Date().toISOString();

    try {
      const transaction = await this.walletTransactionService.sendTransaction({
        userId: input.ownerUserId,
        accountId: input.spendRequest.accountId,
        to: input.spendRequest.toAddress,
        amount: input.spendRequest.amountRaw,
        asset: input.spendRequest.asset,
        idempotencyKey: `shared-spend:${input.spendRequest.id}`
      });

      const updated = await this.store.updateWalletAccountSpendRequest(input.spendRequest.id, {
        status: "broadcasted",
        decidedByUserId: input.decidedByUserId,
        decidedAt,
        transactionEventId: transaction.transactionId,
        errorCode: undefined
      });

      return this.toSpendRequestResponse(updated);
    } catch (error) {
      await this.store.updateWalletAccountSpendRequest(input.spendRequest.id, {
        status: "failed",
        decidedByUserId: input.decidedByUserId,
        decidedAt,
        errorCode: error instanceof AppError ? error.code : "TRANSACTION_FAILED"
      });

      throw error;
    }
  }

  private hashSpendPayload(input: {
    accountId: string;
    toAddress: string;
    amountRaw: string;
    asset: TransferAssetInput;
  }): string {
    return createHash("sha256")
      .update(JSON.stringify({
        action: "shared-spend-request",
        accountId: input.accountId,
        to: input.toAddress,
        amount: input.amountRaw,
        asset: input.asset
      }))
      .digest("hex");
  }

  private async toSpendRequestResponse(spendRequest: WalletAccountSpendRequestRecord) {
    const [share, transaction] = await Promise.all([
      this.store.getWalletAccountShareById(spendRequest.shareId),
      spendRequest.transactionEventId
        ? this.store.getWalletAccountTransactionEventById(spendRequest.transactionEventId)
        : Promise.resolve(undefined)
    ]);

    if (!share) {
      throw new AppError(500, "SPEND_REQUEST_SHARE_NOT_FOUND", "Spend request share not found.");
    }

    return {
      spendRequestId: spendRequest.id,
      shareId: spendRequest.shareId,
      accountId: spendRequest.accountId,
      ownerUserId: share.ownerUserId,
      requesterUserId: spendRequest.requesterUserId,
      policyIds: spendRequest.policyIds,
      asset: spendRequest.asset,
      toAddress: getAddress(spendRequest.toAddress),
      amountRaw: spendRequest.amountRaw,
      idempotencyKey: spendRequest.idempotencyKey,
      status: spendRequest.status,
      decidedByUserId: spendRequest.decidedByUserId ?? null,
      decidedAt: spendRequest.decidedAt ?? null,
      transactionEventId: spendRequest.transactionEventId ?? null,
      txHash: transaction?.txHash ?? null,
      errorCode: spendRequest.errorCode ?? null,
      createdAt: spendRequest.createdAt,
      updatedAt: spendRequest.updatedAt
    };
  }
}
