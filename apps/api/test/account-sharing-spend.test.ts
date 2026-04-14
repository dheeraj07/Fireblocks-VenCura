import type { FastifyInstance } from "fastify";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

const TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111";

describe("account sharing spend requests", () => {
  let app: FastifyInstance;
  let store: AppStore;
  let chainProvider: JsonRpcProvider;
  let snapshotId: string;

  beforeEach(async () => {
    chainProvider = new JsonRpcProvider("http://127.0.0.1:8545");
    await chainProvider.getBlockNumber();
    snapshotId = await chainProvider.send("evm_snapshot", []);

    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      provider: chainProvider,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        chainId: 31337,
        transactionHistoryNetwork: "ANVIL",
        supportedErc20Tokens: [TOKEN_ADDRESS],
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
        address: string;
      }>;
    };
  }

  async function createNativePolicy(token: string, limitRaw: string) {
    const response = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${token}`)
      .send({
        name: "Native shared spend limit",
        rules: {
          assetRules: [
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: limitRaw
            }
          ]
        }
      })
      .expect(201);

    return response.body as {
      policyId: string;
    };
  }

  async function shareAccount(input: {
    ownerToken: string;
    accountId: string;
    sharedUserId: string;
    policyIds?: string[];
  }) {
    const response = await request(app.server)
      .post(`/v1/accounts/${input.accountId}/shares`)
      .set("authorization", `Bearer ${input.ownerToken}`)
      .send({
        userId: input.sharedUserId,
        policyIds: input.policyIds ?? []
      })
      .expect(201);

    return response.body as {
      shareId: string;
      policyIds: string[];
    };
  }

  async function createSpendRequest(input: {
    token: string;
    accountId: string;
    to: string;
    amount: string;
    idempotencyKey: string;
    expectedStatus?: number;
  }) {
    const response = await request(app.server)
      .post(`/v1/accounts/${input.accountId}/shared-spend-requests`)
      .set("authorization", `Bearer ${input.token}`)
      .send({
        to: input.to,
        amount: input.amount,
        asset: {
          type: "native"
        },
        idempotencyKey: input.idempotencyKey
      })
      .expect(input.expectedStatus ?? 200);

    return response.body as {
      spendRequestId: string;
      shareId: string;
      accountId: string;
      ownerUserId: string;
      requesterUserId: string;
      policyIds: string[];
      amountRaw: string;
      status: "pending" | "rejected" | "broadcasted" | "failed";
      transactionEventId: string | null;
      txHash: string | null;
    };
  }

  async function fundAccount(address: string, amount = parseEther("1.0")) {
    const fundingSigner = await chainProvider.getSigner(0);
    const fundingTx = await fundingSigner.sendTransaction({
      to: address,
      value: amount
    });

    await fundingTx.wait();
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

  it("executes full-access shared spend requests immediately and enforces idempotency", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const account = (await listAccounts(alice.token)).accounts[0];
    const recipient = Wallet.createRandom().address;

    await fundAccount(account.address);
    await shareAccount({
      ownerToken: alice.token,
      accountId: account.accountId,
      sharedUserId: bob.user.id
    });

    const firstResponse = await createSpendRequest({
      token: bob.token,
      accountId: account.accountId,
      to: recipient,
      amount: parseEther("0.1").toString(),
      idempotencyKey: "full-access-1"
    });

    expect(firstResponse.status).toBe("broadcasted");
    expect(firstResponse.policyIds).toEqual([]);
    expect(firstResponse.transactionEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(firstResponse.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const receipt = await waitForReceipt(firstResponse.txHash ?? "");

    expect(receipt.status).toBe(1);
    expect(await chainProvider.getBalance(recipient)).toBe(parseEther("0.1"));

    const replayResponse = await createSpendRequest({
      token: bob.token,
      accountId: account.accountId,
      to: recipient,
      amount: parseEther("0.1").toString(),
      idempotencyKey: "full-access-1"
    });

    expect(replayResponse).toEqual(firstResponse);

    const conflictResponse = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/shared-spend-requests`)
      .set("authorization", `Bearer ${bob.token}`)
      .send({
        to: recipient,
        amount: parseEther("0.2").toString(),
        asset: {
          type: "native"
        },
        idempotencyKey: "full-access-1"
      });

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("auto-approves under-limit policy requests and owner-approves over-limit requests", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const account = (await listAccounts(alice.token)).accounts[0];
    const recipient = Wallet.createRandom().address;
    const policy = await createNativePolicy(alice.token, parseEther("0.05").toString());

    await fundAccount(account.address);
    await shareAccount({
      ownerToken: alice.token,
      accountId: account.accountId,
      sharedUserId: bob.user.id,
      policyIds: [policy.policyId]
    });

    const underLimitResponse = await createSpendRequest({
      token: bob.token,
      accountId: account.accountId,
      to: recipient,
      amount: parseEther("0.01").toString(),
      idempotencyKey: "policy-under-limit-1"
    });

    expect(underLimitResponse).toMatchObject({
      status: "broadcasted",
      policyIds: [policy.policyId],
      amountRaw: parseEther("0.01").toString()
    });
    expect(underLimitResponse.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    await waitForReceipt(underLimitResponse.txHash ?? "");

    const overLimitResponse = await createSpendRequest({
      token: bob.token,
      accountId: account.accountId,
      to: recipient,
      amount: parseEther("0.2").toString(),
      idempotencyKey: "policy-over-limit-1",
      expectedStatus: 202
    });

    expect(overLimitResponse).toMatchObject({
      status: "pending",
      ownerUserId: alice.user.id,
      requesterUserId: bob.user.id,
      policyIds: [policy.policyId],
      transactionEventId: null,
      txHash: null,
      amountRaw: parseEther("0.2").toString()
    });

    const bobListResponse = await request(app.server)
      .get("/v1/spend-requests")
      .set("authorization", `Bearer ${bob.token}`)
      .expect(200);
    const aliceListResponse = await request(app.server)
      .get("/v1/spend-requests")
      .set("authorization", `Bearer ${alice.token}`)
      .expect(200);

    const bobVisibleSpendRequest = bobListResponse.body.spendRequests.find(
      (spendRequest: { spendRequestId: string }) =>
        spendRequest.spendRequestId === overLimitResponse.spendRequestId
    );
    const aliceVisibleSpendRequest = aliceListResponse.body.spendRequests.find(
      (spendRequest: { spendRequestId: string }) =>
        spendRequest.spendRequestId === overLimitResponse.spendRequestId
    );

    expect(bobVisibleSpendRequest).toMatchObject({
      ownerUserId: alice.user.id,
      requesterUserId: bob.user.id
    });
    expect(aliceVisibleSpendRequest).toMatchObject({
      ownerUserId: alice.user.id,
      requesterUserId: bob.user.id
    });

    const approvalResponse = await request(app.server)
      .post(`/v1/spend-requests/${overLimitResponse.spendRequestId}/decision`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        decision: "approve"
      })
      .expect(200);

    expect(approvalResponse.body).toMatchObject({
      spendRequestId: overLimitResponse.spendRequestId,
      status: "broadcasted"
    });
    expect(approvalResponse.body.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    const approvalReceipt = await waitForReceipt(approvalResponse.body.txHash);

    expect(approvalReceipt.status).toBe(1);
    expect(await chainProvider.getBalance(recipient)).toBe(parseEther("0.21"));
  });

  it("rejects unauthorized decisions and supports owner rejection", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const account = (await listAccounts(alice.token)).accounts[0];
    const recipient = Wallet.createRandom().address;
    const policy = await createNativePolicy(alice.token, "1");

    await fundAccount(account.address);
    await shareAccount({
      ownerToken: alice.token,
      accountId: account.accountId,
      sharedUserId: bob.user.id,
      policyIds: [policy.policyId]
    });

    const pendingResponse = await createSpendRequest({
      token: bob.token,
      accountId: account.accountId,
      to: recipient,
      amount: parseEther("0.01").toString(),
      idempotencyKey: "policy-reject-1",
      expectedStatus: 202
    });

    const unauthorizedDecisionResponse = await request(app.server)
      .post(`/v1/spend-requests/${pendingResponse.spendRequestId}/decision`)
      .set("authorization", `Bearer ${bob.token}`)
      .send({
        decision: "approve"
      });

    expect(unauthorizedDecisionResponse.status).toBe(404);
    expect(unauthorizedDecisionResponse.body.error.code).toBe("SPEND_REQUEST_NOT_FOUND");

    const rejectionResponse = await request(app.server)
      .post(`/v1/spend-requests/${pendingResponse.spendRequestId}/decision`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        decision: "reject"
      })
      .expect(200);

    expect(rejectionResponse.body).toMatchObject({
      spendRequestId: pendingResponse.spendRequestId,
      status: "rejected",
      transactionEventId: null,
      txHash: null
    });

    const replayRejectionResponse = await request(app.server)
      .post(`/v1/spend-requests/${pendingResponse.spendRequestId}/decision`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        decision: "reject"
      })
      .expect(200);

    expect(replayRejectionResponse.body).toEqual(rejectionResponse.body);

    const approveRejectedResponse = await request(app.server)
      .post(`/v1/spend-requests/${pendingResponse.spendRequestId}/decision`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        decision: "approve"
      });

    expect(approveRejectedResponse.status).toBe(409);
    expect(approveRejectedResponse.body.error.code).toBe("SPEND_REQUEST_ALREADY_DECIDED");
    expect(await chainProvider.getBalance(recipient)).toBe(0n);
  });

  it("rejects shared spends for assets missing from assigned policies", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const account = (await listAccounts(alice.token)).accounts[0];
    const recipient = Wallet.createRandom().address;
    const policy = await createNativePolicy(alice.token, parseEther("1").toString());

    await shareAccount({
      ownerToken: alice.token,
      accountId: account.accountId,
      sharedUserId: bob.user.id,
      policyIds: [policy.policyId]
    });

    const response = await request(app.server)
      .post(`/v1/accounts/${account.accountId}/shared-spend-requests`)
      .set("authorization", `Bearer ${bob.token}`)
      .send({
        to: recipient,
        amount: "1",
        asset: {
          type: "erc20",
          tokenAddress: TOKEN_ADDRESS
        },
        idempotencyKey: "asset-not-allowed-1"
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ASSET_NOT_ALLOWED");
  });
});
