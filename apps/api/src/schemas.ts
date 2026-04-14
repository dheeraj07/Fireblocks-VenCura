import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const loginSchema = registerSchema;

export const accountParamsSchema = z.object({
  accountId: z.string().uuid()
});

export const accountShareParamsSchema = z.object({
  accountId: z.string().uuid(),
  shareId: z.string().uuid()
});

export const spendRequestParamsSchema = z.object({
  spendRequestId: z.string().uuid()
});

export const policyParamsSchema = z.object({
  policyId: z.string().uuid()
});

export const transactionHashParamsSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/)
});

export const transactionHistoryQuerySchema = z.object({
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const accountTransactionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const createAccountSchema = z.object({
  name: z.string().min(1).max(120)
});

export const createAccountShareSchema = z.object({
  userId: z.string().uuid(),
  policyIds: z.array(z.string().uuid()).default([])
});

export const updateAccountShareSchema = z
  .object({
    policyIds: z.array(z.string().uuid()).optional(),
    status: z.enum(["active", "revoked"]).optional()
  })
  .refine((body) => body.policyIds !== undefined || body.status !== undefined, {
    message: "At least one share update field is required."
  });

const policyAssetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("native")
  }),
  z.object({
    type: z.literal("erc20"),
    tokenAddress: z.string().min(1)
  })
]);

const policyRulesSchema = z.object({
  assetRules: z
    .array(
      z.object({
        asset: policyAssetSchema,
        autoApproveLimitRaw: z.string().regex(/^[0-9]+$/)
      })
    )
    .min(1)
});

export const createPolicySchema = z.object({
  name: z.string().min(1).max(120),
  rules: policyRulesSchema
});

export const updatePolicySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    rules: policyRulesSchema.optional()
  })
  .refine((body) => body.name !== undefined || body.rules !== undefined, {
    message: "At least one policy update field is required."
  });

export const spendRequestDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"])
});

export const signMessageSchema = z.object({
  message: z.string().min(1),
  idempotencyKey: z.string().min(1).max(255)
});

export const sendTransactionSchema = z.object({
  to: z.string().min(1),
  amount: z.string().regex(/^[0-9]+$/),
  asset: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("native")
    }),
    z.object({
      type: z.literal("erc20"),
      tokenAddress: z.string().min(1)
    })
  ]),
  idempotencyKey: z.string().min(1).max(255)
});
