/**
 * Register a production host and print its agent token ONCE (only a hash is stored).
 *
 *   bun run host:register --name db-prod-1 --display-name "DB primary" --environment production
 */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { AGENT_TOKEN_PREFIX, generateToken, sha256Hex } from "../src/api/lib/crypto";
import { loadDatabaseUrl } from "../src/config";
import { agents, auditLogs, createDatabase, monitoredHosts } from "../src/db";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    "display-name": { type: "string" },
    environment: { type: "string" },
    "agent-name": { type: "string", default: "default" },
  },
});
const name = values.name?.trim();
if (!name || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
  throw new Error("--name is required (lowercase letters, digits, . _ -)");
}

const handle = createDatabase(loadDatabaseUrl(), { poolMax: 1, applicationName: "system-monitor-cli" });
try {
  const token = generateToken(AGENT_TOKEN_PREFIX);
  const result = await handle.db.transaction(async (tx) => {
    let [host] = await tx
      .insert(monitoredHosts)
      .values({ name, displayName: values["display-name"] ?? null, environment: values.environment ?? null })
      .onConflictDoNothing()
      .returning();
    const existing = !host;
    if (!host) {
      [host] = await tx.select().from(monitoredHosts).where(eq(monitoredHosts.name, name));
    }
    if (!host) throw new Error("host lookup failed");
    const [agent] = await tx
      .insert(agents)
      .values({
        hostId: host.id,
        name: values["agent-name"] ?? "default",
        tokenHash: sha256Hex(token),
        tokenPrefix: token.slice(0, 12),
      })
      .returning();
    if (!agent) throw new Error("agent creation failed (does an agent with this name already exist?)");
    await tx.insert(auditLogs).values({
      actorType: "system",
      action: "agent.create",
      targetType: "agent",
      targetId: agent.id,
      metadata: { hostId: host.id, via: "cli" },
    });
    return { host, agent, existing };
  });
  console.log(`${result.existing ? "Existing" : "New"} host: ${result.host.name} (${result.host.id})`);
  console.log(`Agent:     ${result.agent.name} (${result.agent.id})`);
  console.log("\nAgent token (shown once – store it in the agent's credential file):\n");
  console.log(token);
} finally {
  await handle.close();
}
