const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const shortTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

/** "12 sec. ago", "5 min. ago", "in 3 min." – coarse, for freshness indicators. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  // Fresh server timestamps can be slightly "in the future" due to clock skew.
  if (abs < 5 || (diffSec > 0 && diffSec < 120)) return "just now";
  if (abs < 60) return relative.format(diffSec, "second");
  if (abs < 3600) return relative.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(diffSec / 3600), "hour");
  return relative.format(Math.round(diffSec / 86_400), "day");
}

/** Axis tick label appropriate for the visible span. */
export function formatAxisTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 36 * 3600_000) return shortTime.format(d);
  if (spanMs <= 8 * 86_400_000) return dayTime.format(d);
  return dayMonth.format(d);
}

export function formatTooltipTime(ms: number): string {
  return dateTime.format(new Date(ms));
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function secondsBetween(fromIso: string, toIso: string | null, now: number = Date.now()): number {
  const end = toIso ? new Date(toIso).getTime() : now;
  return Math.max(0, (end - new Date(fromIso).getTime()) / 1000);
}
