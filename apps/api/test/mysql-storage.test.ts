import type { FastifyInstance } from "fastify";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import type { Pool } from "mysql2/promise";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { MysqlStore } from "../src/store/mysql-store";
import { createPersistentTestPool } from "./support/test-mysql-store";

describe("mysql storage module", () => {
  let pool: Pool;
  let chainProvider: JsonRpcProvider;
  let openApps: FastifyInstance[] = [];

  beforeAll(async () => {
    chainProvider = new JsonRpcProvider("http://127.0.0.1:8545");
    await chainProvider.getBlockNumber();
    pool = await createPersistentTestPool();
  });

  beforeEach(() => {
    openApps = [];
  });

  afterEach(async () => {
    for (const app of openApps.reverse()) {
      await app.close();
    }
  });

  afterAll(async () => {
    chainProvider.destroy();
    await pool.end();
  });

  async function createMysqlApp() {
    const store = new MysqlStore({ pool });
    const app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        chainId: 31337,
        rpcUrl: "http://127.0.0.1:8545",
        host: "127.0.0.1",
        port: 0
      }
    });

    await app.ready();
    openApps.push(app);
    return app;
  }

  async function registerUser(app: FastifyInstance, email: string) {
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

  async function loginUser(app: FastifyInstance, email: string) {
    const response = await request(app.server)
      .post("/v1/auth/login")
      .send({
        email,
        password: "Password123"
      })
      .expect(200);

    return response.body as {
      token: string;
      user: {
        id: string;
        email: string;
      };
    };
  }

  async function listAccounts(app: FastifyInstance, token: string) {
    const response = await request(app.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    return response.body as {
      accounts: Array<{
        accountId: string;
        address: string;
      }>;
    };
  }

  async function waitForReceipt(txHash: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const receipt = await chainProvider.getTransactionReceipt(txHash);

      if (receipt) {
        return receipt;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out while waiting for receipt ${txHash}.`);
  }

  it("persists auth and HD account records across app restarts", async () => {
    const firstApp = await createMysqlApp();
    const auth = await registerUser(firstApp, "alice@example.com");
    const account = (await listAccounts(firstApp, auth.token)).accounts[0];

    await firstApp.close();
    openApps = openApps.filter((app) => app !== firstApp);

    const secondApp = await createMysqlApp();
    const login = await loginUser(secondApp, "alice@example.com");

    const meResponse = await request(secondApp.server)
      .get("/v1/auth/me")
      .set("authorization", `Bearer ${login.token}`)
      .expect(200);

    const accountsResponse = await request(secondApp.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${login.token}`)
      .expect(200);
    const persistedAccount = accountsResponse.body.accounts[0];

    expect(login.user.id).toBe(auth.user.id);
    expect(meResponse.body.user.id).toBe(auth.user.id);
    expect(persistedAccount.accountId).toBe(account.accountId);
    expect(persistedAccount.address).toBe(account.address);
  });

  it("persists HD account sign requests and transactions across app restarts", async () => {
    const firstApp = await createMysqlApp();
    const auth = await registerUser(firstApp, "alice-sign@example.com");
    const account = (await listAccounts(firstApp, auth.token)).accounts[0];
    const fundingSigner = await chainProvider.getSigner(0);
    const recipient = Wallet.createRandom().address;

    const fundingTx = await fundingSigner.sendTransaction({
      to: account.address,
      value: parseEther("1.0")
    });
    await fundingTx.wait();

    const signResponse = await request(firstApp.server)
      .post(`/v1/accounts/${account.accountId}/sign-message`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        message: "persist-me",
        idempotencyKey: "sign-persist-1"
      })
      .expect(200);

    const sendResponse = await request(firstApp.server)
      .post(`/v1/accounts/${account.accountId}/send-transaction`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        to: recipient,
        amount: parseEther("0.25").toString(),
        asset: {
          type: "native"
        },
        idempotencyKey: "tx-persist-1"
      })
      .expect(200);

    await waitForReceipt(sendResponse.body.txHash);

    await firstApp.close();
    openApps = openApps.filter((app) => app !== firstApp);

    const secondApp = await createMysqlApp();
    const login = await loginUser(secondApp, "alice-sign@example.com");

    const signReplay = await request(secondApp.server)
      .post(`/v1/accounts/${account.accountId}/sign-message`)
      .set("authorization", `Bearer ${login.token}`)
      .send({
        message: "persist-me",
        idempotencyKey: "sign-persist-1"
      })
      .expect(200);

    const transactionLookup = await request(secondApp.server)
      .get(`/v1/transactions/hash/${sendResponse.body.txHash}`)
      .set("authorization", `Bearer ${login.token}`)
      .expect(200);

    expect(signReplay.body).toEqual(signResponse.body);
    expect(transactionLookup.body.eventId).toBe(sendResponse.body.transactionId);
    expect(transactionLookup.body.txHash).toBe(sendResponse.body.txHash);
    expect(transactionLookup.body.status).toBe("confirmed");
  });
});
