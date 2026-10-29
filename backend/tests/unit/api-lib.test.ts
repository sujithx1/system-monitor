import { describe, expect, test } from "bun:test";
import { maskPhone, safeEqual } from "../../src/api/lib/crypto";
import { computeHealth } from "../../src/api/lib/hosts";
import { decodeCursor, encodeCursor, toPage } from "../../src/api/lib/pagination";
import { RateLimiter } from "../../src/api/lib/rate-limit";

describe("API helpers", () => {
  test("rate limiter allows N per window then blocks", () => {
    const rl = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3].map(() => rl.hit("k", t).allowed)).toEqual([true, true, true]);
    expect(rl.hit("k", t)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(rl.hit("other", t).allowed).toBe(true);
    expect(rl.isLimited("k", t)).toBe(true);
    expect(rl.isLimited("other", t)).toBe(false);
    expect(rl.hit("k", t + 60_001).allowed).toBe(true);
  });

  test("cursor round-trip and tamper detection", () => {
    const id = crypto.randomUUID();
    const c = encodeCursor(new Date("2026-10-28T12:00:00Z"), id);
    expect(decodeCursor(c)).toEqual({ t: "2026-10-28T12:00:00.000Z", id });
    expect(() => decodeCursor("not-a-cursor")).toThrow();
    expect(() => decodeCursor(Buffer.from('{"t":"x","id":"1; DROP TABLE"}').toString("base64url"))).toThrow();
  });

  test("toPage returns a cursor only when more rows exist", () => {
    const rows = [1, 2, 3].map((n) => ({ t: new Date(n * 1000), id: crypto.randomUUID() }));
    expect(toPage(rows, 3, (r) => r).nextCursor).toBeNull();
    const page = toPage(rows, 2, (r) => r);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor ?? undefined)?.id).toBe(rows[1]?.id);
  });

  test("phone masking and constant-time compare", () => {
    expect(maskPhone("+919876543210")).toBe("+91******3210");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  test("host health precedence", () => {
    const now = new Date();
    const seen = { enabled: true, lastHeartbeatAt: new Date(now.getTime() - 10_000) };
    expect(computeHealth({ ...seen, enabled: false }, "critical", now, 180)).toBe("disabled");
    expect(computeHealth({ enabled: true, lastHeartbeatAt: null }, null, now, 180)).toBe("unknown");
    expect(
      computeHealth({ enabled: true, lastHeartbeatAt: new Date(now.getTime() - 200_000) }, null, now, 180),
    ).toBe("offline");
    expect(computeHealth(seen, "critical", now, 180)).toBe("critical");
    expect(computeHealth(seen, "warning", now, 180)).toBe("warning");
    expect(computeHealth(seen, null, now, 180)).toBe("healthy");
  });
});
