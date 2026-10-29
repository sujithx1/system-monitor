import type { HttpCheckConfig } from "../config";
import { describeError, type MetricSample, sample, unavailable } from "../shared";
import { round } from "./cpu";

export function isExpectedStatus(status: number, expected?: number[]): boolean {
  return expected && expected.length > 0 ? expected.includes(status) : status >= 200 && status < 400;
}

export async function checkHttp(
  check: HttpCheckConfig,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MetricSample[]> {
  const r = check.name;
  const started = performance.now();
  try {
    const res = await fetchImpl(check.url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": userAgent, accept: "*/*" },
      signal: AbortSignal.timeout(check.timeoutMs),
    });
    const latency = round(performance.now() - started);
    await res.body?.cancel().catch(() => {});
    const ok = isExpectedStatus(res.status, check.expectedStatus);
    return [
      ok
        ? sample("http.up", 1, r)
        : { ...sample("http.up", 0, r), error: `unexpected HTTP status ${res.status}` },
      sample("http.latency_ms", latency, r),
      sample("http.status_code", res.status, r),
    ];
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError"
        ? `timed out after ${check.timeoutMs} ms`
        : describeError(error);
    return [
      { ...sample("http.up", 0, r), error: reason },
      unavailable("http.latency_ms", reason, r),
      unavailable("http.status_code", reason, r),
    ];
  }
}
