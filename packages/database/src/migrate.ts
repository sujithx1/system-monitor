/**
 * Controlled migration step: `bun run db:migrate` (or `docker compose run --rm migrate`).
 * Runs as the schema owner (DATABASE_URL_MIGRATE), never as the application role.
 */
import { join } from "node:path";
import { createLogger } from "@system-monitor/shared";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client";
import { seedDefaultRules } from "./seed";

export async function runMigrations(url: string, options: { seed?: boolean; appRole?: string } = {}) {
  const handle = createDatabase(url, { poolMax: 1, applicationName: "system-monitor-migrate" });
  try {
    await migrate(handle.db, { migrationsFolder: join(import.meta.dir, "../migrations") });
    const role = options.appRole;
    if (role) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error("invalid application role name");
      // Least privilege for the runtime role: DML only, and the audit trail is append-only.
      // The name is validated above, so quoting it as an identifier is safe.
      const exists = await handle.db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`);
      if (exists.length > 0) {
        const ident = sql.raw(`"${role}"`);
        await handle.db.execute(sql`GRANT USAGE ON SCHEMA public TO ${ident}`);
        await handle.db.execute(
          sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`,
        );
        await handle.db.execute(sql`REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM ${ident}`);
      }
    }
    if (options.seed !== false) await seedDefaultRules(handle.db);
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  const log = createLogger({ base: { service: "migrate" } });
  const url = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) {
    log.error("DATABASE_URL_MIGRATE (or DATABASE_URL) is required");
    process.exit(1);
  }
  runMigrations(url, { appRole: process.env.APP_DB_ROLE })
    .then(() => log.info("migrations applied"))
    .catch((error) => {
      log.error("migration failed", { error });
      process.exit(1);
    });
}
