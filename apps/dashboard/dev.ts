/**
 * Development server: serves the dashboard with Bun's HTML bundler (HMR, source maps) and
 * proxies API calls to the monitoring API so the session cookie stays same-origin.
 *
 *   API_URL=http://127.0.0.1:3000 bun ./dev.ts      (DASHBOARD_PORT overrides the default port 5173)
 */
import index from "./src/index.html";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:3000";
const PORT = Number(process.env.DASHBOARD_PORT ?? 5173);

/** Hop-by-hop headers (RFC 9110 §7.6.1) and headers that `fetch` recomputes. */
const DROP_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
];
/** `fetch` transparently decompresses, so the upstream encoding/length no longer describe the body. */
const DROP_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

async function proxy(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(incoming.pathname + incoming.search, API_URL);
  const headers = new Headers(req.headers);
  for (const name of DROP_REQUEST_HEADERS) headers.delete(name);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of DROP_RESPONSE_HEADERS) responseHeaders.delete(name);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev] proxy ${req.method} ${target.href} failed: ${message}`);
    return Response.json(
      {
        error: { code: "bad_gateway", message: `Dashboard dev proxy could not reach the API at ${API_URL}` },
      },
      { status: 502 },
    );
  }
}

const server = Bun.serve({
  port: PORT,
  development: true,
  routes: {
    "/api/*": proxy,
    "/health": proxy,
    "/*": index,
  },
});

console.log(`[dev] dashboard on ${server.url} (API proxied to ${API_URL})`);
