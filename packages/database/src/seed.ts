import { createRuleSchema } from "@system-monitor/shared";
import type { Executor } from "./client";
import { DEFAULT_RULES } from "./default-rules";
import { alertRules } from "./schema";

/** Idempotent: existing rules (matched by name) are never overwritten. */
export async function seedDefaultRules(db: Executor): Promise<number> {
  const rows = DEFAULT_RULES.map((rule) => createRuleSchema.parse(rule));
  const inserted = await db
    .insert(alertRules)
    .values(rows)
    .onConflictDoNothing({ target: alertRules.name })
    .returning({ id: alertRules.id });
  return inserted.length;
}
