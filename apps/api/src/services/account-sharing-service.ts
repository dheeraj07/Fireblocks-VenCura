import { getAddress } from "ethers";

import { AppError } from "../lib/errors";
import type { AppStore } from "../store/store";
import type {
  WalletAccountRecord,
  WalletAccountShareRecord
} from "../types";

export class AccountSharingService {
  constructor(private readonly store: AppStore) {}

  async createShare(input: {
    ownerUserId: string;
    accountId: string;
    sharedUserId: string;
    policyIds: string[];
  }) {
    const account = await this.getOwnedAccount(input.ownerUserId, input.accountId);
    const policyIds = await this.validatePolicyIds(input.ownerUserId, input.policyIds);

    await this.validateShareTarget(input.ownerUserId, input.sharedUserId);

    const share = await this.store.createWalletAccountShare({
      accountId: account.id,
      ownerUserId: input.ownerUserId,
      sharedUserId: input.sharedUserId,
      status: "active"
    });

    await this.store.replaceWalletAccountSharePolicies(share.id, policyIds);

    return this.toShareResponse(share, policyIds);
  }

  async listShares(ownerUserId: string, accountId: string) {
    const account = await this.getOwnedAccount(ownerUserId, accountId);
    const shares = await this.store.listWalletAccountSharesByAccount(account.id);

    return {
      shares: await Promise.all(shares.map((share) => this.toShareResponseWithPolicies(share)))
    };
  }

  async updateShare(input: {
    ownerUserId: string;
    accountId: string;
    shareId: string;
    status?: WalletAccountShareRecord["status"];
    policyIds?: string[];
  }) {
    const account = await this.getOwnedAccount(input.ownerUserId, input.accountId);
    const share = await this.getOwnedShare(input.ownerUserId, account.id, input.shareId);

    let policyIds = await this.store.listWalletAccountSharePolicyIds(share.id);

    if (input.policyIds) {
      policyIds = await this.validatePolicyIds(input.ownerUserId, input.policyIds);
      await this.store.replaceWalletAccountSharePolicies(share.id, policyIds);
    }

    const updatedShare = input.status
      ? await this.store.updateWalletAccountShare(share.id, { status: input.status })
      : share;

    return this.toShareResponse(updatedShare, policyIds);
  }

  async listSharedAccounts(sharedUserId: string) {
    const shares = await this.store.listWalletAccountSharesBySharedUser(sharedUserId);
    const activeShares = shares.filter((share) => share.status === "active");
    const accounts = await Promise.all(
      activeShares.map(async (share) => {
        const account = await this.store.getWalletAccountById(share.accountId);

        if (!account) {
          return undefined;
        }

        const policyIds = await this.store.listWalletAccountSharePolicyIds(share.id);

        return this.toSharedAccountResponse(account, share, policyIds);
      })
    );

    return {
      accounts: accounts.filter((account) => account !== undefined)
    };
  }

  private async getOwnedAccount(
    ownerUserId: string,
    accountId: string
  ): Promise<WalletAccountRecord> {
    const account = await this.store.getWalletAccountById(accountId);

    if (!account || account.userId !== ownerUserId) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
    }

    return account;
  }

  private async getOwnedShare(
    ownerUserId: string,
    accountId: string,
    shareId: string
  ): Promise<WalletAccountShareRecord> {
    const share = await this.store.getWalletAccountShareById(shareId);

    if (!share || share.ownerUserId !== ownerUserId || share.accountId !== accountId) {
      throw new AppError(404, "SHARE_NOT_FOUND", "Share not found.");
    }

    return share;
  }

  private async validateShareTarget(ownerUserId: string, sharedUserId: string): Promise<void> {
    if (ownerUserId === sharedUserId) {
      throw new AppError(400, "INVALID_SHARE_TARGET", "Cannot share an account with yourself.");
    }

    const sharedUser = await this.store.getUserById(sharedUserId);

    if (!sharedUser) {
      throw new AppError(404, "USER_NOT_FOUND", "Shared user not found.");
    }
  }

  private async validatePolicyIds(ownerUserId: string, policyIds: string[]): Promise<string[]> {
    const uniquePolicyIds = [...new Set(policyIds)];

    for (const policyId of uniquePolicyIds) {
      const policy = await this.store.getAccountPolicyById(policyId);

      if (!policy || policy.ownerUserId !== ownerUserId) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy not found.");
      }
    }

    return uniquePolicyIds;
  }

  private async toShareResponseWithPolicies(share: WalletAccountShareRecord) {
    return this.toShareResponse(
      share,
      await this.store.listWalletAccountSharePolicyIds(share.id)
    );
  }

  private toShareResponse(share: WalletAccountShareRecord, policyIds: string[]) {
    return {
      shareId: share.id,
      accountId: share.accountId,
      ownerUserId: share.ownerUserId,
      sharedUserId: share.sharedUserId,
      status: share.status,
      policyIds,
      createdAt: share.createdAt,
      updatedAt: share.updatedAt
    };
  }

  private toSharedAccountResponse(
    account: WalletAccountRecord,
    share: WalletAccountShareRecord,
    policyIds: string[]
  ) {
    return {
      accountId: account.id,
      walletRootId: account.walletRootId,
      userId: account.userId,
      name: account.name,
      chainId: account.chainId,
      accountIndex: account.accountIndex,
      derivationPath: account.derivationPath,
      address: getAddress(account.address),
      createdAt: account.createdAt,
      accessType: "shared" as const,
      shareId: share.id,
      policyIds
    };
  }
}
