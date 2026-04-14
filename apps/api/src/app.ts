import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { JsonRpcProvider } from "ethers";
import { ZodError } from "zod";

import { AesGcmEncryptionService } from "./lib/crypto";
import { AppError, isAppError } from "./lib/errors";
import { MysqlStore } from "./store/mysql-store";
import type { AppStore } from "./store/store";
import {
  AlchemyWebhookAddressRegistrar,
  type AccountAddressRegistrar
} from "./services/account-address-registrar";
import {
  AlchemyTransactionHistoryService,
  type AlchemyAddressActivityPayload
} from "./services/alchemy-transaction-history-service";
import { AccountSharingService } from "./services/account-sharing-service";
import { AuthService } from "./services/auth-service";
import { BlockchainService } from "./services/blockchain-service";
import { HdWalletService } from "./services/hd-wallet-service";
import { PolicyService } from "./services/policy-service";
import { SpendRequestService } from "./services/spend-request-service";
import { TransactionService } from "./services/transaction-service";
import { WalletTransactionService } from "./services/wallet-transaction-service";
import type { AuthTokenPayload, UserRecord } from "./types";
import { type AppConfig, type AppDependencies, defaultConfig } from "./config";
import { parseSchema } from "./middleware";
import {
  registerSchema,
  loginSchema,
  accountParamsSchema,
  accountShareParamsSchema,
  spendRequestParamsSchema,
  policyParamsSchema,
  transactionHashParamsSchema,
  transactionHistoryQuerySchema,
  accountTransactionHistoryQuerySchema,
  createAccountSchema,
  createAccountShareSchema,
  updateAccountShareSchema,
  createPolicySchema,
  updatePolicySchema,
  spendRequestDecisionSchema,
  signMessageSchema,
  sendTransactionSchema
} from "./schemas";

