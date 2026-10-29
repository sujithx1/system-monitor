import { statfs } from "node:fs/promises";
import { type MetricSample, sample, unavailable } from "@system-monitor/shared";
import { round } from "./cpu";

export interface StatfsLike {
  bsize: bigint;
  blocks: bigint;
  bfree: bigint;
  bavail: bigint;
  files: bigint;
  ffree: bigint;
}

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  /** Space available to unprivileged users (what applications can actually write). */
  availableBytes: number;
  /** Free space including blocks reserved for root. */
  freeBytes: number;
  /** Same formula as `df`: used / (used + available). */
  usagePercent: number;
  inodesTotal: number | null;
  inodesUsed: number | null;
  inodeUsagePercent: number | null;
}

export function computeDiskUsage(s: StatfsLike): DiskUsage {
  if (s.blocks <= 0n || s.bsize <= 0n) throw new Error("filesystem reports zero capacity");
  const total = s.blocks * s.bsize;
  const free = s.bfree * s.bsize;
  const avail = s.bavail * s.bsize;
  const used = total - free;
  const denominator = used + avail;
  const usagePercent = denominator > 0n ? (Number(used) / Number(denominator)) * 100 : 0;
  // Some filesystems (btrfs, zfs, …) allocate inodes dynamically and report 0 – not applicable.
  const inodesValid = s.files > 0n && s.ffree >= 0n && s.ffree <= s.files;
  const inodesUsed = inodesValid ? s.files - s.ffree : null;
  return {
    totalBytes: Number(total),
    usedBytes: Number(used),
    availableBytes: Number(avail),
    freeBytes: Number(free),
    usagePercent: Math.min(100, Math.max(0, usagePercent)),
    inodesTotal: inodesValid ? Number(s.files) : null,
    inodesUsed: inodesUsed === null ? null : Number(inodesUsed),
    inodeUsagePercent: inodesUsed === null ? null : (Number(inodesUsed) / Number(s.files)) * 100,
  };
}

const PSEUDO_FS = new Set([
  "proc",
  "sysfs",
  "devtmpfs",
  "devpts",
  "tmpfs",
  "securityfs",
  "cgroup",
  "cgroup2",
  "pstore",
  "bpf",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "mqueue",
  "hugetlbfs",
  "autofs",
  "binfmt_misc",
  "overlay",
  "squashfs",
  "nsfs",
  "ramfs",
  "rpc_pipefs",
  "efivarfs",
  "fuse.lxcfs",
  "fuse.portal",
  "selinuxfs",
]);

/**
 * Real filesystems from /proc/mounts, used when AGENT_MOUNTS=auto. Bind mounts of the same device
 * are collapsed to the shortest mount path, so each filesystem is reported once.
 */
export function parseProcMounts(content: string): string[] {
  const byDevice = new Map<string, string>();
  for (const line of content.split("\n")) {
    const [device, rawMount, fsType] = line.split(" ");
    if (!device || !rawMount || !fsType) continue;
    if (PSEUDO_FS.has(fsType)) continue;
    if (!device.startsWith("/") && fsType !== "zfs") continue;
    const mount = rawMount.replace(/\\(\d{3})/g, (_, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    if (mount.startsWith("/snap/") || mount.startsWith("/var/lib/docker/")) continue;
    const existing = byDevice.get(device);
    if (!existing || mount.length < existing.length) byDevice.set(device, mount);
  }
  return [...new Set(byDevice.values())].sort();
}

export async function collectDisks(
  mounts: string[],
  stat: (path: string) => Promise<StatfsLike> = (p) => statfs(p, { bigint: true }),
): Promise<MetricSample[]> {
  const out: MetricSample[] = [];
  for (const mount of mounts) {
    try {
      const d = computeDiskUsage(await stat(mount));
      out.push(
        sample("disk.usage_percent", round(d.usagePercent), mount),
        sample("disk.total_bytes", d.totalBytes, mount),
        sample("disk.used_bytes", d.usedBytes, mount),
        sample("disk.available_bytes", d.availableBytes, mount),
        sample("disk.free_bytes", d.freeBytes, mount),
      );
      if (d.inodeUsagePercent !== null && d.inodesTotal !== null && d.inodesUsed !== null) {
        out.push(
          sample("disk.inode_usage_percent", round(d.inodeUsagePercent), mount),
          sample("disk.inodes_total", d.inodesTotal, mount),
          sample("disk.inodes_used", d.inodesUsed, mount),
        );
      } else {
        out.push(
          unavailable("disk.inode_usage_percent", "filesystem does not report fixed inode counts", mount),
        );
      }
    } catch (error) {
      out.push(
        unavailable("disk.usage_percent", error, mount),
        unavailable("disk.inode_usage_percent", error, mount),
      );
    }
  }
  return out;
}
