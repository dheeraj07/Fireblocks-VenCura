import { createHmac, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { parseEther } from "ethers";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { AesGcmEncryptionService } from "../src/lib/crypto";
import { AlchemyTransactionHistoryService } from "../src/services/alchemy-transaction-history-service";
import type { AppStore } from "../src/store/store";
import type { WalletAccountRecord } from "../src/types";
import { createTestMysqlStore } from "./support/test-mysql-store";

const NETWORK = "ETH_MAINNET";
const CHAIN_ID = 1;
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const FROM_ADDRESS = "0x503828976d22510aad0201ac7ec88293211d23da";
const TO_ADDRESS = "0xbe3f4b43db5eb49d1f48f53443b9abce45da3b79";
const OTHER_ADDRESS = "0x7853b3736edba9d7ce681f2a90264307694f97f2";

describe("Alchemy transaction history phase 1", () => {
  let store: AppStore;
  let service: AlchemyTransactionHistoryService;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    service = new AlchemyTransactionHistoryService(store, {
      [NETWORK]: CHAIN_ID
    });
  });

  afterEach(async () => {
    await store.close();
  });

  async function createUserWithAccounts(addresses: string[]) {
    const encryptionService = new AesGcmEncryptionService("test-encryption-secret");
    const user = await store.createUser(`${randomUUID()}@example.com`, "hash");
    const root = await store.createHdWalletRoot({
      userId: user.id,
      custodyType: "local_hd",
      encryptedRootSecret: encryptionService.encrypt("test root"),
      nextAccountIndex: addresses.length
    });
    const accounts: WalletAccountRecord[] = [];

    for (let index = 0; index < addresses.length; index += 1) {
      accounts.push(
        await store.createWalletAccount({
          walletRootId: root.id,
          userId: user.id,
          name: `Account ${index}`,
          chainId: CHAIN_ID,
          accountIndex: index,
          derivationPath: `m/44'/60'/${index}'/0/0`,
          address: addresses[index]
        })
      );
    }

    return {
      user,
      accounts
    };
  }

  function tokenPayload(toAddress = TO_ADDRESS, removed = false) {
    return {
      createdAt: "2024-09-25T13:52:47.561Z",
      event: {
        activity: [
          {
            asset: "USDC",
            blockNum: "0xdf34a3",
            category: "token",
            erc1155Metadata: null,
            erc721TokenId: null,
            fromAddress: FROM_ADDRESS,
            hash: "0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72",
            log: {
              address: USDC_ADDRESS,
              blockHash: "0xa99ec54413bd3db3f9bdb0c1ad3ab1400ee0ecefb47803e17f9d33bc4d0a1e91",
              blockNumber: "0xdf34a3",
              logIndex: "0x6e",
              removed,
              transactionHash:
                "0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72"
            },
            rawContract: {
              address: USDC_ADDRESS,
              decimals: 6,
              rawValue: "0x0000000000000000000000000000000000000000000000000000000011783b21"
            },
            toAddress,
            typeTraceAddress: null,
            value: 293.092129
          }
        ],
        network: NETWORK
      },
      id: "whevt_test",
      type: "ADDRESS_ACTIVITY",
      webhookId: "wh_test"
    };
  }

  it("normalizes an Alchemy ERC-20 incoming activity into an account transaction event", async () => {
    const { accounts } = await createUserWithAccounts([TO_ADDRESS]);

    const result = await service.ingestAddressActivity(tokenPayload());
    const events = await store.listWalletAccountTransactionEvents(accounts[0].id);

    expect(result).toEqual({
      processedActivities: 1,
      savedEvents: 1,
      ignoredActivities: 0
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: accounts[0].id,
      chainId: CHAIN_ID,
      network: NETWORK,
      direction: "incoming",
      asset: {
        type: "erc20",
        tokenAddress: USDC_ADDRESS
      },
      fromAddress: FROM_ADDRESS,
      toAddress: TO_ADDRESS,
      amountRaw: BigInt("0x11783b21").toString(),
      txHash: "0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72",
      logIndex: "0x6e",
      blockNumber: BigInt("0xdf34a3").toString(),
      blockHash: "0xa99ec54413bd3db3f9bdb0c1ad3ab1400ee0ecefb47803e17f9d33bc4d0a1e91",
      status: "confirmed",
      source: "alchemy_address_activity",
      observedAt: "2024-09-25T13:52:47.561Z"
    });
  });

  it("records native Alchemy activity only as incoming events for matched accounts", async () => {
    const { user, accounts } = await createUserWithAccounts([FROM_ADDRESS, TO_ADDRESS]);

    const result = await service.ingestAddressActivity({
      createdAt: "2024-09-25T13:52:47.561Z",
      event: {
        activity: [
          {
            asset: "ETH",
            blockNum: "0x10",
            category: "external",
            fromAddress: FROM_ADDRESS,
            hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            rawContract: {
              address: null,
              decimals: 18,
              rawValue: "0x0de0b6b3a7640000"
            },
            toAddress: TO_ADDRESS,
            value: 1
          }
        ],
        network: NETWORK
      },
      id: "whevt_native",
      type: "ADDRESS_ACTIVITY",
      webhookId: "wh_test"
    });
    const fromEvents = await store.listWalletAccountTransactionEvents(accounts[0].id);
    const toEvents = await store.listWalletAccountTransactionEvents(accounts[1].id);
    const userEvents = await store.listWalletAccountTransactionEventsByUserId(user.id);

    expect(result).toEqual({
      processedActivities: 1,
      savedEvents: 1,
      ignoredActivities: 0
    });
    expect(fromEvents).toHaveLength(0);
    expect(toEvents).toHaveLength(1);
    expect(toEvents[0]).toMatchObject({
      accountId: accounts[1].id,
      direction: "incoming",
      asset: {
        type: "native"
      },
      amountRaw: parseEther("1").toString(),
      blockNumber: "16"
    });
    expect(userEvents).toHaveLength(1);
  });

  it("idempotently updates duplicate webhook deliveries and reorg removals", async () => {
    const { accounts } = await createUserWithAccounts([TO_ADDRESS]);

    await service.ingestAddressActivity(tokenPayload(TO_ADDRESS, false));
    const firstEvents = await store.listWalletAccountTransactionEvents(accounts[0].id);

    await service.ingestAddressActivity(tokenPayload(TO_ADDRESS, false));
    const duplicateEvents = await store.listWalletAccountTransactionEvents(accounts[0].id);

    await service.ingestAddressActivity(tokenPayload(TO_ADDRESS, true));
    const removedEvents = await store.listWalletAccountTransactionEvents(accounts[0].id);

    expect(firstEvents).toHaveLength(1);
    expect(duplicateEvents).toHaveLength(1);
    expect(duplicateEvents[0].id).toBe(firstEvents[0].id);
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].id).toBe(firstEvents[0].id);
    expect(removedEvents[0].status).toBe("removed");
  });

  it("ignores unknown addresses and NFT activity", async () => {
    await createUserWithAccounts([TO_ADDRESS]);

    const result = await service.ingestAddressActivity({
      createdAt: "2024-09-25T13:52:47.561Z",
      event: {
        activity: [
          tokenPayload(OTHER_ADDRESS).event.activity[0],
          {
            ...tokenPayload(TO_ADDRESS).event.activity[0],
            erc721TokenId: "0x1"
          }
        ],
        network: NETWORK
      },
      id: "whevt_ignored",
      type: "ADDRESS_ACTIVITY",
      webhookId: "wh_test"
    });
    const account = await store.getWalletAccountByAddress(CHAIN_ID, TO_ADDRESS);
    const events = await store.listWalletAccountTransactionEvents(account?.id ?? "");

    expect(result).toEqual({
      processedActivities: 2,
      savedEvents: 0,
      ignoredActivities: 2
    });
    expect(events).toHaveLength(0);
  });
});

