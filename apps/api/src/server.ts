import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {
  // .env file not required when env vars are injected (e.g. Railway)
}

import { createApp } from "./app";

async function start() {
  const app = createApp();
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({ host, port });
    console.log(`Server listening on ${host}:${port}`);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

void start();