export function createApp(overrides: Partial<AppDependencies> = {}): FastifyInstance {
  const config: AppConfig = {
    ...defaultConfig(),
    ...overrides.config
  };
  const store: AppStore = overrides.store ?? createMysqlStore(config.databaseUrl);

  const authService = new AuthService(config.jwtSecret);
  const encryptionService = new AesGcmEncryptionService(config.encryptionSecret);
  const provider = overrides.provider ?? new JsonRpcProvider(config.rpcUrl);
  const blockchainService = new BlockchainService(provider);
  const accountAddressRegistrar =
    overrides.accountAddressRegistrar ?? createAccountAddressRegistrar(config);
  const hdWalletService = new HdWalletService(
    store,
    encryptionService,
    blockchainService,
    config.chainId,
    config.supportedErc20Tokens,
    accountAddressRegistrar
  );
  const walletTransactionService = new WalletTransactionService(
    store,
    hdWalletService,
    blockchainService,
    config.transactionHistoryNetwork,
    config.supportedErc20Tokens
  );
  const transactionService = new TransactionService(store, blockchainService);
  const accountSharingService = new AccountSharingService(store);
  const spendRequestService = new SpendRequestService(
    store,
    walletTransactionService,
    config.supportedErc20Tokens
  );
  const policyService = new PolicyService(store, config.supportedErc20Tokens);
  const alchemyTransactionHistoryService = new AlchemyTransactionHistoryService(store, {
    [config.alchemyWebhookNetwork]: config.alchemyWebhookChainId
  });

  const app = Fastify({
    logger: false
  });

  app.addHook("onReady", async () => {
    await store.initialize();
  });

  app.addHook("onClose", async () => {
    await store.close();
  });

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!isAlchemyAddressActivityWebhookRequest(request)) {
      return payload;
    }

    const rawBody = await readRawBody(payload);
    request.rawBody = rawBody;

    return Readable.from([rawBody]);
  });

  async function authenticate(request: FastifyRequest): Promise<UserRecord> {
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHORIZED", "Missing bearer token.");
    }

    const token = authorization.slice("Bearer ".length);
    const payload: AuthTokenPayload = await authService.verifyToken(token);
    const user = await store.getUserById(payload.sub);

    if (!user) {
      throw new AppError(401, "UNAUTHORIZED", "Authenticated user no longer exists.");
    }

    return user;
  }

  app.get("/health", async () => ({
    status: "ok"
  }));

  let cachedTokens: { tokenAddress: string; symbol: string; decimals: number }[] | undefined;

  app.get("/v1/tokens", async () => {
    if (cachedTokens) {
      return { tokens: cachedTokens };
    }

    cachedTokens = await Promise.all(
      config.supportedErc20Tokens.map((addr) => blockchainService.getErc20TokenInfo(addr))
    );

    return { tokens: cachedTokens };
  });

  app.post("/v1/auth/register", async (request, reply) => {
    const body = parseSchema(registerSchema, request.body);
    const passwordHash = await authService.hashPassword(body.password);
    const user = await store.createUser(body.email, passwordHash);
    await hdWalletService.createRootForUser(user);
    const token = await authService.issueToken(user);

    return reply.code(201).send({
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });
  });

  app.post("/v1/auth/login", async (request) => {
    const body = parseSchema(loginSchema, request.body);
    const user = await store.findUserByEmail(body.email);

    if (!user || !(await authService.verifyPassword(body.password, user.passwordHash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    }

    const token = await authService.issueToken(user);

    return {
      token,
      user: {
        id: user.id,
        email: user.email
      }
    };
  });

  app.get("/v1/auth/me", async (request) => {
    const user = await authenticate(request);

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt
      }
    };
  });

  app.post("/v1/policies", async (request, reply) => {
    const user = await authenticate(request);
    const body = parseSchema(createPolicySchema, request.body);
    const policy = await policyService.createPolicy({
      ownerUserId: user.id,
      name: body.name,
      rules: body.rules
    });

    return reply.code(201).send(policy);
  });

  app.get("/v1/policies", async (request) => {
    const user = await authenticate(request);

    return policyService.listPolicies(user.id);
  });

  app.post("/v1/policies/:policyId/update", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(policyParamsSchema, request.params);
    const body = parseSchema(updatePolicySchema, request.body);

    return policyService.updatePolicy({
      ownerUserId: user.id,
      policyId: params.policyId,
      name: body.name,
      rules: body.rules
    });
  });

  app.get("/v1/accounts", async (request) => {
    const user = await authenticate(request);
    const [ownedAccounts, sharedAccounts] = await Promise.all([
      hdWalletService.listAccounts(user.id),
      accountSharingService.listSharedAccounts(user.id)
    ]);

    return {
      accounts: [...ownedAccounts.accounts, ...sharedAccounts.accounts]
    };
  });

  app.post("/v1/accounts", async (request, reply) => {
    const user = await authenticate(request);
    const body = parseSchema(createAccountSchema, request.body);
    const account = await hdWalletService.createAccount(user, body.name);

    return reply.code(201).send(account);
  });

  app.get("/v1/accounts/:accountId/balances", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);
    return hdWalletService.getBalances(user.id, params.accountId);
  });

  app.get("/v1/accounts/:accountId/transactions", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);
    const query = parseSchema(accountTransactionHistoryQuerySchema, request.query);

    return transactionService.listAccountTransactionEvents(
      user.id,
      params.accountId,
      query.limit ?? 50
    );
  });

  app.post("/v1/accounts/:accountId/shares", async (request, reply) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);
    const body = parseSchema(createAccountShareSchema, request.body);
    const share = await accountSharingService.createShare({
      ownerUserId: user.id,
      accountId: params.accountId,
      sharedUserId: body.userId,
      policyIds: body.policyIds ?? []
    });

    return reply.code(201).send(share);
  });

  app.get("/v1/accounts/:accountId/shares", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);

    return accountSharingService.listShares(user.id, params.accountId);
  });

  app.post("/v1/accounts/:accountId/shares/:shareId/update", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(accountShareParamsSchema, request.params);
    const body = parseSchema(updateAccountShareSchema, request.body);

    return accountSharingService.updateShare({
      ownerUserId: user.id,
      accountId: params.accountId,
      shareId: params.shareId,
      status: body.status,
      policyIds: body.policyIds
    });
  });

  app.post("/v1/accounts/:accountId/shared-spend-requests", async (request, reply) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);
    const body = parseSchema(sendTransactionSchema, request.body);
    const spendRequest = await spendRequestService.createSpendRequest({
      requesterUserId: user.id,
      accountId: params.accountId,
      to: body.to,
      amount: body.amount,
      asset: body.asset,
      idempotencyKey: body.idempotencyKey
    });

    return reply.code(spendRequest.status === "pending" ? 202 : 200).send(spendRequest);
  });

  app.post("/v1/accounts/:accountId/sign-message", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);
    const body = parseSchema(signMessageSchema, request.body);

    return walletTransactionService.signMessage({
      userId: user.id,
      accountId: params.accountId,
      message: body.message,
      idempotencyKey: body.idempotencyKey
    });
  });

  app.post("/v1/accounts/:accountId/send-transaction", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(accountParamsSchema, request.params);
    const body = parseSchema(sendTransactionSchema, request.body);

    return walletTransactionService.sendTransaction({
      userId: user.id,
      accountId: params.accountId,
      to: body.to,
      amount: body.amount,
      asset: body.asset,
      idempotencyKey: body.idempotencyKey
    });
  });

  app.get("/v1/spend-requests", async (request) => {
    const user = await authenticate(request);

    return spendRequestService.listSpendRequests(user.id);
  });

  app.post("/v1/spend-requests/:spendRequestId/decision", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(spendRequestParamsSchema, request.params);
    const body = parseSchema(spendRequestDecisionSchema, request.body);

    return spendRequestService.decideSpendRequest({
      ownerUserId: user.id,
      spendRequestId: params.spendRequestId,
      decision: body.decision
    });
  });

  app.get("/v1/transactions", async (request) => {
    const user = await authenticate(request);
    const query = parseSchema(transactionHistoryQuerySchema, request.query);

    return transactionService.listUserTransactionEvents(user.id, {
      accountId: query.accountId,
      limit: query.limit ?? 50
    });
  });

  app.get("/v1/transactions/hash/:txHash", async (request) => {
    const user = await authenticate(request);
    const params = parseSchema(transactionHashParamsSchema, request.params);
    return transactionService.getTransactionByTxHash(user.id, params.txHash);
  });

  app.post("/v1/webhooks/alchemy/address-activity", async (request) => {
    if (!config.alchemyWebhookSigningKey) {
      throw new AppError(
        503,
        "ALCHEMY_WEBHOOK_NOT_CONFIGURED",
        "Alchemy webhook signing key is not configured."
      );
    }

    const signature = getHeaderValue(request.headers["x-alchemy-signature"]);

    if (
      !signature ||
      !request.rawBody ||
      !verifyAlchemySignature(request.rawBody, signature, config.alchemyWebhookSigningKey)
    ) {
      throw new AppError(401, "INVALID_ALCHEMY_SIGNATURE", "Alchemy signature is invalid.");
    }

    const body = request.body as AlchemyAddressActivityPayload;

    if (config.alchemyWebhookId && body.webhookId !== config.alchemyWebhookId) {
      throw new AppError(401, "INVALID_ALCHEMY_WEBHOOK", "Alchemy webhook id is invalid.");
    }

    return alchemyTransactionHistoryService.ingestAddressActivity(body);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          details: error.flatten()
        }
      });
    }

    if (isAppError(error)) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? null
        }
      });
    }

    return reply.status(500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred."
      }
    });
  });

  return app;
}

