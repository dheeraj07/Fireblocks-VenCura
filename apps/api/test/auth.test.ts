import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

describe("auth module", () => {
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        host: "127.0.0.1",
        port: 0
      }
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("registers, logs in, and authenticates the current user", async () => {
    const registerResponse = await request(app.server)
      .post("/v1/auth/register")
      .send({
        email: "alice@example.com",
        password: "Password123"
      });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body.user.email).toBe("alice@example.com");
    expect(registerResponse.body.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(registerResponse.body.token).toEqual(expect.any(String));

    const walletRoot = await store.getHdWalletRootByUserId(registerResponse.body.user.id);

    expect(walletRoot).toBeDefined();
    expect(walletRoot?.userId).toBe(registerResponse.body.user.id);
    expect(walletRoot?.custodyType).toBe("local_hd");
    expect(walletRoot?.encryptedRootSecret.ciphertext).toEqual(expect.any(String));
    expect(walletRoot?.encryptedRootSecret.iv).toEqual(expect.any(String));
    expect(walletRoot?.encryptedRootSecret.authTag).toEqual(expect.any(String));
    expect(walletRoot?.encryptedRootSecret).not.toHaveProperty("phrase");
    expect(walletRoot?.nextAccountIndex).toBe(1);

    const accounts = await store.listWalletAccountsByWalletRootId(walletRoot?.id ?? "");

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      userId: registerResponse.body.user.id,
      name: "Main",
      chainId: 31337,
      accountIndex: 0,
      derivationPath: "m/44'/60'/0'/0/0"
    });
    expect(accounts[0].address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(accounts[0]).not.toHaveProperty("privateKey");

    const loginResponse = await request(app.server)
      .post("/v1/auth/login")
      .send({
        email: "alice@example.com",
        password: "Password123"
      });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.user.email).toBe("alice@example.com");
    expect(loginResponse.body.token).toEqual(expect.any(String));

    const meResponse = await request(app.server)
      .get("/v1/auth/me")
      .set("authorization", `Bearer ${loginResponse.body.token}`);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body.user.id).toBe(registerResponse.body.user.id);
    expect(meResponse.body.user.email).toBe("alice@example.com");
    expect(meResponse.body.user.createdAt).toEqual(expect.any(String));
  });

  it("rejects duplicate registrations", async () => {
    await request(app.server)
      .post("/v1/auth/register")
      .send({
        email: "alice@example.com",
        password: "Password123"
      })
      .expect(201);

    const duplicateResponse = await request(app.server)
      .post("/v1/auth/register")
      .send({
        email: "alice@example.com",
        password: "Password123"
      });

    expect(duplicateResponse.status).toBe(409);
    expect(duplicateResponse.body.error.code).toBe("EMAIL_EXISTS");
  });

  it("rejects invalid credentials, invalid payloads, and missing bearer tokens", async () => {
    const invalidPayloadResponse = await request(app.server)
      .post("/v1/auth/register")
      .send({
        email: "not-an-email",
        password: "short"
      });

    expect(invalidPayloadResponse.status).toBe(400);
    expect(invalidPayloadResponse.body.error.code).toBe("VALIDATION_ERROR");

    await request(app.server)
      .post("/v1/auth/register")
      .send({
        email: "alice@example.com",
        password: "Password123"
      })
      .expect(201);

    const invalidLoginResponse = await request(app.server)
      .post("/v1/auth/login")
      .send({
        email: "alice@example.com",
        password: "WrongPassword123"
      });

    expect(invalidLoginResponse.status).toBe(401);
    expect(invalidLoginResponse.body.error.code).toBe("INVALID_CREDENTIALS");

    const meResponse = await request(app.server).get("/v1/auth/me");

    expect(meResponse.status).toBe(401);
    expect(meResponse.body.error.code).toBe("UNAUTHORIZED");
  });
});
