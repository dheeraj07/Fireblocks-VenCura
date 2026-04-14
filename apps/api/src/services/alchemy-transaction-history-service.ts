import { getAddress, parseUnits } from "ethers";

import { AppError } from "../lib/errors";
import type { AppStore } from "../store/store";
import type {
  AccountTransactionEventStatus,
  AccountTransactionEventDirection,
  TransferAssetInput,
  WalletAccountRecord
} from "../types";

export interface AlchemyAddressActivityPayload {
  createdAt?: string;
  event?: {
    network?: string;
    activity?: AlchemyAddressActivityItem[];
  };
  id?: string;
  type?: string;
  webhookId?: string;
}

interface AlchemyAddressActivityItem {
  asset?: string | null;
  blockNum?: string | null;
  category?: string | null;
  erc1155Metadata?: unknown[] | null;
  erc721TokenId?: string | null;
  fromAddress?: string | null;
  hash?: string | null;
  log?: {
    address?: string | null;
    blockHash?: string | null;
    blockNumber?: string | null;
    logIndex?: string | null;
    removed?: boolean | null;
    transactionHash?: string | null;
  } | null;
  rawContract?: {
    address?: string | null;
    decimals?: number | null;
    rawValue?: string | null;
  } | null;
  toAddress?: string | null;
  typeTraceAddress?: string | null;
  value?: number | string | null;
}

interface NormalizedAlchemyActivity {
  asset: TransferAssetInput;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  txHash: string;
  logIndex?: string;
  blockNumber?: string;
  blockHash?: string;
  status: AccountTransactionEventStatus;
  eventIdentity: string;
}

interface AlchemyAddressActivityIngestResult {
  processedActivities: number;
  savedEvents: number;
  ignoredActivities: number;
}

export class AlchemyTransactionHistoryService {
  constructor(
    private readonly store: AppStore,
    private readonly networkChainIds: Record<string, number>
  ) {}

  async ingestAddressActivity(
    payload: AlchemyAddressActivityPayload
  ): Promise<AlchemyAddressActivityIngestResult> {
    if (payload.type !== "ADDRESS_ACTIVITY") {
      throw new AppError(400, "INVALID_ALCHEMY_EVENT", "Expected ADDRESS_ACTIVITY webhook event.");
    }

    const network = payload.event?.network;
    const activities = payload.event?.activity;

    if (!network || !Array.isArray(activities)) {
      throw new AppError(400, "INVALID_ALCHEMY_EVENT", "Alchemy activity payload is invalid.");
    }

    const chainId = this.networkChainIds[network];

    if (!chainId) {
      throw new AppError(400, "UNSUPPORTED_ALCHEMY_NETWORK", "Alchemy network is not configured.");
    }

    let savedEvents = 0;
    let ignoredActivities = 0;

    for (const activity of activities) {
      const normalized = this.normalizeActivity(activity);

      if (!normalized) {
        ignoredActivities += 1;
        continue;
      }

      const savedForActivity = await this.saveMatchedEvents({
        chainId,
        network,
        normalized,
        observedAt: payload.createdAt
      });

      if (savedForActivity === 0) {
        ignoredActivities += 1;
      }

      savedEvents += savedForActivity;
    }

    return {
      processedActivities: activities.length,
      savedEvents,
      ignoredActivities
    };
  }

  private async saveMatchedEvents(input: {
    chainId: number;
    network: string;
    normalized: NormalizedAlchemyActivity;
    observedAt?: string;
  }): Promise<number> {
    const toAccount = await this.store.getWalletAccountByAddress(
      input.chainId,
      input.normalized.toAddress
    );

    if (toAccount) {
      await this.saveEvent({
        account: toAccount,
        direction: "incoming",
        ...input
      });
      return 1;
    }

    return 0;
  }

