import type { FastifyInstance } from "fastify";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  parseEther,
  verifyMessage
} from "ethers";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { AccountAddressRegistrar } from "../src/services/account-address-registrar";
import type { AppStore } from "../src/store/store";
import { getTestErc20Artifact } from "./support/test-erc20";
import { createTestMysqlStore } from "./support/test-mysql-store";

describe("HD account module", () => {
  let app: FastifyInstance;
  let store: AppStore;
  let chainProvider: JsonRpcProvider;
  let snapshotId: string;
  let token: Contract;
  let tokenAddress: string;

  beforeEach(async () => {
    chainProvider = new JsonRpcProvider("http://127.0.0.1:8545");
    await chainProvider.getBlockNumber();
    snapshotId = await chainProvider.send("evm_snapshot", []);

    const deployer = await chainProvider.getSigner(0);
    const artifact = getTestErc20Artifact();
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);

    token = await factory.deploy(parseEther("1000000"));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();

    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      provider: chainProvider,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        chainId: 31337,
        transactionHistoryNetwork: "ANVIL",
        supportedErc20Tokens: [tokenAddress],
        rpcUrl: "http://127.0.0.1:8545",
        host: "127.0.0.1",
        port: 0
      }
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await chainProvider.send("evm_revert", [snapshotId]);
    chainProvider.destroy();
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

  async function listAccounts(token: string) {
    const response = await request(app.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    return response.body as {
      accounts: Array<{
        accountId: string;
        name: string;
        address: string;
        accountIndex: number;
        derivationPath: string;
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

  async function fundAccount(address: string, tokenAmount = parseEther("100")) {
    const fundingSigner = await chainProvider.getSigner(0);
    const fundingTx = await fundingSigner.sendTransaction({
      to: address,
      value: parseEther("1.0")
    });
    await fundingTx.wait();

    const tokenFundingTx = await token.connect(fundingSigner).transfer(address, tokenAmount);
    await tokenFundingTx.wait();
  }

  it("lists the default HD account and creates named derived accounts", async () => {
    const auth = await registerUser("alice@example.com");
    const initial = await listAccounts(auth.token);

    expect(initial.accounts).toHaveLength(1);
    expect(initial.accounts[0]).toMatchObject({
      name: "Main",
      accountIndex: 0,
      derivationPath: "m/44'/60'/0'/0/0"
    });
    expect(initial.accounts[0].address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const createdResponse = await request(app.server)
      .post("/v1/accounts")
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        name: "Trading"
      })
      .expect(201);

    expect(createdResponse.body).toMatchObject({
      name: "Trading",
      accountIndex: 1,
      derivationPath: "m/44'/60'/1'/0/0"
    });
    expect(createdResponse.body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(createdResponse.body).not.toHaveProperty("privateKey");

    const walletRoot = await store.getHdWalletRootByUserId(auth.user.id);
    const accounts = await store.listWalletAccountsByWalletRootId(walletRoot?.id ?? "");

    expect(walletRoot?.nextAccountIndex).toBe(2);
    expect(walletRoot?.encryptedRootSecret).not.toHaveProperty("phrase");
    expect(accounts).toHaveLength(2);
    expect(accounts[1]).not.toHaveProperty("privateKey");
  });

  it("reads native and allowlisted ERC-20 balances for owned HD accounts", async () => {
    const auth = await registerUser("alice@example.com");
    const account = (await listAccounts(auth.token)).accounts[0];
    await fundAccount(account.address, parseEther("42"));

    const response = await request(app.server)
      .get(`/v1/accounts/${account.accountId}/balances`)
      .set("authorization", `Bearer ${auth.token}`)
      .expect(200);
    const nativeBalance = response.body.balances.find(
      (balance: { asset: { type: string } }) => balance.asset.type === "native"
    );
    const tokenBalance = response.body.balances.find(
      (balance: { asset: { type: string; tokenAddress?: string } }) =>
        balance.asset.type === "erc20" && balance.asset.tokenAddress === tokenAddress.toLowerCase()
    );

    expect(response.body.accountId).toBe(account.accountId);
    expect(response.body.balances).toHaveLength(2);
    expect(nativeBalance).toEqual({
      asset: {
        type: "native"
      },
      raw: parseEther("1.0").toString(),
      formatted: "1.0",
      symbol: "ETH",
      decimals: 18
    });
    expect(tokenBalance).toEqual({
      asset: {
        type: "erc20",
        tokenAddress: tokenAddress.toLowerCase()
      },
      raw: parseEther("42").toString(),
      formatted: "42.0",
      symbol: "TEST",
      decimals: 18
    });
  });

  it("signs messages for owned HD accounts and enforces idempotency", async () => {
    const auth = await registerUser("alice@example.com");
    const account = (await listAccounts(auth.token)).accounts[0];

    const firstResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/sign-message`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        message: "hello",
        idempotencyKey: "hd-sign-1"
      })
      .expect(200);

    expect(verifyMessage("hello", firstResponse.body.signature)).toBe(account.address);

    const replayResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/sign-message`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        message: "hello",
        idempotencyKey: "hd-sign-1"
      })
      .expect(200);

    expect(replayResponse.body).toEqual(firstResponse.body);

    const conflictResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/sign-message`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        message: "different",
        idempotencyKey: "hd-sign-1"
      });

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("sends native transactions from HD accounts and reconciles transaction lookup", async () => {
    const auth = await registerUser("alice@example.com");
    const account = (await listAccounts(auth.token)).accounts[0];
    const recipient = Wallet.createRandom().address;
    const fundingSigner = await chainProvider.getSigner(0);

    const fundingTx = await fundingSigner.sendTransaction({
      to: account.address,
      value: parseEther("1.0")
    });
    await fundingTx.wait();

    const sendResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/send-transaction`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        to: recipient,
        amount: parseEther("0.25").toString(),
        asset: {
          type: "native"
        },
        idempotencyKey: "hd-transfer-1"
      })
      .expect(200);

    expect(sendResponse.body.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(sendResponse.body.status).toBe("broadcasted");

    const receipt = await waitForReceipt(sendResponse.body.txHash);

    expect(receipt.status).toBe(1);
    expect(await chainProvider.getBalance(recipient)).toBe(parseEther("0.25"));

    const lookupResponse = await request(app.server)
      .get(`/v1/transactions/hash/${sendResponse.body.txHash}`)
      .set("authorization", `Bearer ${auth.token}`)
      .expect(200);

    expect(lookupResponse.body.eventId).toBe(sendResponse.body.transactionId);
    expect(lookupResponse.body.accountId).toBe(account.accountId);
    expect(lookupResponse.body.status).toBe("confirmed");
    expect(lookupResponse.body.txHash).toBe(sendResponse.body.txHash);

    const historyResponse = await request(app.server)
      .get(`/v1/accounts/${account.accountId}/transactions`)
      .set("authorization", `Bearer ${auth.token}`)
      .expect(200);

    expect(historyResponse.body.transactions).toHaveLength(1);
    expect(historyResponse.body.transactions[0]).toMatchObject({
      accountId: account.accountId,
      network: "ANVIL",
      direction: "outgoing",
      asset: {
        type: "native"
      },
      fromAddress: account.address.toLowerCase(),
      toAddress: recipient.toLowerCase(),
      amountRaw: parseEther("0.25").toString(),
      txHash: sendResponse.body.txHash,
      status: "confirmed",
      source: "api_send"
    });
    expect(historyResponse.body.transactions[0].blockNumber).toBe(receipt.blockNumber.toString());
  });

  it("sends ERC-20 transactions from HD accounts and replays idempotent requests", async () => {
    const auth = await registerUser("alice@example.com");
    const account = (await listAccounts(auth.token)).accounts[0];
    const recipient = Wallet.createRandom().address;

    await fundAccount(account.address);

    const firstResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/send-transaction`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        to: recipient,
        amount: parseEther("25").toString(),
        asset: {
          type: "erc20",
          tokenAddress
        },
        idempotencyKey: "hd-erc20-transfer-1"
      })
      .expect(200);

    const replayResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/send-transaction`)
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        to: recipient,
        amount: parseEther("25").toString(),
        asset: {
          type: "erc20",
          tokenAddress
        },
        idempotencyKey: "hd-erc20-transfer-1"
      })
      .expect(200);

    expect(replayResponse.body).toEqual(firstResponse.body);

    const receipt = await waitForReceipt(firstResponse.body.txHash);

    expect(receipt.status).toBe(1);
    expect(await token.balanceOf(recipient)).toBe(parseEther("25"));

    const historyResponse = await request(app.server)
      .get(`/v1/accounts/${account.accountId}/transactions`)
      .set("authorization", `Bearer ${auth.token}`)
      .expect(200);

    expect(historyResponse.body.transactions).toHaveLength(1);
    expect(historyResponse.body.transactions[0]).toMatchObject({
      accountId: account.accountId,
      network: "ANVIL",
      direction: "outgoing",
      asset: {
        type: "erc20",
        tokenAddress: tokenAddress.toLowerCase()
      },
      fromAddress: account.address.toLowerCase(),
      toAddress: recipient.toLowerCase(),
      amountRaw: parseEther("25").toString(),
      txHash: firstResponse.body.txHash,
      status: "confirmed",
      source: "api_send"
    });
  });

  it("hides HD accounts from other users", async () => {
    const owner = await registerUser("owner@example.com");
    const otherUser = await registerUser("other@example.com");
    const account = (await listAccounts(owner.token)).accounts[0];

    const forbiddenBalanceResponse = await request(app.server)
      .get(`/v1/accounts/${account.accountId}/balances`)
      .set("authorization", `Bearer ${otherUser.token}`);

    expect(forbiddenBalanceResponse.status).toBe(404);
    expect(forbiddenBalanceResponse.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const unauthenticatedCreateResponse = await request(app.server)
      .post("/v1/accounts")
      .send({
        name: "Trading"
      });

    expect(unauthenticatedCreateResponse.status).toBe(401);
    expect(unauthenticatedCreateResponse.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("HD account Alchemy address registration", () => {
  let app: FastifyInstance;
  let store: AppStore;
  let registrar: RecordingAccountAddressRegistrar;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    registrar = new RecordingAccountAddressRegistrar();
    app = createApp({
      store,
      accountAddressRegistrar: registrar,
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

  it("registers signup default account and newly created account addresses", async () => {
    const auth = await registerUser("registrar@example.com");

    expect(registrar.addresses).toHaveLength(1);

    const createdResponse = await request(app.server)
      .post("/v1/accounts")
      .set("authorization", `Bearer ${auth.token}`)
      .send({
        name: "Savings"
      })
      .expect(201);

    expect(registrar.addresses).toHaveLength(2);
    expect(registrar.addresses[1]).toBe(createdResponse.body.address.toLowerCase());
  });

  it("does not block account creation when address registration fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registrar.fail = true;

    try {
      const auth = await registerUser("registrar-failure@example.com");

      const createdResponse = await request(app.server)
        .post("/v1/accounts")
        .set("authorization", `Bearer ${auth.token}`)
        .send({
          name: "Still Created"
        })
        .expect(201);

      const walletRoot = await store.getHdWalletRootByUserId(auth.user.id);
      const accounts = await store.listWalletAccountsByWalletRootId(walletRoot?.id ?? "");

      expect(createdResponse.body).toMatchObject({
        name: "Still Created",
        accountIndex: 1
      });
      expect(accounts).toHaveLength(2);
      expect(registrar.attempts).toBe(2);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not require Alchemy registration config to create accounts", async () => {
    await app.close();
    ({ store } = await createTestMysqlStore());
    app = createApp({
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

    const auth = await registerUser("registrar-disabled@example.com");
    const walletRoot = await store.getHdWalletRootByUserId(auth.user.id);
    const accounts = await store.listWalletAccountsByWalletRootId(walletRoot?.id ?? "");

    expect(accounts).toHaveLength(1);
  });
});

class RecordingAccountAddressRegistrar implements AccountAddressRegistrar {
  readonly addresses: string[] = [];
  attempts = 0;
  fail = false;

  async registerAddress(address: string): Promise<void> {
    this.attempts += 1;

    if (this.fail) {
      throw new Error("registration failed");
    }

    this.addresses.push(address);
  }
}
