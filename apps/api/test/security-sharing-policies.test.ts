import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

describe("security: sharing & policy enforcement", () => {
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

    const accounts = await listAccounts(alice.token);
    aliceAccountId = accounts.accounts[0].accountId;
  });

  afterEach(async () => {
    await app.close();
  });

  async function registerUser(email: string) {
    const response = await request(app.server)
      .post("/v1/auth/register")
      .send({ email, password: "Password123" })
      .expect(201);
    return response.body as { token: string; user: { id: string; email: string } };
  }

  async function listAccounts(token: string) {
    const response = await request(app.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    return response.body as { accounts: Array<{ accountId: string; name: string; address: string }> };
  }

  async function createPolicy(token: string, name: string, limitRaw: string) {
    const response = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${token}`)
      .send({
        name,
        rules: { assetRules: [{ asset: { type: "native" }, autoApproveLimitRaw: limitRaw }] }
      })
      .expect(201);
    return response.body as { policyId: string };
  }

  async function shareAccount(ownerToken: string, accountId: string, userId: string, policyIds: string[]) {
    const response = await request(app.server)
      .post(`/v1/accounts/${accountId}/shares`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ userId, policyIds })
      .expect(201);
    return response.body as { shareId: string };
  }

  // ---------------------------------------------------------------------------
  // Share management security
  // ---------------------------------------------------------------------------

  describe("share management security", () => {
    it("prevents non-owner from creating shares", async () => {
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ userId: bob.user.id, policyIds: [] });

      expect([403, 404]).toContain(response.status);
    });

    it("prevents shared user from revoking their own share", async () => {
      const policy = await createPolicy(alice.token, "basic", "1000000000000000000");
      const share = await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares/${share.shareId}/update`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ status: "revoked" });

      expect([403, 404]).toContain(response.status);
    });

    it("prevents shared user from modifying share policy attachments", async () => {
      const policy1 = await createPolicy(alice.token, "policy1", "1000000000000000000");
      const policy2 = await createPolicy(alice.token, "policy2", "500000000000000000");
      const share = await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy1.policyId]);

      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares/${share.shareId}/update`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ policyIds: [policy2.policyId] });

      expect([403, 404]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // Spend request policy enforcement
  // ---------------------------------------------------------------------------

  describe("spend request policy enforcement", () => {
    it("rejects spend request without any share", async () => {
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "native" },
          idempotencyKey: "no-share-1"
        });

      expect([403, 404]).toContain(response.status);
    });

    it("rejects spend request with revoked share", async () => {
      const policy = await createPolicy(alice.token, "revoke-test", "1000000000000000000");
      const share = await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      // Alice revokes the share
      await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares/${share.shareId}/update`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ status: "revoked" })
        .expect(200);

      // Bob tries to spend after revocation
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "native" },
          idempotencyKey: "revoked-spend-1"
        });

      expect([403, 404]).toContain(response.status);
    });

    it("rejects spend request for asset not covered by policy", async () => {
      // Policy only covers native ETH
      const policy = await createPolicy(alice.token, "native-only", "1000000000000000000");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      // Bob tries to spend an ERC-20 token
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "erc20", tokenAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
          idempotencyKey: "wrong-asset-1"
        });

      // The request is rejected — either 400 (token not in allowlist, fails validation)
      // or 403 (policy doesn't cover the asset). Both block the unauthorized spend.
      expect([400, 403]).toContain(response.status);
    });

    it("sends spend request above auto-approve limit to pending", async () => {
      const policy = await createPolicy(alice.token, "low-limit", "1000");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "2000",
          asset: { type: "native" },
          idempotencyKey: "over-limit-1"
        });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe("pending");
    });

    it("policy with zero auto-approve limit sends all requests to pending", async () => {
      const policy = await createPolicy(alice.token, "zero-limit", "0");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1",
          asset: { type: "native" },
          idempotencyKey: "zero-limit-1"
        });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe("pending");
    });
  });

  // ---------------------------------------------------------------------------
  // Spend request decision security
  // ---------------------------------------------------------------------------

  describe("spend request decision security", () => {
    it("prevents shared user from approving their own spend request", async () => {
      const policy = await createPolicy(alice.token, "decision-test", "1");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const spendResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          asset: { type: "native" },
          idempotencyKey: "self-approve-1"
        })
        .expect(202);

      const spendRequestId = spendResponse.body.spendRequestId;

      // Bob tries to approve his own request
      const response = await request(app.server)
        .post(`/v1/spend-requests/${spendRequestId}/decision`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({ decision: "approve" });

      expect([403, 404]).toContain(response.status);
    });

    it("prevents unrelated third user from approving spend requests", async () => {
      const charlie = await registerUser("charlie@example.com");

      const policy = await createPolicy(alice.token, "third-party-test", "1");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const spendResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          asset: { type: "native" },
          idempotencyKey: "third-party-1"
        })
        .expect(202);

      // Charlie (unrelated) tries to approve
      const response = await request(app.server)
        .post(`/v1/spend-requests/${spendResponse.body.spendRequestId}/decision`)
        .set("authorization", `Bearer ${charlie.token}`)
        .send({ decision: "approve" });

      expect([403, 404]).toContain(response.status);
    });

    it("only account owner can approve/reject spend requests", async () => {
      const policy = await createPolicy(alice.token, "owner-only-test", "1");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const spendResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          asset: { type: "native" },
          idempotencyKey: "owner-approve-1"
        })
        .expect(202);

      // Alice (the owner) can reject
      const aliceResponse = await request(app.server)
        .post(`/v1/spend-requests/${spendResponse.body.spendRequestId}/decision`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ decision: "reject" });

      expect(aliceResponse.status).toBe(200);
      expect(aliceResponse.body.status).toBe("rejected");
    });
  });

  // ---------------------------------------------------------------------------
  // Revoked share edge cases
  // ---------------------------------------------------------------------------

  describe("revoked share edge cases", () => {
    it("cannot approve pending spend request after share is revoked", async () => {
      const policy = await createPolicy(alice.token, "revoke-pending", "1");
      const share = await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      // Bob creates a pending request
      const spendResponse = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          asset: { type: "native" },
          idempotencyKey: "revoke-pending-1"
        })
        .expect(202);

      // Alice revokes Bob's share
      await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares/${share.shareId}/update`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ status: "revoked" })
        .expect(200);

      // Alice tries to approve the pending request — should fail because share is revoked
      const approveResponse = await request(app.server)
        .post(`/v1/spend-requests/${spendResponse.body.spendRequestId}/decision`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ decision: "approve" });

      expect([403, 409]).toContain(approveResponse.status);
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  describe("spend request idempotency", () => {
    it("duplicate spend request with same idempotencyKey returns same result", async () => {
      const policy = await createPolicy(alice.token, "idempotency-test", "1");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      const body = {
        to: "0x0000000000000000000000000000000000000001",
        amount: "1000000000000000000",
        asset: { type: "native" },
        idempotencyKey: "idem-1"
      };

      const first = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send(body)
        .expect(202);

      const second = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send(body);

      expect(second.body.spendRequestId).toBe(first.body.spendRequestId);
    });

    it("rejects same idempotencyKey with different payload", async () => {
      const policy = await createPolicy(alice.token, "idem-conflict", "1");
      await shareAccount(alice.token, aliceAccountId, bob.user.id, [policy.policyId]);

      await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000000000000000000",
          asset: { type: "native" },
          idempotencyKey: "idem-conflict-1"
        })
        .expect(202);

      // Same key, different amount
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shared-spend-requests`)
        .set("authorization", `Bearer ${bob.token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "999",
          asset: { type: "native" },
          idempotencyKey: "idem-conflict-1"
        });

      expect(response.status).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  // Shared user cannot create policies that apply to owner's account
  // ---------------------------------------------------------------------------

  describe("policy ownership boundary", () => {
    it("shared user's policies do not affect owner's account", async () => {
      // Bob creates his own policy — it should not be usable on Alice's account
      const bobPolicy = await createPolicy(bob.token, "bob-policy", "999999999999999999");

      // Alice tries to share her account with Bob using Bob's policy
      const response = await request(app.server)
        .post(`/v1/accounts/${aliceAccountId}/shares`)
        .set("authorization", `Bearer ${alice.token}`)
        .send({ userId: bob.user.id, policyIds: [bobPolicy.policyId] });

      // Should fail because Alice doesn't own Bob's policy
      expect([403, 404]).toContain(response.status);
    });
  });
});
