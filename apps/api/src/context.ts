import type { ApiConfig } from "@system-monitor/config";
import type { Database } from "@system-monitor/database";
import type { Logger, UserRole } from "@system-monitor/shared";

export interface Deps {
  db: Database;
  config: ApiConfig;
  log: Logger;
  /** Readiness probe for the monitoring database. */
  pingDb: () => Promise<void>;
  now?: () => Date;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  sessionId: string;
}

export interface AuthAgent {
  id: string;
  hostId: string;
  hostName: string;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    ip: string;
    log: Logger;
    user: AuthUser;
    agent: AuthAgent;
  };
};
