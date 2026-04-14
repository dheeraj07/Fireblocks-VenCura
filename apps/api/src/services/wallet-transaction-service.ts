import { createHash } from "node:crypto";

import { Wallet, getAddress, hashMessage } from "ethers";

import { AppError } from "../lib/errors";
import { normalizeTransferAsset, normalizeAddress, normalizeAmount } from "../lib/asset-validators";
import { LockManager } from "../lib/lock-manager";
import type { AppStore } from "../store/store";
import type { TransferAssetInput } from "../types";
import { BlockchainService } from "./blockchain-service";
import type { HdWalletService } from "./hd-wallet-service";

export class WalletTransactionService {
  private readonly transferLock = new LockManager();
  private readonly supportedErc20Tokens: Set<string>;

  constructor(
    private readonly store: AppStore,
    private readonly hdWalletService: HdWalletService,
    private readonly blockchainService: BlockchainService,
    private readonly transactionHistoryNetwork: string,
    supportedErc20Tokens: string[]
  ) {
    this.supportedErc20Tokens = new Set(
      supportedErc20Tokens.map((token) => getAddress(token).toLowerCase())
    );
  }

  async signMessage(input: {
    userId: string;
    accountId: string;
    message: string;
    idempotencyKey: string;
  }) {
    const account = await this.hdWalletService.getOwnedAccount(input.userId, input.accountId);
    const payloadHash = this.hashPayload("sign-message", { message: input.message });

    const existing = await this.store.getWalletAccountSignRequest(account.id, input.idempotencyKey);

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different payload.");
      }
      return { requestId: existing.id, signature: existing.signature };
    }

    const signer = new Wallet(await this.hdWalletService.derivePrivateKey(input.userId, account));
    const signature = signer.signMessageSync(input.message);
    const record = await this.store.saveWalletAccountSignRequest({
      accountId: account.id,
      actorUserId: input.userId,
      messageHash: hashMessage(input.message),
      signature,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      status: "completed"
    });

    return { requestId: record.id, signature };
  }

  async sendTransaction(input: {
    userId: string;
    accountId: string;
    to: string;
    amount: string;
    asset: TransferAssetInput;
    idempotencyKey: string;
  }) {
    const account = await this.hdWalletService.getOwnedAccount(input.userId, input.accountId);
    const toAddress = normalizeAddress(input.to);
    normalizeAmount(input.amount);
    const asset = normalizeTransferAsset(input.asset, this.supportedErc20Tokens);
    const payloadHash = this.hashPayload("send-transaction", {
      to: toAddress,
      amount: input.amount,
      asset
    });

    const existing = await this.store.getWalletAccountTransactionEventByIdempotencyKey(
      account.id,
      input.idempotencyKey
    );

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different payload.");
      }
      return { transactionId: existing.id, txHash: existing.txHash, status: existing.status };
    }

    return this.transferLock.withLock(account.id, async () => {
      const lockedExisting = await this.store.getWalletAccountTransactionEventByIdempotencyKey(
        account.id,
        input.idempotencyKey
      );

      if (lockedExisting) {
        if (lockedExisting.payloadHash !== payloadHash) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different payload.");
        }
        return { transactionId: lockedExisting.id, txHash: lockedExisting.txHash, status: lockedExisting.status };
      }

      const localNextNonce = (await this.store.getNextAccountNonce(account.id)) ?? 0;
      const chainNonce = await this.blockchainService.getPendingNonce(account.address);
      const nonce = Math.max(localNextNonce, chainNonce);
      const privateKey = await this.hdWalletService.derivePrivateKey(input.userId, account);

      try {
        const result =
          asset.type === "native"
            ? await this.blockchainService.sendNativeTransaction({ privateKey, to: toAddress, amount: input.amount, nonce })
            : await this.blockchainService.sendErc20Transaction({ privateKey, tokenAddress: asset.tokenAddress, to: toAddress, amount: input.amount, nonce });

        await this.store.setNextAccountNonce(account.id, nonce + 1);

        const event = await this.store.upsertWalletAccountTransactionEvent({
          accountId: account.id,
          chainId: account.chainId,
          network: this.transactionHistoryNetwork,
          direction: "outgoing",
          asset,
          fromAddress: account.address,
          toAddress: toAddress.toLowerCase(),
          amountRaw: input.amount,
          txHash: result.txHash,
          nonce: result.nonce,
          status: "broadcasted",
          source: "api_send",
          eventKey: this.apiSendEventKey(account.id, result.txHash),
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          observedAt: new Date().toISOString()
        });

        return { transactionId: event.id, txHash: event.txHash, status: event.status };
      } catch (error) {
        throw new AppError(
          400,
          "TRANSACTION_FAILED",
          error instanceof Error ? error.message : "Failed to send transaction."
        );
      }
    });
  }

  private hashPayload(action: string, data: Record<string, unknown>): string {
    return createHash("sha256")
      .update(JSON.stringify({ action, ...data }))
      .digest("hex");
  }

  private apiSendEventKey(accountId: string, txHash: string): string {
    return ["api-send", accountId, txHash.toLowerCase()].join(":");
  }
}
