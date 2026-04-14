import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

describe("security: input validation and injection prevention", () => {
  let app: FastifyInstance;
  let store: AppStore;

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
  });

  afterEach(async () => {
    await app.close();
  });

  async function registerUser(email = "secuser@example.com") {
    const response = await request(app.server)
      .post("/v1/auth/register")
      .send({ email, password: "Password123" })
      .expect(201);
    return response.body as { token: string; user: { id: string; email: string } };
  }

  async function getAuthToken(): Promise<string> {
    const auth = await registerUser();
    return auth.token;
  }

  async function listAccounts(token: string) {
    const response = await request(app.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    return response.body as { accounts: Array<{ accountId: string; name: string; address: string }> };
  }

  // ---------------------------------------------------------------------------
  // SQL Injection
  // ---------------------------------------------------------------------------

  describe("SQL injection prevention", () => {
    it("rejects SQL injection in email field", async () => {
      const response = await request(app.server)
        .post("/v1/auth/register")
        .send({ email: "admin@test.com'; DROP TABLE users; --", password: "Password123" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("stores SQL injection string in account name without executing SQL", async () => {
      const token = await getAuthToken();

      const response = await request(app.server)
        .post("/v1/accounts")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "'; DROP TABLE wallet_accounts; --" });

      // Valid string (1-120 chars) so it should succeed. Parameterized queries protect.
      expect(response.status).toBe(201);
      expect(response.body.name).toBe("'; DROP TABLE wallet_accounts; --");

      // Verify the table still exists
      const accounts = await listAccounts(token);
      expect(accounts.accounts.find((a) => a.name === "'; DROP TABLE wallet_accounts; --")).toBeDefined();
    });

    it("rejects SQL injection in path parameters requiring UUID", async () => {
      const token = await getAuthToken();

      const response = await request(app.server)
        .get("/v1/accounts/1 OR 1=1/balances")
        .set("authorization", `Bearer ${token}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // XSS
  // ---------------------------------------------------------------------------

  describe("XSS prevention", () => {
    it("rejects XSS payload in email field", async () => {
      const response = await request(app.server)
        .post("/v1/auth/register")
        .send({ email: "<script>alert('xss')</script>@test.com", password: "Password123" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("stores XSS payload in account name without crashing", async () => {
      const token = await getAuthToken();

      const response = await request(app.server)
        .post("/v1/accounts")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "<script>alert(1)</script>" });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe("<script>alert(1)</script>");
    });

    it("accepts XSS payload in message signing", async () => {
      const token = await getAuthToken();
      const accounts = await listAccounts(token);
      const accountId = accounts.accounts[0].accountId;

      const response = await request(app.server)
        .post(`/v1/accounts/${accountId}/sign-message`)
        .set("authorization", `Bearer ${token}`)
        .send({ message: "<img onerror=alert(1) src=x>", idempotencyKey: "xss-sign-1" });

      // Messages are arbitrary strings — must not be a validation error
      expect(response.status).not.toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid UUID Parameters
  // ---------------------------------------------------------------------------

  describe("invalid UUID parameter validation", () => {
    it("rejects non-UUID accountId on balance endpoint", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .get("/v1/accounts/not-a-uuid/balances")
        .set("authorization", `Bearer ${token}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects non-UUID accountId on transactions endpoint", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .get("/v1/accounts/not-a-uuid/transactions")
        .set("authorization", `Bearer ${token}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects non-UUID shareId on share update endpoint", async () => {
      const token = await getAuthToken();
      const accounts = await listAccounts(token);
      const response = await request(app.server)
        .post(`/v1/accounts/${accounts.accounts[0].accountId}/shares/abc/update`)
        .set("authorization", `Bearer ${token}`)
        .send({ status: "revoked" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects non-UUID policyId on policy update endpoint", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/policies/123/update")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "Updated" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects non-UUID spendRequestId on decision endpoint", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/spend-requests/xyz/decision")
        .set("authorization", `Bearer ${token}`)
        .send({ decision: "approve" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid Request Bodies
  // ---------------------------------------------------------------------------

  describe("invalid request body validation", () => {
    it("rejects empty body on register", async () => {
      const response = await request(app.server).post("/v1/auth/register").send({});
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects register with missing password", async () => {
      const response = await request(app.server)
        .post("/v1/auth/register")
        .send({ email: "valid@example.com" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects register with password shorter than 8 characters", async () => {
      const response = await request(app.server)
        .post("/v1/auth/register")
        .send({ email: "valid@example.com", password: "short" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects register with invalid email format", async () => {
      const response = await request(app.server)
        .post("/v1/auth/register")
        .send({ email: "not-an-email", password: "Password123" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects create account with empty name", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/accounts")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects create account with name exceeding 120 characters", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/accounts")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "A".repeat(121) });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction Validation
  // ---------------------------------------------------------------------------

  describe("transaction input validation", () => {
    it("rejects negative amount", async () => {
      const token = await getAuthToken();
      const accounts = await listAccounts(token);
      const response = await request(app.server)
        .post(`/v1/accounts/${accounts.accounts[0].accountId}/send-transaction`)
        .set("authorization", `Bearer ${token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "-100",
          asset: { type: "native" },
          idempotencyKey: "neg-1"
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects float amount", async () => {
      const token = await getAuthToken();
      const accounts = await listAccounts(token);
      const response = await request(app.server)
        .post(`/v1/accounts/${accounts.accounts[0].accountId}/send-transaction`)
        .set("authorization", `Bearer ${token}`)
        .send({
          to: "0x0000000000000000000000000000000000000001",
          amount: "1.5",
          asset: { type: "native" },
          idempotencyKey: "float-1"
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects sign-message without idempotencyKey", async () => {
      const token = await getAuthToken();
      const accounts = await listAccounts(token);
      const response = await request(app.server)
        .post(`/v1/accounts/${accounts.accounts[0].accountId}/sign-message`)
        .set("authorization", `Bearer ${token}`)
        .send({ message: "hello world" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects sign-message with empty message", async () => {
      const token = await getAuthToken();
      const accounts = await listAccounts(token);
      const response = await request(app.server)
        .post(`/v1/accounts/${accounts.accounts[0].accountId}/sign-message`)
        .set("authorization", `Bearer ${token}`)
        .send({ message: "", idempotencyKey: "empty-msg-1" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction Hash Validation
  // ---------------------------------------------------------------------------

  describe("transaction hash parameter validation", () => {
    it("rejects invalid tx hash format", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .get("/v1/transactions/hash/not-a-hash")
        .set("authorization", `Bearer ${token}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects short tx hash", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .get("/v1/transactions/hash/0xabc")
        .set("authorization", `Bearer ${token}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("handles valid-format nonexistent tx hash without crashing", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .get(`/v1/transactions/hash/0x${"a".repeat(64)}`)
        .set("authorization", `Bearer ${token}`);

      expect([404, 200]).toContain(response.status);
      expect(response.status).not.toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // Policy Validation
  // ---------------------------------------------------------------------------

  describe("policy input validation", () => {
    it("rejects policy with empty assetRules array", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/policies")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "Empty rules", rules: { assetRules: [] } });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects policy with invalid asset type", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/policies")
        .set("authorization", `Bearer ${token}`)
        .send({
          name: "Bad type",
          rules: { assetRules: [{ asset: { type: "unknown" }, autoApproveLimitRaw: "1000" }] }
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects policy with non-numeric autoApproveLimitRaw", async () => {
      const token = await getAuthToken();
      const response = await request(app.server)
        .post("/v1/policies")
        .set("authorization", `Bearer ${token}`)
        .send({
          name: "Bad limit",
          rules: { assetRules: [{ asset: { type: "native" }, autoApproveLimitRaw: "abc" }] }
        });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

});
