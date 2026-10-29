import { ConfigError, loadApiConfig } from "../config";
import { createDatabase } from "../db";
import { createLogger } from "../shared";
import { createApp } from "./app";

let config: ReturnType<typeof loadApiConfig>;
try {
  config = loadApiConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "failed to load configuration");
  process.exit(78);
}

const log = createLogger({ level: config.logLevel, base: { service: "api" } });
const database = createDatabase(config.database.url, {
  poolMax: config.database.poolMax,
  applicationName: "system-monitor-api",
});
const app = createApp({ db: database.db, config, log, pingDb: () => database.ping() });

const server = Bun.serve({
  hostname: config.http.host,
  port: config.http.port,
  maxRequestBodySize: config.http.maxBodyBytes,
  idleTimeout: 30,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
});
log.info("api listening", { host: config.http.host, port: server.port });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("api shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  try {
    await server.stop(); // stop accepting connections, let in-flight requests finish
    await database.close(5);
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
