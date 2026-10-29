import { auditLogs, type Executor } from "../../db";

export interface AuditEntry {
  actorType: "user" | "agent" | "system";
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export async function audit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    metadata: entry.metadata ?? {},
  });
}