describe("Alchemy address activity webhook phase 2", () => {
  const signingKey = "test-alchemy-signing-key";
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        chainId: CHAIN_ID,
        alchemyWebhookSigningKey: signingKey,
        alchemyWebhookId: "wh_test",
        alchemyWebhookNetwork: NETWORK,
        alchemyWebhookChainId: CHAIN_ID,
        rpcUrl: "http://127.0.0.1:8545",
        host: "127.0.0.1",
        port: 0
      }
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createAccount(address: string) {
    const encryptionService = new AesGcmEncryptionService("test-encryption-secret");
    const user = await store.createUser(`${randomUUID()}@example.com`, "hash");
    const root = await store.createHdWalletRoot({
      userId: user.id,
      custodyType: "local_hd",
      encryptedRootSecret: encryptionService.encrypt("test root"),
      nextAccountIndex: 1
    });

    return store.createWalletAccount({
      walletRootId: root.id,
      userId: user.id,
      name: "Main",
      chainId: CHAIN_ID,
      accountIndex: 0,
      derivationPath: "m/44'/60'/0'/0/0",
      address
    });
  }

  function tokenPayload(toAddress = TO_ADDRESS) {
    return {
      createdAt: "2024-09-25T13:52:47.561Z",
      event: {
        activity: [
          {
            asset: "USDC",
            blockNum: "0xdf34a3",
            category: "token",
            erc1155Metadata: null,
            erc721TokenId: null,
            fromAddress: FROM_ADDRESS,
            hash: "0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72",
            log: {
              address: USDC_ADDRESS,
              blockHash: "0xa99ec54413bd3db3f9bdb0c1ad3ab1400ee0ecefb47803e17f9d33bc4d0a1e91",
              blockNumber: "0xdf34a3",
              logIndex: "0x6e",
              removed: false,
              transactionHash:
                "0x7a4a39da2a3fa1fc2ef88fd1eaea070286ed2aba21e0419dcfb6d5c5d9f02a72"
            },
            rawContract: {
              address: USDC_ADDRESS,
              decimals: 6,
              rawValue: "0x0000000000000000000000000000000000000000000000000000000011783b21"
            },
            toAddress,
            typeTraceAddress: null,
            value: 293.092129
          }
        ],
        network: NETWORK
      },
      id: "whevt_test",
      type: "ADDRESS_ACTIVITY",
      webhookId: "wh_test"
    };
  }

  function sign(rawBody: string, key = signingKey) {
    return createHmac("sha256", key).update(rawBody).digest("hex");
  }

  it("accepts a valid signed Alchemy webhook and stores normalized events", async () => {
    const account = await createAccount(TO_ADDRESS);
    const rawBody = JSON.stringify(tokenPayload());

    const response = await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody))
      .send(rawBody)
      .expect(200);
    const events = await store.listWalletAccountTransactionEvents(account.id);

    expect(response.body).toEqual({
      processedActivities: 1,
      savedEvents: 1,
      ignoredActivities: 0
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: account.id,
      direction: "incoming",
      source: "alchemy_address_activity"
    });
  });

  it("rejects invalid signatures before ingesting the payload", async () => {
    const account = await createAccount(TO_ADDRESS);
    const rawBody = JSON.stringify(tokenPayload());

    const response = await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody, "wrong-key"))
      .send(rawBody);
    const events = await store.listWalletAccountTransactionEvents(account.id);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_ALCHEMY_SIGNATURE");
    expect(events).toHaveLength(0);
  });

  it("rejects a valid signature from an unexpected webhook id", async () => {
    await createAccount(TO_ADDRESS);
    const rawBody = JSON.stringify({
      ...tokenPayload(),
      webhookId: "wh_other"
    });

    const response = await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody))
      .send(rawBody);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_ALCHEMY_WEBHOOK");
  });

  it("rejects webhook requests when the signing key is not configured", async () => {
    await app.close();
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        chainId: CHAIN_ID,
        alchemyWebhookSigningKey: undefined,
        alchemyWebhookId: "wh_test",
        alchemyWebhookNetwork: NETWORK,
        alchemyWebhookChainId: CHAIN_ID,
        rpcUrl: "http://127.0.0.1:8545",
        host: "127.0.0.1",
        port: 0
      }
    });
    await app.ready();

    const rawBody = JSON.stringify(tokenPayload());
    const response = await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody))
      .send(rawBody);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("ALCHEMY_WEBHOOK_NOT_CONFIGURED");
  });

  it("idempotently accepts duplicate signed webhook deliveries", async () => {
    const account = await createAccount(TO_ADDRESS);
    const rawBody = JSON.stringify(tokenPayload());

    await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody))
      .send(rawBody)
      .expect(200);
    await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody))
      .send(rawBody)
      .expect(200);

    const events = await store.listWalletAccountTransactionEvents(account.id);

    expect(events).toHaveLength(1);
  });
});

