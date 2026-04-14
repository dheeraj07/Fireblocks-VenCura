import { AppError } from "../lib/errors";
import type { AppStore } from "../store/store";
import type { WalletAccountTransactionEventRecord } from "../types";
import { BlockchainService } from "./blockchain-service";

export class TransactionService {
  constructor(
    private readonly store: AppStore,
    private readonly blockchainService: BlockchainService
  ) {}

  async getTransactionByTxHash(userId: string, txHash: string) {
    const event = await this.store.getWalletAccountTransactionEventByTxHash(txHash);

    if (!event) {
      throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found.");
    }

    const account = await this.store.getWalletAccountById(event.accountId);

    if (!account || account.userId !== userId) {
      throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found.");
    }

    const reconciled = await this.reconcileEvent(event);
    return this.toTransactionEventResponse(reconciled);
  }

  async listAccountTransactionEvents(userId: string, accountId: string, limit: number) {
    const account = await this.store.getWalletAccountById(accountId);

    if (!account || account.userId !== userId) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
    }

    const events = await this.reconcileApiSendEvents(
      await this.store.listWalletAccountTransactionEvents(account.id, limit)
    );

    return {
      accountId: account.id,
      transactions: events.map((event) => this.toTransactionEventResponse(event))
    };
  }

  async listUserTransactionEvents(userId: string, input: { accountId?: string; limit: number }) {
    if (input.accountId) {
      return this.listAccountTransactionEvents(userId, input.accountId, input.limit);
    }

    const events = await this.reconcileApiSendEvents(
      await this.store.listWalletAccountTransactionEventsByUserId(userId, input.limit)
    );

    return {
      transactions: events.map((event) => this.toTransactionEventResponse(event))
    };
  }

  private toTransactionEventResponse(event: WalletAccountTransactionEventRecord) {
    return {
      eventId: event.id,
      accountId: event.accountId,
      chainId: event.chainId,
      network: event.network,
      direction: event.direction,
      asset: event.asset,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
      amountRaw: event.amountRaw,
      txHash: event.txHash,
      logIndex: event.logIndex ?? null,
      nonce: event.nonce ?? null,
      blockNumber: event.blockNumber ?? null,
      blockHash: event.blockHash ?? null,
      status: event.status,
      source: event.source,
      idempotencyKey: event.idempotencyKey ?? null,
      errorCode: event.errorCode ?? null,
      observedAt: event.observedAt ?? null,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt
    };
  }

  private async reconcileApiSendEvents(
    events: WalletAccountTransactionEventRecord[]
  ): Promise<WalletAccountTransactionEventRecord[]> {
    return Promise.all(events.map((event) => this.reconcileEvent(event)));
  }

  private async reconcileEvent(
    event: WalletAccountTransactionEventRecord
  ): Promise<WalletAccountTransactionEventRecord> {
    if (event.source !== "api_send" || event.status !== "broadcasted") {
      return event;
    }

    const receipt = await this.blockchainService.getTransactionReceipt(event.txHash);

    if (!receipt) {
      return event;
    }

    const nextStatus = receipt.status === 1 ? "confirmed" : "failed";
    const nextErrorCode = nextStatus === "failed" ? "ONCHAIN_REVERT" : undefined;
    const observedAt = await this.blockchainService.getBlockTimestamp(receipt.blockNumber);

    return this.store.upsertWalletAccountTransactionEvent({
      accountId: event.accountId,
      chainId: event.chainId,
      network: event.network,
      direction: event.direction,
      asset: event.asset,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
      amountRaw: event.amountRaw,
      txHash: event.txHash,
      logIndex: event.logIndex,
      nonce: event.nonce,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: nextStatus,
      source: event.source,
      eventKey: event.eventKey,
      idempotencyKey: event.idempotencyKey,
      payloadHash: event.payloadHash,
      errorCode: nextErrorCode,
      observedAt: observedAt ?? event.observedAt
    });
  }
}