  private async saveEvent(input: {
    account: WalletAccountRecord;
    chainId: number;
    network: string;
    normalized: NormalizedAlchemyActivity;
    observedAt?: string;
    direction: AccountTransactionEventDirection;
  }) {
    await this.store.upsertWalletAccountTransactionEvent({
      accountId: input.account.id,
      chainId: input.chainId,
      network: input.network,
      direction: input.direction,
      asset: input.normalized.asset,
      fromAddress: input.normalized.fromAddress,
      toAddress: input.normalized.toAddress,
      amountRaw: input.normalized.amountRaw,
      txHash: input.normalized.txHash,
      logIndex: input.normalized.logIndex,
      blockNumber: input.normalized.blockNumber,
      blockHash: input.normalized.blockHash,
      status: input.normalized.status,
      source: "alchemy_address_activity",
      eventKey: this.eventKey(input),
      observedAt: input.observedAt
    });
  }

  private normalizeActivity(
    activity: AlchemyAddressActivityItem
  ): NormalizedAlchemyActivity | undefined {
    const category = activity.category?.toLowerCase();

    if (!category) {
      return undefined;
    }

    const fromAddress = this.normalizeAddress(activity.fromAddress);
    const toAddress = this.normalizeAddress(activity.toAddress);
    const txHash = activity.hash?.toLowerCase();

    if (!fromAddress || !toAddress || !txHash) {
      return undefined;
    }

    const asset = this.normalizeAsset(activity, category);

    if (!asset) {
      return undefined;
    }

    const amountRaw = this.normalizeRawAmount(activity, asset);

    if (!amountRaw) {
      return undefined;
    }

    const logIndex = activity.log?.logIndex?.toLowerCase() ?? undefined;
    const blockNumber = this.hexToDecimalString(activity.log?.blockNumber ?? activity.blockNum);
    const blockHash = activity.log?.blockHash?.toLowerCase() ?? undefined;
    const status = activity.log?.removed === true ? "removed" : "confirmed";

    return {
      asset,
      fromAddress,
      toAddress,
      amountRaw,
      txHash,
      logIndex,
      blockNumber,
      blockHash,
      status,
      eventIdentity: logIndex ?? activity.typeTraceAddress ?? category
    };
  }

  private normalizeAsset(
    activity: AlchemyAddressActivityItem,
    category: string
  ): TransferAssetInput | undefined {
    if (category === "external" || category === "internal") {
      return {
        type: "native"
      };
    }

    if (category !== "erc20" && category !== "token") {
      return undefined;
    }

    if (activity.erc721TokenId || activity.erc1155Metadata) {
      return undefined;
    }

    const tokenAddress = this.normalizeAddress(
      activity.rawContract?.address ?? activity.log?.address
    );

    if (!tokenAddress || !activity.rawContract?.rawValue) {
      return undefined;
    }

    return {
      type: "erc20",
      tokenAddress
    };
  }

  private normalizeRawAmount(
    activity: AlchemyAddressActivityItem,
    asset: TransferAssetInput
  ): string | undefined {
    const rawValue = activity.rawContract?.rawValue;

    if (rawValue) {
      return this.rawHexToDecimalString(rawValue);
    }

    if (asset.type !== "native" || activity.value === null || activity.value === undefined) {
      return undefined;
    }

    return parseUnits(String(activity.value), 18).toString();
  }

  private normalizeAddress(address: string | null | undefined): string | undefined {
    if (!address) {
      return undefined;
    }

    try {
      return getAddress(address).toLowerCase();
    } catch {
      return undefined;
    }
  }

  private rawHexToDecimalString(value: string): string {
    if (value === "0x") {
      return "0";
    }

    return BigInt(value).toString();
  }

  private hexToDecimalString(value: string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    return BigInt(value).toString();
  }

  private eventKey(input: {
    account: WalletAccountRecord;
    direction: AccountTransactionEventDirection;
    network: string;
    normalized: NormalizedAlchemyActivity;
  }): string {
    return [
      input.network.toLowerCase(),
      input.account.id,
      input.direction,
      input.normalized.txHash,
      input.normalized.eventIdentity
    ].join(":");
  }
}