describe("Alchemy transaction history phase 3", () => {
  const signingKey = "test-alchemy-signing-key";
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        chainId: CHAIN_ID,
        alchemyWebhookSigningKey: signingKey,
        alchemyWebhookId: "wh_test",
        alchemyWebhookNetwork: NETWORK,
        alchemyWebhookChainId: CHAIN_ID,
        rpcUrl: "http://127.0.0.1:8545",
        host: "127.0.0.1",
        port: 0
      }
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function registerUser(email: string) {
    const response = await request(app.server)
      .post("/v1/auth/register")
      .send({
        email,
        password: "Password123"
      })
      .expect(201);

    return response.body as {
      token: string;
      user: {
        id: string;
        email: string;
      };
    };
  }

  async function addTrackedAccount(userId: string, address: string, accountIndex: number) {
    const root = await store.getHdWalletRootByUserId(userId);

    if (!root) {
      throw new Error(`Expected HD root for user ${userId}.`);
    }

    return store.createWalletAccount({
      walletRootId: root.id,
      userId,
      name: `Tracked ${accountIndex}`,
      chainId: CHAIN_ID,
      accountIndex,
      derivationPath: `m/44'/60'/${accountIndex}'/0/0`,
      address
    });
  }

  function tokenPayload(input: { toAddress: string; hash: string; logIndex: string }) {
    return {
      createdAt: "2024-09-25T13:52:47.561Z",
      event: {
        activity: [
          {
            asset: "USDC",
            blockNum: "0xdf34a3",
            category: "token",
            erc1155Metadata: null,
            erc721TokenId: null,
            fromAddress: FROM_ADDRESS,
            hash: input.hash,
            log: {
              address: USDC_ADDRESS,
              blockHash: "0xa99ec54413bd3db3f9bdb0c1ad3ab1400ee0ecefb47803e17f9d33bc4d0a1e91",
              blockNumber: "0xdf34a3",
              logIndex: input.logIndex,
              removed: false,
              transactionHash: input.hash
            },
            rawContract: {
              address: USDC_ADDRESS,
              decimals: 6,
              rawValue: "0x0000000000000000000000000000000000000000000000000000000011783b21"
            },
            toAddress: input.toAddress,
            typeTraceAddress: null,
            value: 293.092129
          }
        ],
        network: NETWORK
      },
      id: "whevt_history",
      type: "ADDRESS_ACTIVITY",
      webhookId: "wh_test"
    };
  }

  function sign(rawBody: string) {
    return createHmac("sha256", signingKey).update(rawBody).digest("hex");
  }

  async function ingestActivity(payload: ReturnType<typeof tokenPayload>) {
    const rawBody = JSON.stringify(payload);

    await request(app.server)
      .post("/v1/webhooks/alchemy/address-activity")
      .set("content-type", "application/json")
      .set("x-alchemy-signature", sign(rawBody))
      .send(rawBody)
      .expect(200);
  }

  it("lists transaction history for one owned account", async () => {
    const owner = await registerUser("history-owner@example.com");
    const other = await registerUser("history-other@example.com");
    const account = await addTrackedAccount(owner.user.id, TO_ADDRESS, 1);

    await ingestActivity({
      ...tokenPayload({
        toAddress: TO_ADDRESS,
        hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logIndex: "0x01"
      })
    });

    const response = await request(app.server)
      .get(`/v1/accounts/${account.id}/transactions`)
      .set("authorization", `Bearer ${owner.token}`)
      .expect(200);

    expect(response.body.accountId).toBe(account.id);
    expect(response.body.transactions).toHaveLength(1);
    expect(response.body.transactions[0]).toMatchObject({
      accountId: account.id,
      direction: "incoming",
      asset: {
        type: "erc20",
        tokenAddress: USDC_ADDRESS
      },
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });

    const otherResponse = await request(app.server)
      .get(`/v1/accounts/${account.id}/transactions`)
      .set("authorization", `Bearer ${other.token}`);

    expect(otherResponse.status).toBe(404);
    expect(otherResponse.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    await request(app.server).get(`/v1/accounts/${account.id}/transactions`).expect(401);
  });

  it("lists user transaction history and filters by account id", async () => {
    const owner = await registerUser("history-list@example.com");
    const other = await registerUser("history-list-other@example.com");
    const firstAccount = await addTrackedAccount(owner.user.id, TO_ADDRESS, 1);
    const secondAccount = await addTrackedAccount(owner.user.id, OTHER_ADDRESS, 2);
    const otherAccount = await addTrackedAccount(other.user.id, FROM_ADDRESS, 1);

    await ingestActivity(
      tokenPayload({
        toAddress: TO_ADDRESS,
        hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        logIndex: "0x01"
      })
    );
    await ingestActivity(
      tokenPayload({
        toAddress: OTHER_ADDRESS,
        hash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        logIndex: "0x02"
      })
    );
    await ingestActivity(
      tokenPayload({
        toAddress: FROM_ADDRESS,
        hash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        logIndex: "0x03"
      })
    );

    const allResponse = await request(app.server)
      .get("/v1/transactions")
      .set("authorization", `Bearer ${owner.token}`)
      .expect(200);

    expect(allResponse.body.transactions).toHaveLength(2);
    expect(new Set(allResponse.body.transactions.map((event: { accountId: string }) => event.accountId))).toEqual(
      new Set([firstAccount.id, secondAccount.id])
    );

    const filteredResponse = await request(app.server)
      .get(`/v1/transactions?accountId=${secondAccount.id}`)
      .set("authorization", `Bearer ${owner.token}`)
      .expect(200);

    expect(filteredResponse.body.accountId).toBe(secondAccount.id);
    expect(filteredResponse.body.transactions).toHaveLength(1);
    expect(filteredResponse.body.transactions[0]).toMatchObject({
      accountId: secondAccount.id,
      txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    });

    const unauthorizedFilterResponse = await request(app.server)
      .get(`/v1/transactions?accountId=${otherAccount.id}`)
      .set("authorization", `Bearer ${owner.token}`);

    expect(unauthorizedFilterResponse.status).toBe(404);
    expect(unauthorizedFilterResponse.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
