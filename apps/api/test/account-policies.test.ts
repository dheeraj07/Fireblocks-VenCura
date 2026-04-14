import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { AppStore } from "../src/store/store";
import { createTestMysqlStore } from "./support/test-mysql-store";

const TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111";
const UNSUPPORTED_TOKEN_ADDRESS = "0x2222222222222222222222222222222222222222";

describe("account policy CRUD phase", () => {
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    ({ store } = await createTestMysqlStore());
    app = createApp({
      store,
      config: {
        jwtSecret: "test-jwt-secret",
        encryptionSecret: "test-encryption-secret",
        supportedErc20Tokens: [TOKEN_ADDRESS],
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
      }>;
    };
  }

  it("creates and lists policies for the authenticated owner", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");

    const createResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: " Ops limit ",
        rules: {
          assetRules: [
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: "00050000000000000000"
            },
            {
              asset: {
                type: "erc20",
                tokenAddress: TOKEN_ADDRESS
              },
              autoApproveLimitRaw: "1000000"
            }
          ]
        }
      })
      .expect(201);

    expect(createResponse.body).toMatchObject({
      ownerUserId: alice.user.id,
      name: "Ops limit",
      rules: {
        assetRules: [
          {
            asset: {
              type: "native"
            },
            autoApproveLimitRaw: "50000000000000000"
          },
          {
            asset: {
              type: "erc20",
              tokenAddress: TOKEN_ADDRESS
            },
            autoApproveLimitRaw: "1000000"
          }
        ]
      }
    });

    const aliceListResponse = await request(app.server)
      .get("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .expect(200);

    expect(aliceListResponse.body.policies).toHaveLength(1);
    expect(aliceListResponse.body.policies[0].policyId).toBe(createResponse.body.policyId);

    const bobListResponse = await request(app.server)
      .get("/v1/policies")
      .set("authorization", `Bearer ${bob.token}`)
      .expect(200);

    expect(bobListResponse.body.policies).toEqual([]);
  });

  it("updates only policies owned by the authenticated user", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const createResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Ops limit",
        rules: {
          assetRules: [
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: "50000000000000000"
            }
          ]
        }
      })
      .expect(201);

    const bobUpdateResponse = await request(app.server)
      .post(`/v1/policies/${createResponse.body.policyId}/update`)
      .set("authorization", `Bearer ${bob.token}`)
      .send({
        name: "Bob update"
      });

    expect(bobUpdateResponse.status).toBe(404);
    expect(bobUpdateResponse.body.error.code).toBe("POLICY_NOT_FOUND");

    const aliceUpdateResponse = await request(app.server)
      .post(`/v1/policies/${createResponse.body.policyId}/update`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Updated limit",
        rules: {
          assetRules: [
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: "0"
            }
          ]
        }
      })
      .expect(200);

    expect(aliceUpdateResponse.body).toMatchObject({
      policyId: createResponse.body.policyId,
      ownerUserId: alice.user.id,
      name: "Updated limit",
      rules: {
        assetRules: [
          {
            asset: {
              type: "native"
            },
            autoApproveLimitRaw: "0"
          }
        ]
      }
    });
  });

  it("rejects invalid policy rules", async () => {
    const alice = await registerUser("alice@example.com");

    const emptyRulesResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Empty",
        rules: {
          assetRules: []
        }
      });

    expect(emptyRulesResponse.status).toBe(400);
    expect(emptyRulesResponse.body.error.code).toBe("VALIDATION_ERROR");

    const duplicateRulesResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Duplicate",
        rules: {
          assetRules: [
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: "1"
            },
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: "2"
            }
          ]
        }
      });

    expect(duplicateRulesResponse.status).toBe(400);
    expect(duplicateRulesResponse.body.error.code).toBe("DUPLICATE_POLICY_ASSET");

    const invalidTokenResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Invalid token",
        rules: {
          assetRules: [
            {
              asset: {
                type: "erc20",
                tokenAddress: "not-an-address"
              },
              autoApproveLimitRaw: "1"
            }
          ]
        }
      });

    expect(invalidTokenResponse.status).toBe(400);
    expect(invalidTokenResponse.body.error.code).toBe("INVALID_TOKEN_ADDRESS");

    const unsupportedTokenResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Unsupported token",
        rules: {
          assetRules: [
            {
              asset: {
                type: "erc20",
                tokenAddress: UNSUPPORTED_TOKEN_ADDRESS
              },
              autoApproveLimitRaw: "1"
            }
          ]
        }
      });

    expect(unsupportedTokenResponse.status).toBe(400);
    expect(unsupportedTokenResponse.body.error.code).toBe("UNSUPPORTED_TOKEN");
  });

  it("uses API-created policies when sharing accounts", async () => {
    const alice = await registerUser("alice@example.com");
    const bob = await registerUser("bob@example.com");
    const aliceAccount = (await listAccounts(alice.token)).accounts[0];
    const policyResponse = await request(app.server)
      .post("/v1/policies")
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        name: "Native limit",
        rules: {
          assetRules: [
            {
              asset: {
                type: "native"
              },
              autoApproveLimitRaw: "50000000000000000"
            }
          ]
        }
      })
      .expect(201);

    const shareResponse = await request(app.server)
      .post(`/v1/accounts/${aliceAccount.accountId}/shares`)
      .set("authorization", `Bearer ${alice.token}`)
      .send({
        userId: bob.user.id,
        policyIds: [policyResponse.body.policyId]
      })
      .expect(201);

    expect(shareResponse.body).toMatchObject({
      accountId: aliceAccount.accountId,
      policyIds: [policyResponse.body.policyId],
      sharedUserId: bob.user.id
    });
  });
});
