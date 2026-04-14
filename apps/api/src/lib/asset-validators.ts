import { getAddress } from "ethers";

import { AppError } from "./errors";
import type { TransferAssetInput } from "../types";

export function normalizeTransferAsset(
  asset: TransferAssetInput,
  supportedErc20Tokens: Set<string>
): TransferAssetInput {
  if (asset.type === "native") {
    return asset;
  }

  let tokenAddress: string;

  try {
    tokenAddress = getAddress(asset.tokenAddress).toLowerCase();
  } catch {
    throw new AppError(400, "INVALID_TOKEN_ADDRESS", "Token address is invalid.");
  }

  if (!supportedErc20Tokens.has(tokenAddress)) {
    throw new AppError(400, "UNSUPPORTED_TOKEN", "Token is not supported.");
  }

  return {
    type: "erc20",
    tokenAddress
  };
}

export function normalizeAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    throw new AppError(400, "INVALID_ADDRESS", "Recipient address is invalid.");
  }
}

export function normalizeAmount(amount: string): string {
  if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new AppError(400, "INVALID_AMOUNT", "Amount must be greater than zero.");
  }

  return BigInt(amount).toString();
}

export function assetKey(asset: TransferAssetInput): string {
  return asset.type === "native" ? "native" : `erc20:${asset.tokenAddress}`;
}
