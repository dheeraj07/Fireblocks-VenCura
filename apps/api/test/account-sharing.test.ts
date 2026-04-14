import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("account sharing phase 1", () => {
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
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

  async function listAccounts(token: string) {
    const response = await request(app.server)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    return response.body as {
      accounts: Array<{
        accountId: string;
        userId: string;
        accessType: "owned" | "shared";
        shareId?: string | null;
        policyIds: string[];
      }>;
    };
  }

  it("shares an owned account with an existing user as full access", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const aliceAccount = (await listAccounts(alice.token)).accounts[0];

    const shareResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        userId: bob.user.id,
        policyIds: []
      })
      .expect(201);

    expect(shareResponse.body).toMatchObject({
      accountId: aliceAccount.accountId,
      ownerUserId: alice.user.id,
      sharedUserId: bob.user.id,
      status: "active",
      policyIds: []
    });

    const sharesResponse = await request(app.server)
      .get(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${alice.token}`)
      .expect(200);

    expect(sharesResponse.body.shares).toHaveLength(1);
    expect(sharesResponse.body.shares[0]).toMatchObject({
      shareId: shareResponse.body.shareId,
      policyIds: []
    });

    const bobAccounts = await listAccounts(bob.token);
    const sharedAccount = bobAccounts.accounts.find(
      (account) => account.accountId === aliceAccount.accountId
    );

    expect(sharedAccount).toMatchObject({
      accessType: "shared",
      shareId: shareResponse.body.shareId,
      userId: alice.user.id,
      policyIds: []
    });
    expect(bobAccounts.accounts.some((account) => account.accessType === "owned")).toBe(true);
  });

  it("rejects unauthorized share creation targets", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const aliceAccount = (await listAccounts(alice.token)).accounts[0];

    const nonOwnerResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${bob.token}`)
      .send({
        userId: alice.user.id,
        policyIds: []
      });

    expect(nonOwnerResponse.status).toBe(404);
    expect(nonOwnerResponse.body.error.code).toBe("ACCOUNT_NOT_FOUND");

    const selfShareResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        userId: alice.user.id,
        policyIds: []
      });

    expect(selfShareResponse.status).toBe(400);
    expect(selfShareResponse.body.error.code).toBe("INVALID_SHARE_TARGET");

    const unknownUserResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        userId: UNKNOWN_ID,
        policyIds: []
      });

    expect(unknownUserResponse.status).toBe(404);
    expect(unknownUserResponse.body.error.code).toBe("USER_NOT_FOUND");
  });

  it("updates share policy ids and status", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const aliceAccount = (await listAccounts(alice.token)).accounts[0];
    const alicePolicy = await store.createAccountPolicy({
      ownerUserId: alice.user.id,
      name: "Native limit",
      rules: {
        assetRules: [
          {
            asset: {
              type: "native"
            },
            autoApproveLimitRaw: "10000000000000000"
          }
        ]
      }
    });
    const bobPolicy = await store.createAccountPolicy({
      ownerUserId: bob.user.id,
      name: "Bob policy",
      rules: {
        assetRules: [
          {
            asset: {
              type: "native"
            },
            autoApproveLimitRaw: "1"
          }
        ]
      }
    });

    const shareResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        userId: bob.user.id
      })
      .expect(201);

    expect(shareResponse.body.policyIds).toEqual([]);

    const invalidPolicyResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares/${shareResponse.body.shareId}/update`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        policyIds: [bobPolicy.id]
      });

    expect(invalidPolicyResponse.status).toBe(404);
    expect(invalidPolicyResponse.body.error.code).toBe("POLICY_NOT_FOUND");

    const revokedResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares/${shareResponse.body.shareId}/update`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        policyIds: [alicePolicy.id, alicePolicy.id],
        status: "revoked"
      })
      .expect(200);

    expect(revokedResponse.body).toMatchObject({
      shareId: shareResponse.body.shareId,
      status: "revoked",
      policyIds: [alicePolicy.id]
    });

    const bobRevokedAccounts = await listAccounts(bob.token);

    expect(
      bobRevokedAccounts.accounts.find((account) => account.accountId === aliceAccount.accountId)
    ).toBeUndefined();

    const reactivatedResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares/${shareResponse.body.shareId}/update`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        policyIds: [],
        status: "active"
      })
      .expect(200);

    expect(reactivatedResponse.body).toMatchObject({
      shareId: shareResponse.body.shareId,
      status: "active",
      policyIds: []
    });

    const bobActiveAccounts = await listAccounts(bob.token);
    const sharedAccount = bobActiveAccounts.accounts.find(
      (account) => account.accountId === aliceAccount.accountId
    );

    expect(sharedAccount).toMatchObject({
      accessType: "shared",
      shareId: shareResponse.body.shareId,
      policyIds: []
    });
  });
});
