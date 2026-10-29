/**
 * Create (or reset) a dashboard user. The password is read from stdin so it never appears in
 * shell history or the process list:
 *
 *   printf '%s' "$PASSWORD" | bun run user:create --email ops@example.com --role admin --name "Ops"
 */
import { parseArgs } from "node:util";
import { loadDatabaseUrl } from "@system-monitor/config";
import { auditLogs, createDatabase, users } from "@system-monitor/database";
import { USER_ROLES, type UserRole } from "@system-monitor/shared";
import { eq } from "drizzle-orm";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    role: { type: "string", default: "viewer" },
    name: { type: "string" },
    "reset-password": { type: "boolean", default: false },
  },
});

const email = values.email?.trim().toLowerCase();
const role = values.role as UserRole;
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email is required");
if (!USER_ROLES.includes(role)) throw new Error(`--role must be one of ${USER_ROLES.join(", ")}`);

const password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
if (password.length < 12) throw new Error("password (from stdin) must be at least 12 characters");
if (password.length > 256) throw new Error("password is too long");

const handle = createDatabase(loadDatabaseUrl(), { poolMax: 1, applicationName: "system-monitor-cli" });
try {
  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const [existing] = await handle.db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing && !values["reset-password"]) {
    throw new Error("user exists; pass --reset-password to change the password and role");
  }
  const [user] = existing
    ? await handle.db
        .update(users)
        .set({ passwordHash, role, disabled: false })
        .where(eq(users.id, existing.id))
        .returning()
    : await handle.db
        .insert(users)
        .values({ email, role, passwordHash, displayName: values.name ?? null })
        .returning();
  if (!user) throw new Error("failed to save user");
  await handle.db.insert(auditLogs).values({
    actorType: "system",
    action: existing ? "user.password_reset" : "user.create",
    targetType: "user",
    targetId: user.id,
    metadata: { email, role, via: "cli" },
  });
  console.log(`${existing ? "updated" : "created"} ${role} user ${email} (${user.id})`);
} finally {
  await handle.close();
}
