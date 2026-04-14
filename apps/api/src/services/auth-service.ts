import argon2 from "argon2";
import { jwtVerify, SignJWT } from "jose";

import { AppError } from "../lib/errors";
import type { AuthTokenPayload, UserRecord } from "../types";

export class AuthService {
  private readonly secret: Uint8Array;

  constructor(jwtSecret: string) {
    this.secret = new TextEncoder().encode(jwtSecret);
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password);
  }

  async verifyPassword(password: string, passwordHash: string): Promise<boolean> {
    return argon2.verify(passwordHash, password);
  }

  async issueToken(user: UserRecord): Promise<string> {
    return new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(this.secret);
  }

  async verifyToken(token: string): Promise<AuthTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      const subject = payload.sub;
      const email = payload.email;

      if (!subject || typeof email !== "string") {
        throw new AppError(401, "INVALID_TOKEN", "Invalid authentication token.");
      }

      return {
        sub: subject,
        email
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(401, "INVALID_TOKEN", "Invalid authentication token.");
    }
  }
}
