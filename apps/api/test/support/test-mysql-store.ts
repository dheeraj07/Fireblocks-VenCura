import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { createPool, type Pool } from "mysql2/promise";

import { MysqlStore } from "../../src/store/mysql-store";

let container: StartedMySqlContainer | undefined;
let dbCounter = 0;

async function getContainer(): Promise<StartedMySqlContainer> {
  if (!container) {
    container = await new MySqlContainer("mysql:8.0")
      .withDatabase("fireblock_test")
      .withRootPassword("root")
      .start();
  }
  return container;
}

export async function createTestMysqlStore(): Promise<{
  store: MysqlStore;
  pool: Pool;
}> {
  const c = await getContainer();
  dbCounter += 1;
  const dbName = `test_db_${dbCounter}_${Date.now()}`;

  const adminPool = createPool({
    host: c.getHost(),
    port: c.getMappedPort(3306),
    user: "root",
    password: "root"
  });

  await adminPool.execute(`CREATE DATABASE \`${dbName}\``);
  await adminPool.end();

  const pool = createPool({
    host: c.getHost(),
    port: c.getMappedPort(3306),
    user: "root",
    password: "root",
    database: dbName,
    timezone: "Z"
  });

  const store = new MysqlStore({ pool });
  return { store, pool };
}

export async function createPersistentTestPool(): Promise<Pool> {
  const c = await getContainer();
  dbCounter += 1;
  const dbName = `test_db_${dbCounter}_${Date.now()}`;

  const adminPool = createPool({
    host: c.getHost(),
    port: c.getMappedPort(3306),
    user: "root",
    password: "root"
  });

  await adminPool.execute(`CREATE DATABASE \`${dbName}\``);
  await adminPool.end();

  return createPool({
    host: c.getHost(),
    port: c.getMappedPort(3306),
    user: "root",
    password: "root",
    database: dbName,
    timezone: "Z"
  });
}
