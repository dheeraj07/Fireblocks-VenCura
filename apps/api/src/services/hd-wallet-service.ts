import { HDNodeWallet, getAddress } from "ethers";

import { AesGcmEncryptionService } from "../lib/crypto";
import { AppError } from "../lib/errors";
import type { AppStore } from "../store/store";
import type { TransferAssetInput, UserRecord, WalletAccountRecord } from "../types";
import type { AccountAddressRegistrar } from "./account-address-registrar";
import { BlockchainService } from "./blockchain-service";

const DEFAULT_ACCOUNT_NAME = "Main";
const DEFAULT_ACCOUNT_INDEX = 0;

export class HdWalletService {
  private readonly supportedErc20Tokens: Set<string>;

  constructor(
    private readonly store: AppStore,
    private readonly encryptionService: AesGcmEncryptionService,
    private readonly blockchainService: BlockchainService,
    private readonly chainId: number,
    supportedErc20Tokens: string[],
    private readonly accountAddressRegistrar?: AccountAddressRegistrar
  ) {
    this.supportedErc20Tokens = new Set(
      supportedErc20Tokens.map((token) => getAddress(token).toLowerCase())
    );
  }

  async createRootForUser(user: UserRecord) {
    const existingRoot = await this.store.getHdWalletRootByUserId(user.id);

    if (existingRoot) {
      const existingAccounts = await this.store.listWalletAccountsByWalletRootId(existingRoot.id);

      return {
        walletRoot: existingRoot,
        defaultAccount: existingAccounts[0]
      };
    }

    const rootWallet = HDNodeWallet.createRandom();
    const rootPhrase = rootWallet.mnemonic?.phrase;

    if (!rootPhrase) {
      throw new Error("Failed to generate HD wallet mnemonic.");
    }

    const derivationPath = this.derivationPath(DEFAULT_ACCOUNT_INDEX);
    const defaultAccountWallet = HDNodeWallet.fromPhrase(rootPhrase, undefined, derivationPath);
    const walletRoot = await this.store.createHdWalletRoot({
      userId: user.id,
      custodyType: "local_hd",
      encryptedRootSecret: this.encryptionService.encrypt(rootPhrase),
      nextAccountIndex: DEFAULT_ACCOUNT_INDEX + 1
    });
    const defaultAccount = await this.store.createWalletAccount({
      walletRootId: walletRoot.id,
      userId: user.id,
      name: DEFAULT_ACCOUNT_NAME,
      chainId: this.chainId,
      accountIndex: DEFAULT_ACCOUNT_INDEX,
      derivationPath,
      address: defaultAccountWallet.address
    });

    await this.registerAccountAddress(defaultAccount);

    return {
      walletRoot,
      defaultAccount
    };
  }

  async listAccounts(userId: string) {
    const walletRoot = await this.store.getHdWalletRootByUserId(userId);

    if (!walletRoot) {
      return { accounts: [] };
    }

    const accounts = await this.store.listWalletAccountsByWalletRootId(walletRoot.id);

    return {
      accounts: accounts.map((account) => this.toAccountResponse(account))
    };
  }

  async createAccount(user: UserRecord, name: string) {
    await this.createRootForUser(user);
    const normalizedName = name.trim();

    if (!normalizedName) {
      throw new AppError(400, "INVALID_ACCOUNT_NAME", "Account name is required.");
    }

    const latestRoot = await this.store.getHdWalletRootByUserId(user.id);

    if (!latestRoot) {
      throw new AppError(404, "HD_WALLET_NOT_FOUND", "HD wallet root not found.");
    }

    const existingAccounts = await this.store.listWalletAccountsByWalletRootId(latestRoot.id);

    if (existingAccounts.some((a) => a.name.toLowerCase() === normalizedName.toLowerCase())) {
      throw new AppError(409, "DUPLICATE_ACCOUNT_NAME", "An account with that name already exists.");
    }

    const accountIndex = latestRoot.nextAccountIndex;
    const derivationPath = this.derivationPath(accountIndex);
    const rootPhrase = this.encryptionService.decrypt(latestRoot.encryptedRootSecret);
    const derivedWallet = HDNodeWallet.fromPhrase(rootPhrase, undefined, derivationPath);
    const account = await this.store.createWalletAccount({
      walletRootId: latestRoot.id,
      userId: user.id,
      name: normalizedName,
      chainId: this.chainId,
      accountIndex,
      derivationPath,
      address: derivedWallet.address
    });

    await this.store.setHdWalletRootNextAccountIndex(latestRoot.id, accountIndex + 1);
    await this.registerAccountAddress(account);

    return this.toAccountResponse(account);
  }

  async getBalances(userId: string, accountId: string) {
    const account = await this.getOwnedAccount(userId, accountId);
    const [raw, erc20Balances] = await Promise.all([
      this.blockchainService.getNativeBalance(account.address),
      this.listErc20Balances(account.address)
    ]);

    const balances: Array<{
      asset: TransferAssetInput;
      raw: string;
      formatted: string;
      symbol: string;
      decimals: number;
    }> = [
      {
        asset: { type: "native" as const },
        raw,
        formatted: this.blockchainService.formatBalance(raw, 18),
        symbol: "ETH",
        decimals: 18
      }
    ];

    balances.push(...erc20Balances);

    return { accountId: account.id, balances };
  }

  async derivePrivateKey(userId: string, account: WalletAccountRecord): Promise<string> {
    const walletRoot = await this.store.getHdWalletRootByUserId(userId);

    if (!walletRoot || walletRoot.id !== account.walletRootId) {
      throw new AppError(404, "HD_WALLET_NOT_FOUND", "HD wallet root not found.");
    }

    const rootPhrase = this.encryptionService.decrypt(walletRoot.encryptedRootSecret);
    const derivedWallet = HDNodeWallet.fromPhrase(rootPhrase, undefined, account.derivationPath);

    if (getAddress(derivedWallet.address) !== getAddress(account.address)) {
      throw new AppError(500, "ACCOUNT_DERIVATION_MISMATCH", "Derived account mismatch.");
    }

    return derivedWallet.privateKey;
  }

  async getOwnedAccount(userId: string, accountId: string): Promise<WalletAccountRecord> {
    const account = await this.store.getWalletAccountById(accountId);

    if (!account || account.userId !== userId) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
    }

    return account;
  }

  private async listErc20Balances(address: string) {
    const balances = await Promise.all(
      [...this.supportedErc20Tokens].map((tokenAddress) =>
        this.blockchainService.getErc20Balance(tokenAddress, address)
      )
    );

    return balances.map((balance) => ({
      asset: { type: "erc20" as const, tokenAddress: balance.tokenAddress },
      raw: balance.raw,
      formatted: balance.formatted,
      symbol: balance.symbol,
      decimals: balance.decimals
    }));
  }

  private async registerAccountAddress(account: WalletAccountRecord): Promise<void> {
    if (!this.accountAddressRegistrar) {
      return;
    }

    try {
      console.log(`Registering address ${account.address} with webhook...`);
      await this.accountAddressRegistrar.registerAddress(account.address);
      console.log(`Successfully registered address ${account.address} with webhook.`);
    } catch (error) {
      console.error(
        `Failed to register account ${account.id} with the address activity webhook.`,
        error
      );
    }
  }

  private toAccountResponse(account: WalletAccountRecord) {
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
      accessType: "owned" as const,
      shareId: null,
      policyIds: []
    };
  }

  private derivationPath(accountIndex: number): string {
    return `m/44'/60'/${accountIndex}'/0/0`;
  }
}
