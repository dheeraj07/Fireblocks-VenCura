import { getAddress } from "ethers";

import { AppError } from "../lib/errors";
import { normalizeTransferAsset, assetKey } from "../lib/asset-validators";
import type { AppStore } from "../store/store";
import type { AccountPolicyRecord, AccountPolicyRules } from "../types";

export class PolicyService {
  private readonly supportedErc20Tokens: Set<string>;

  constructor(private readonly store: AppStore, supportedErc20Tokens: string[]) {
    this.supportedErc20Tokens = new Set(
      supportedErc20Tokens.map((token) => getAddress(token).toLowerCase())
    );
  }

  async createPolicy(input: {
    ownerUserId: string;
    name: string;
    rules: AccountPolicyRules;
  }) {
    const policy = await this.store.createAccountPolicy({
      ownerUserId: input.ownerUserId,
      name: this.normalizeName(input.name),
      rules: this.normalizeRules(input.rules)
    });

    return this.toPolicyResponse(policy);
  }

  async listPolicies(ownerUserId: string) {
    const policies = await this.store.listAccountPoliciesByOwnerUserId(ownerUserId);

    return {
      policies: policies.map((policy) => this.toPolicyResponse(policy))
    };
  }

  async updatePolicy(input: {
    ownerUserId: string;
    policyId: string;
    name?: string;
    rules?: AccountPolicyRules;
  }) {
    const existing = await this.getOwnedPolicy(input.ownerUserId, input.policyId);
    const updated = await this.store.updateAccountPolicy(existing.id, {
      name: input.name === undefined ? undefined : this.normalizeName(input.name),
      rules: input.rules === undefined ? undefined : this.normalizeRules(input.rules)
    });

    return this.toPolicyResponse(updated);
  }

  private async getOwnedPolicy(
    ownerUserId: string,
    policyId: string
  ): Promise<AccountPolicyRecord> {
    const policy = await this.store.getAccountPolicyById(policyId);

    if (!policy || policy.ownerUserId !== ownerUserId) {
      throw new AppError(404, "POLICY_NOT_FOUND", "Policy not found.");
    }

    return policy;
  }

  private normalizeName(name: string): string {
    const normalizedName = name.trim();

    if (!normalizedName) {
      throw new AppError(400, "INVALID_POLICY_NAME", "Policy name is required.");
    }

    return normalizedName;
  }

  private normalizeRules(rules: AccountPolicyRules): AccountPolicyRules {
    if (rules.assetRules.length === 0) {
      throw new AppError(400, "INVALID_POLICY_RULES", "At least one asset rule is required.");
    }

    const seenAssetKeys = new Set<string>();

    return {
      assetRules: rules.assetRules.map((rule) => {
        const asset = normalizeTransferAsset(rule.asset, this.supportedErc20Tokens);
        const key = assetKey(asset);

        if (seenAssetKeys.has(key)) {
          throw new AppError(400, "DUPLICATE_POLICY_ASSET", "Policy asset rules must be unique.");
        }

        seenAssetKeys.add(key);

        if (!/^[0-9]+$/.test(rule.autoApproveLimitRaw)) {
          throw new AppError(
            400,
            "INVALID_POLICY_LIMIT",
            "Auto-approve limit must be a raw integer string."
          );
        }

        return {
          asset,
          autoApproveLimitRaw: BigInt(rule.autoApproveLimitRaw).toString()
        };
      })
    };
  }

  private toPolicyResponse(policy: AccountPolicyRecord) {
    return {
      policyId: policy.id,
      ownerUserId: policy.ownerUserId,
      name: policy.name,
      rules: policy.rules,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt
    };
  }
}
