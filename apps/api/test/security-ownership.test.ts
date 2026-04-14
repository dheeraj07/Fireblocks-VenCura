import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

describe("security: account ownership boundaries", () => {
  let app: FastifyInstance;
  let store: AppStore;

  let alice: { token: string; user: { id: string; email: string } };
  let bob: { token: string; user: { id: string; email: string } };
  let aliceAccountId: string;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        rpcUrl: "http://127.0.0.1:8545",
        host: "127.0.0.1",
        port: 0
      }
    });

    await app.ready();

    alice = await registerUser("alice@example.com");
    bob = await registerUser("bob@example.com");

    const aliceAccounts = await listAccounts(alice.token);
    aliceAccountId = aliceAccounts.accounts[0].accountId;
  });

  afterEach(async () => {
    await app.close();
  });

  async function registerUser(email: string) {
    const response = await request(app.server)
      .post("/v1/auth/register")
      .send({ email, password: "Password123" })
      .expect(201);

    return response.body as {
      token: string;
      user: { id: string; email: string };
    };
  }

  async function listAccounts(token: string) {
    const response = await request(app.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    return response.body as {
      accounts: Array<{ accountId: string; name: string; address: string }>;
    };
  }

  describe("direct account operations", () => {
    it("prevents Bob from signing messages on Alice's account", async () => {
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/sign-message`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ message: "test", idempotencyKey: "key-1" });

      expect([403, 404]).toContain(response.status);
    });

    it("prevents Bob from sending transactions from Alice's account", async () => {
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/send-transaction`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "native" },
          idempotencyKey: "key-1"
        });

      expect([403, 404]).toContain(response.status);
    });

    it("prevents Bob from viewing Alice's account balances", async () => {
      const response = await request(app.server)
        .get(`/v1/accounts/${aliceAccountId}/balances`)
        .set("authorization", `Bearer ${bob.token}`);

      expect([403, 404]).toContain(response.status);
    });

    it("prevents Bob from viewing Alice's account transactions", async () => {
      const response = await request(app.server)
        .get(`/v1/accounts/${aliceAccountId}/transactions`)
        .set("authorization", `Bearer ${bob.token}`);

      expect([403, 404]).toContain(response.status);
    });
  });

  describe("share operations", () => {
    it("prevents Bob from creating shares on Alice's account", async () => {
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ userId: bob.user.id, policyIds: [] });

      expect([403, 404]).toContain(response.status);
    });

    it("prevents Bob from listing shares on Alice's account", async () => {
      const response = await request(app.server)
        .get(`/v1/accounts/${aliceAccountId}/shares`)
        .set("authorization", `Bearer ${bob.token}`);

      expect([403, 404]).toContain(response.status);
    });

    it("prevents Bob from updating shares on Alice's account", async () => {
      const shareResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ userId: bob.user.id, policyIds: [] })
        .expect(201);

      const shareId = shareResponse.body.shareId;

      const updateResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares/${shareId}/update`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ status: "revoked" });

      expect([403, 404]).toContain(updateResponse.status);
    });
  });

  describe("spend request operations", () => {
    it("prevents Bob from creating spend requests without a share", async () => {
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "native" },
          idempotencyKey: "key-1"
        });

      expect([403, 404]).toContain(response.status);
    });
  });

  describe("account listing isolation", () => {
    it("does not include Alice's accounts in Bob's account list", async () => {
      await request(app.server)
        .post("/v1/accounts")
        .set("authorization", `Bearer ${alice.token}`)
        .send({ name: "Alice Savings" })
        .expect(201);

      const bobAccounts = await listAccounts(bob.token);
      const aliceAccounts = await listAccounts(alice.token);

      const aliceAccountIds = aliceAccounts.accounts.map((a) => a.accountId);
      for (const bobAccount of bobAccounts.accounts) {
        expect(aliceAccountIds).not.toContain(bobAccount.accountId);
      }
    });
  });

  describe("policy isolation", () => {
    it("does not include Alice's policies in Bob's policy list", async () => {
      const createResponse = await request(app.server)
        .post("/v1/policies")
        .set("authorization", `Bearer ${alice.token}`)
        .send({
          name: "Alice native limit",
          rules: {
            assetRules: [{ asset: { type: "native" }, autoApproveLimitRaw: "50000000000000000" }]
          }
        })
        .expect(201);

      const alicePolicyId = createResponse.body.policyId;

      const bobPoliciesResponse = await request(app.server)
        .get("/v1/policies")
        .set("authorization", `Bearer ${bob.token}`)
        .expect(200);

      const bobPolicyIds = bobPoliciesResponse.body.policies.map(
        (p: { policyId: string }) => p.policyId
      );
      expect(bobPolicyIds).not.toContain(alicePolicyId);
    });

    it("prevents Bob from updating Alice's policy", async () => {
      const createResponse = await request(app.server)
        .post("/v1/policies")
        .set("authorization", `Bearer ${alice.token}`)
        .send({
          name: "Alice ops limit",
          rules: {
            assetRules: [{ asset: { type: "native" }, autoApproveLimitRaw: "50000000000000000" }]
          }
        })
        .expect(201);

      const updateResponse = await request(app.server)
        .post(`/v1/policies/${createResponse.body.policyId}/update`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ name: "Bob hijacked policy" });

      expect(updateResponse.status).toBe(404);
    });
  });

  describe("spend request decision isolation", () => {
    it("prevents Bob from approving Alice's pending spend request", async () => {
      const charlie = await registerUser("charlie@example.com");

      const policy = await request(app.server)
        .post("/v1/policies")
        .set("authorization", `Bearer ${alice.token}`)
        .send({
          name: "Low limit",
          rules: {
            assetRules: [{ asset: { type: "native" }, autoApproveLimitRaw: "1" }]
          }
        })
        .expect(201);

      await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ userId: charlie.user.id, policyIds: [policy.body.policyId] })
        .expect(201);

      const spendResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${charlie.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          asset: { type: "native" },
          idempotencyKey: "pending-spend-1"
        })
        .expect(202);

      const spendRequestId = spendResponse.body.spendRequestId;
      expect(spendResponse.body.status).toBe("pending");

      const bobApprove = await request(app.server)
        .post(`/v1/spend-requests/${spendRequestId}/decision`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ decision: "approve" });

      expect([403, 404]).toContain(bobApprove.status);

      const aliceReject = await request(app.server)
        .post(`/v1/spend-requests/${spendRequestId}/decision`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ decision: "reject" });

      expect(aliceReject.status).toBe(200);
      expect(aliceReject.body.status).toBe("rejected");
    });
  });

  describe("transaction history isolation", () => {
    it("does not leak Alice's transactions to Bob", async () => {
      const bobTxResponse = await request(app.server)
        .get("/v1/transactions")
        .set("authorization", `Bearer ${bob.token}`)
        .expect(200);

      const bobAccountIds = (await listAccounts(bob.token)).accounts.map((a) => a.accountId);
      for (const tx of bobTxResponse.body.transactions) {
        expect(bobAccountIds).toContain(tx.accountId);
      }
    });
  });
});
