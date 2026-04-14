import type { Provider } from "ethers";
import type { AppStore } from "./store/store";
import type { AccountAddressRegistrar } from "./services/account-address-registrar";

export interface AppConfig {
  jwtSecret: string;
  encryptionSecret: string;
  chainId: number;
  supportedErc20Tokens: string[];
  databaseUrl?: string;
  rpcUrl: string;
  host: string;
  port: number;
  alchemyWebhookSigningKey?: string;
  alchemyWebhookId?: string;
  alchemyWebhookNetwork: string;
  alchemyWebhookChainId: number;
  alchemyNotifyAuthToken?: string;
  alchemyWebhookUpdateUrl: string;
  transactionHistoryNetwork: string;
}

export interface AppDependencies {
  config: Partial<AppConfig>;
  store: AppStore;
  provider: Provider;
  accountAddressRegistrar?: AccountAddressRegistrar;
}

export function defaultConfig(): AppConfig {
  const chainId = Number(process.env.CHAIN_ID ?? 31337);

  return {
    jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret",
    encryptionSecret: process.env.ENCRYPTION_SECRET ?? "dev-encryption-secret",
    chainId,
    supportedErc20Tokens: (process.env.ERC20_TOKEN_ALLOWLIST ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
    databaseUrl: process.env.DATABASE_URL,
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    alchemyWebhookSigningKey: process.env.ALCHEMY_WEBHOOK_SIGNING_KEY,
    alchemyWebhookId: process.env.ALCHEMY_WEBHOOK_ID,
    alchemyWebhookNetwork: process.env.ALCHEMY_WEBHOOK_NETWORK ?? "ETH_MAINNET",
    alchemyWebhookChainId: Number(process.env.ALCHEMY_WEBHOOK_CHAIN_ID ?? chainId),
    alchemyNotifyAuthToken: process.env.ALCHEMY_NOTIFY_AUTH_TOKEN,
    alchemyWebhookUpdateUrl:
      process.env.ALCHEMY_WEBHOOK_UPDATE_URL ??
      "https://dashboard.alchemy.com/api/update-webhook-addresses",
    transactionHistoryNetwork:
      process.env.TRANSACTION_HISTORY_NETWORK ??
      process.env.ALCHEMY_WEBHOOK_NETWORK ??
      `CHAIN_${chainId}`
  };
}