function createMysqlStore(databaseUrl?: string): AppStore {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when no store override is provided.");
  }

  return new MysqlStore({
    connectionString: databaseUrl
  });
}

function createAccountAddressRegistrar(config: AppConfig): AccountAddressRegistrar | undefined {
  if (!config.alchemyNotifyAuthToken || !config.alchemyWebhookId) {
    return undefined;
  }

  return new AlchemyWebhookAddressRegistrar({
    authToken: config.alchemyNotifyAuthToken,
    webhookId: config.alchemyWebhookId,
    updateUrl: config.alchemyWebhookUpdateUrl
  });
}

function isAlchemyAddressActivityWebhookRequest(request: FastifyRequest): boolean {
  return (
    request.method === "POST" &&
    request.url.split("?")[0] === "/v1/webhooks/alchemy/address-activity"
  );
}

async function readRawBody(payload: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of payload) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function verifyAlchemySignature(
  rawBody: Buffer,
  signature: string,
  signingKey: string
): boolean {
  const expectedSignature = createHmac("sha256", signingKey).update(rawBody).digest("hex");
  let signatureBuffer: Buffer;

  try {
    signatureBuffer = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  return (
    signatureBuffer.length === expectedBuffer.length &&
    timingSafeEqual(signatureBuffer, expectedBuffer)
  );
}
