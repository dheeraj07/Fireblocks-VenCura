import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

const FAKE_UUID = "00000000-0000-0000-0000-000000000000";
const FAKE_TX_HASH = "0x" + "a".repeat(64);

describe("security: authentication & authorization", () => {
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

  describe("public endpoints remain accessible", () => {
    it("GET /health works without auth", async () => {
      const response = await request(app.server).get("/health").expect(200);
      expect(response.body.status).toBe("ok");
    });

    it("POST /v1/auth/register works without auth", async () => {
      const response = await request(app.server)
        .post("/v1/auth/register")
        .send({ email: "new@example.com", password: "Password123" });
      expect(response.status).toBe(201);
    });

    it("POST /v1/auth/login works without auth", async () => {
      await registerUser("login@example.com");
      const response = await request(app.server)
        .post("/v1/auth/login")
        .send({ email: "login@example.com", password: "Password123" });
      expect(response.status).toBe(200);
    });
  });

  describe("unauthenticated access to protected endpoints", () => {
    const protectedEndpoints: Array<{ method: "get" | "post"; path: string; body?: object }> = [
      { method: "get", path: "/v1/auth/me" },
      { method: "get", path: "/v1/accounts" },
      { method: "post", path: "/v1/accounts", body: { name: "test" } },
      { method: "get", path: `/v1/accounts/${FAKE_UUID}/balances` },
      { method: "get", path: `/v1/accounts/${FAKE_UUID}/transactions` },
      {
        method: "post",
        path: `/v1/accounts/${FAKE_UUID}/sign-message`,
        body: { message: "test", idempotencyKey: "k1" }
      },
      {
        method: "post",
        path: `/v1/accounts/${FAKE_UUID}/send-transaction`,
        body: {
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "native" },
          idempotencyKey: "k1"
        }
      },
      {
        method: "post",
        path: `/v1/accounts/${FAKE_UUID}/shares`,
        body: { userId: FAKE_UUID, policyIds: [] }
      },
      { method: "get", path: `/v1/accounts/${FAKE_UUID}/shares` },
      {
        method: "post",
        path: `/v1/accounts/${FAKE_UUID}/shares/${FAKE_UUID}/update`,
        body: { status: "revoked" }
      },
      {
        method: "post",
        path: `/v1/accounts/${FAKE_UUID}/shared-spend-requests`,
        body: {
          to: "0x0000000000000000000000000000000000000001",
          amount: "1000",
          asset: { type: "native" },
          idempotencyKey: "k1"
        }
      },
      {
        method: "post",
        path: "/v1/policies",
        body: {
          name: "test",
          rules: { assetRules: [{ asset: { type: "native" }, autoApproveLimitRaw: "1000" }] }
        }
      },
      { method: "get", path: "/v1/policies" },
      {
        method: "post",
        path: `/v1/policies/${FAKE_UUID}/update`,
        body: { name: "updated" }
      },
      { method: "get", path: "/v1/spend-requests" },
      {
        method: "post",
        path: `/v1/spend-requests/${FAKE_UUID}/decision`,
        body: { decision: "approve" }
      },
      { method: "get", path: "/v1/transactions" },
      { method: "get", path: `/v1/transactions/hash/${FAKE_TX_HASH}` }
    ];

    for (const endpoint of protectedEndpoints) {
      it(`${endpoint.method.toUpperCase()} ${endpoint.path} returns 401 without token`, async () => {
        const req = request(app.server)[endpoint.method](endpoint.path);
        if (endpoint.body) {
          req.send(endpoint.body);
        }
        const response = await req;
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe("UNAUTHORIZED");
      });
    }
  });

  describe("invalid token formats", () => {
    it("rejects empty Bearer token", async () => {
      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", "Bearer ");
      expect(response.status).toBe(401);
    });

    it("rejects malformed JWT string", async () => {
      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", "Bearer not.a.jwt");
      expect(response.status).toBe(401);
    });

    it("rejects random string as token", async () => {
      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", "Bearer abcdef123456");
      expect(response.status).toBe(401);
    });

    it("rejects non-Bearer auth scheme", async () => {
      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", "Basic dXNlcjpwYXNz");
      expect(response.status).toBe(401);
    });

    it("rejects token signed with wrong secret", async () => {
      const wrongSecret = new TextEncoder().encode("wrong-secret");
      const forgedToken = await new SignJWT({ email: "forged@example.com" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(FAKE_UUID)
        .setIssuedAt()
        .setExpirationTime("12h")
        .sign(wrongSecret);

      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", `Bearer ${forgedToken}`);
      expect(response.status).toBe(401);
    });

    it("rejects expired token", async () => {
      const secret = new TextEncoder().encode("test-jwt-secret");
      const expiredToken = await new SignJWT({ email: "expired@example.com" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(FAKE_UUID)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 86400)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(secret);

      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", `Bearer ${expiredToken}`);
      expect(response.status).toBe(401);
    });

    it("rejects token with valid signature but non-existent user", async () => {
      const secret = new TextEncoder().encode("test-jwt-secret");
      const ghostToken = await new SignJWT({ email: "ghost@example.com" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(FAKE_UUID)
        .setIssuedAt()
        .setExpirationTime("12h")
        .sign(secret);

      const response = await request(app.server)
        .get("/v1/accounts")
        .set("authorization", `Bearer ${ghostToken}`);
      expect(response.status).toBe(401);
    });
  });

  describe("cross-instance token isolation", () => {
    it("token from one app rejected by another app with different JWT secret", async () => {
      const { store: store2 } = await createTestMysqlStore();
      const app2 = createApp({
        store: store2,
        config: {
          jwtSecret: "different-jwt-secret",
          encryptionSecret: "test-encryption-secret",
          rpcUrl: "http://127.0.0.1:8545",
          host: "127.0.0.1",
          port: 0
        }
      });
      await app2.ready();

      try {
        const auth = await registerUser("cross@example.com");

        const response = await request(app2.server)
          .get("/v1/accounts")
          .set("authorization", `Bearer ${auth.token}`);

        expect(response.status).toBe(401);
      } finally {
        await app2.close();
      }
    });
  });
});
