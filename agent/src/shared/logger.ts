export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|api[_-]?key|credential|dsn|database_?url/i;
const REDACTED = "[REDACTED]";

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Recursively redacts values under sensitive-looking keys and serialises errors safely. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Truncated]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Strip credentials embedded in URLs and bearer tokens that might leak into messages. */
export function redactString(input: string): string {
  return input
    .replace(/(\w+:\/\/)([^/\s:@]+):([^@\s/]+)@/g, `$1$2:${REDACTED}@`)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/(access_token=)[^&\s]+/gi, `$1${REDACTED}`);
}

export function createLogger(
  options: { level?: LogLevel; base?: LogFields; write?: (line: string) => void } = {},
): Logger {
  const min = LEVELS[options.level ?? "info"];
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const log = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < min) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact({ ...base, ...fields }) as LogFields),
    };
    try {
      write(JSON.stringify(entry));
    } catch {
      write(JSON.stringify({ ts: entry.ts, level, msg, logError: "unserialisable fields" }));
    }
  };

  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
