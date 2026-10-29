import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const AGENT_TOKEN_PREFIX = "ima_";
export const SESSION_TOKEN_PREFIX = "ims_";

export function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still do a comparison so timing does not reveal where the mismatch was detected.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(secret: string, payload: string | Uint8Array): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `+${digits.slice(0, 2)}${"*".repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}
