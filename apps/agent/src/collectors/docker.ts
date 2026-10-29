import { type MetricSample, sample, unavailable } from "@system-monitor/shared";

interface ContainerSummary {
  Names?: string[];
  State?: string;
  Status?: string;
}

/**
 * Read-only container status through the Docker Engine API (GET /containers/json only).
 * Point AGENT_DOCKER_SOCKET at a socket proxy that allows only that endpoint – the raw
 * docker.sock is root-equivalent and must not be given to the agent.
 */
export async function collectDocker(socketPath: string, timeoutMs: number): Promise<MetricSample[]> {
  try {
    const res = await fetch("http://docker/v1.43/containers/json?all=true", {
      unix: socketPath,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`docker API returned HTTP ${res.status}`);
    return parseContainers((await res.json()) as ContainerSummary[]);
  } catch (error) {
    return [unavailable("container.running", error, "docker")];
  }
}

export function parseContainers(list: ContainerSummary[]): MetricSample[] {
  const out: MetricSample[] = [];
  for (const c of list.slice(0, 200)) {
    const name = c.Names?.[0]?.replace(/^\//, "").slice(0, 200);
    if (!name) continue;
    out.push(sample("container.running", c.State === "running" ? 1 : 0, name));
    const health = /\((healthy|unhealthy)\)/.exec(c.Status ?? "")?.[1];
    if (health) out.push(sample("container.healthy", health === "healthy" ? 1 : 0, name));
  }
  return out;
}
