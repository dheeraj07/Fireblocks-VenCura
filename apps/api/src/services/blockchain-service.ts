import {
  Contract,
  Wallet,
  formatUnits,
  getAddress,
  type Provider,
  type TransactionReceipt
} from "ethers";

const erc20TransferAbi = ["function transfer(address to, uint256 value) returns (bool)"];
const erc20BalanceAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

interface Erc20Balance {
  tokenAddress: string;
  raw: string;
  formatted: string;
  symbol: string;
  decimals: number;
}

export class BlockchainService {
  constructor(private readonly provider: Provider) {}

  async getNativeBalance(address: string): Promise<string> {
    const balance = await this.provider.getBalance(getAddress(address));
    return balance.toString();
  }

  formatBalance(raw: string, decimals: number): string {
    return formatUnits(BigInt(raw), decimals);
  }

  async getErc20Balance(tokenAddress: string, ownerAddress: string): Promise<Erc20Balance> {
    const normalizedTokenAddress = getAddress(tokenAddress).toLowerCase();
    const token = new Contract(normalizedTokenAddress, erc20BalanceAbi, this.provider);
    const [raw, decimals, symbol] = await Promise.all([
      token.balanceOf(getAddress(ownerAddress)),
      token.decimals(),
      token.symbol()
    ]);
    const normalizedDecimals = Number(decimals);
    const rawString = raw.toString();

    return {
      tokenAddress: normalizedTokenAddress,
      raw: rawString,
      formatted: this.formatBalance(rawString, normalizedDecimals),
      symbol: String(symbol),
      decimals: normalizedDecimals
    };
  }

  async getErc20TokenInfo(tokenAddress: string): Promise<{ tokenAddress: string; symbol: string; decimals: number }> {
    const normalizedTokenAddress = getAddress(tokenAddress).toLowerCase();
    const token = new Contract(normalizedTokenAddress, erc20BalanceAbi, this.provider);
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);

    return {
      tokenAddress: normalizedTokenAddress,
      symbol: String(symbol),
      decimals: Number(decimals)
    };
  }

  async getPendingNonce(address: string): Promise<number> {
    return this.provider.getTransactionCount(getAddress(address), "pending");
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
    return this.provider.getTransactionReceipt(txHash);
  }

  async getBlockTimestamp(blockNumber: number): Promise<string | null> {
    const block = await this.provider.getBlock(blockNumber);

    if (!block) {
      return null;
    }

    return new Date(block.timestamp * 1000).toISOString();
  }

  async sendNativeTransaction(input: {
    privateKey: string;
    to: string;
    amount: string;
    nonce: number;
  }): Promise<{ txHash: string; nonce: string }> {
    const signer = new Wallet(input.privateKey, this.provider);
    const response = await signer.sendTransaction({
      to: getAddress(input.to),
      value: BigInt(input.amount),
      nonce: input.nonce
    });

    return {
      txHash: response.hash,
      nonce: response.nonce.toString()
    };
  }

  async sendErc20Transaction(input: {
    privateKey: string;
    tokenAddress: string;
    to: string;
    amount: string;
    nonce: number;
  }): Promise<{ txHash: string; nonce: string }> {
    const signer = new Wallet(input.privateKey, this.provider);
    const token = new Contract(getAddress(input.tokenAddress), erc20TransferAbi, signer);
    const response = await token.transfer(getAddress(input.to), BigInt(input.amount), {
      nonce: input.nonce
    });

    return {
      txHash: response.hash,
      nonce: response.nonce.toString()
    };
  }
}
