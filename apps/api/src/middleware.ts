import { z } from "zod";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function parseSchema<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload);

  if (!result.success) {
    throw result.error;
  }

  return result.data;
}
