import { type AlertRuleDto, type Comparator, formatDuration, METRICS } from "@system-monitor/shared";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Badge, Empty, ErrorBox, Loading, PageHeader, RefreshStatus, StaleWarning } from "../components/ui";
import { type ApiError, api, type RulePatch, toApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useRefresh } from "../lib/refresh";
import { useResource } from "../lib/resource";

const COMPARATOR_SYMBOL: Record<Comparator, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
const MAX_SECONDS = 7 * 24 * 3600;

type NumberField =
  | "warningThreshold"
  | "criticalThreshold"
  | "warningForSeconds"
  | "criticalForSeconds"
  | "cooldownSeconds"
  | "reminderIntervalSeconds";
type BoolField = "enabled" | "notifyWarning" | "notifyOnRecovery";
type Field = NumberField | BoolField;

interface NumberSpec {
  label: string;
  nullable: boolean;
  integer: boolean;
  min?: number;
  max?: number;
  isDuration: boolean;
  /** Text shown when the value is null. */
  nullLabel?: string;
}

const NUMBER_FIELDS: Record<NumberField, NumberSpec> = {
  warningThreshold: {
    label: "Warning threshold",
    nullable: true,
    integer: false,
    isDuration: false,
    nullLabel: "off",
  },
  criticalThreshold: {
    label: "Critical threshold",
    nullable: true,
    integer: false,
    isDuration: false,
    nullLabel: "off",
  },
  warningForSeconds: {
    label: "Warning after",
    nullable: false,
    integer: true,
    min: 0,
    max: MAX_SECONDS,
    isDuration: true,
  },
  criticalForSeconds: {
    label: "Critical after",
    nullable: false,
    integer: true,
    min: 0,
    max: MAX_SECONDS,
    isDuration: true,
  },
  cooldownSeconds: {
    label: "Cooldown",
    nullable: false,
    integer: true,
    min: 0,
    max: MAX_SECONDS,
    isDuration: true,
  },
  reminderIntervalSeconds: {
    label: "Reminder interval",
    nullable: true,
    integer: true,
    min: 60,
    max: MAX_SECONDS,
    isDuration: true,
    nullLabel: "no reminders",
  },
};
const NUMBER_KEYS = Object.keys(NUMBER_FIELDS).filter((k): k is NumberField => k in NUMBER_FIELDS);
const BOOL_FIELDS: Record<BoolField, string> = {
  enabled: "Enabled",
  notifyWarning: "Notify on warning",
  notifyOnRecovery: "Notify on recovery",
};
const BOOL_KEYS = Object.keys(BOOL_FIELDS).filter((k): k is BoolField => k in BOOL_FIELDS);

function thresholdUnit(rule: AlertRuleDto): string {
  if (rule.kind === "check_failures") return "failed checks";
  if (rule.kind === "heartbeat") return "seconds";
  if (!rule.metric) return "";
  switch (METRICS[rule.metric].unit) {
    case "percent":
      return "%";
    case "milliseconds":
      return "ms";
    case "seconds":
      return "seconds";
    case "bytes":
      return "bytes";
    default:
      return "";
  }
}

function describeCondition(rule: AlertRuleDto): string {
  const scope = rule.resource ? ` on ${rule.resource}` : "";
  if (rule.kind === "heartbeat") return "Time since the host's last heartbeat exceeds the threshold";
  const label = rule.metric ? METRICS[rule.metric].label : "metric";
  if (rule.kind === "check_failures") {
    return `${label}${scope}: critical after N consecutive failed checks, warning after N failures within the last ${rule.windowSamples} checks`;
  }
  return `${label}${scope} ${COMPARATOR_SYMBOL[rule.comparator]} threshold for the configured duration`;
}

type Overrides = Partial<Record<NumberField, string>> & Partial<Record<BoolField, boolean>>;

function numberToInput(v: number | null): string {
  return v === null ? "" : String(v);
}

/** Validate the edited inputs and build the PATCH body with only the changed fields. */
function buildPatch(
  rule: AlertRuleDto,
  overrides: Overrides,
): { patch: RulePatch; errors: Partial<Record<Field, string>> } {
  const patch: RulePatch = {};
  const errors: Partial<Record<Field, string>> = {};
  for (const key of NUMBER_KEYS) {
    const raw = overrides[key];
    if (raw === undefined) continue;
    const spec = NUMBER_FIELDS[key];
    const text = raw.trim();
    let value: number | null;
    if (text === "") {
      if (!spec.nullable) {
        errors[key] = "required";
        continue;
      }
      value = null;
    } else {
      value = Number(text);
      if (!Number.isFinite(value)) {
        errors[key] = "must be a number";
        continue;
      }
      if (spec.integer && !Number.isInteger(value)) {
        errors[key] = "must be a whole number";
        continue;
      }
      if (spec.min !== undefined && value < spec.min) {
        errors[key] = `must be at least ${spec.min}`;
        continue;
      }
      if (spec.max !== undefined && value > spec.max) {
        errors[key] = `must be at most ${spec.max} (7 days)`;
        continue;
      }
    }
    if (value === rule[key]) continue;
    switch (key) {
      case "warningThreshold":
      case "criticalThreshold":
      case "reminderIntervalSeconds":
        patch[key] = value;
        break;
      default:
        if (value !== null) patch[key] = value;
    }
  }
  for (const key of BOOL_KEYS) {
    const value = overrides[key];
    if (value !== undefined && value !== rule[key]) patch[key] = value;
  }
  const warning = patch.warningThreshold !== undefined ? patch.warningThreshold : rule.warningThreshold;
  const critical = patch.criticalThreshold !== undefined ? patch.criticalThreshold : rule.criticalThreshold;
  if (warning === null && critical === null && !errors.criticalThreshold && !errors.warningThreshold) {
    errors.criticalThreshold = "at least one threshold is required";
  }
  return { patch, errors };
}

function ReadOnlyValue({ rule, field }: { rule: AlertRuleDto; field: NumberField }) {
  const spec = NUMBER_FIELDS[field];
  const value = rule[field];
  if (value === null) return <span className="muted">{spec.nullLabel ?? "—"}</span>;
  if (spec.isDuration) return <span>{formatDuration(value)}</span>;
  const unit = thresholdUnit(rule);
  return (
    <span>
      {value}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}

function RuleCard({
  rule,
  editable,
  onSaved,
}: {
  rule: AlertRuleDto;
  editable: boolean;
  onSaved: (r: AlertRuleDto) => void;
}) {
  const [overrides, setOverrides] = useState<Overrides>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const idBase = useId();

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const { patch, errors: localErrors } = buildPatch(rule, overrides);
  const dirty = Object.keys(patch).length > 0 || Object.keys(localErrors).some((k) => k in overrides);
  const serverErrors: Partial<Record<string, string>> = {};
  for (const d of error?.details ?? []) serverErrors[d.path] = d.message;
  const fieldError = (f: Field) => localErrors[f] ?? serverErrors[f];

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.keys(localErrors).length > 0 || Object.keys(patch).length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateRule(rule.id, patch);
      setOverrides({});
      setSaved(true);
      onSaved(updated);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setOverrides({});
    setError(null);
  };

  const unit = thresholdUnit(rule);
  const headingId = `${idBase}-title`;

  return (
    <form
      className={`card rule-card${rule.enabled ? "" : " rule-disabled"}`}
      onSubmit={save}
      aria-labelledby={headingId}
    >
      <div className="card-header">
        <h2 id={headingId}>{rule.name}</h2>
        <div className="card-actions">
          {rule.enabled ? (
            <Badge tone="good" icon="✓">
              Enabled
            </Badge>
          ) : (
            <Badge tone="neutral" icon="–">
              Disabled
            </Badge>
          )}
          <span className="kind-chip">{rule.kind.replace("_", " ")}</span>
        </div>
      </div>
      <div className="card-body">
        {rule.description ? <p className="muted">{rule.description}</p> : null}
        <p className="small">
          {describeCondition(rule)}
          {rule.metric ? (
            <>
              {" "}
              · <code>{rule.metric}</code>
            </>
          ) : null}
          {rule.hostId ? " · single host" : " · all hosts"}
        </p>

        <div className="rule-grid">
          {NUMBER_KEYS.map((key) => {
            const spec = NUMBER_FIELDS[key];
            const inputId = `${idBase}-${key}`;
            const current = overrides[key] ?? numberToInput(rule[key]);
            const parsed = current.trim() === "" ? null : Number(current);
            const err = fieldError(key);
            const hint = spec.isDuration
              ? parsed !== null && Number.isFinite(parsed) && parsed >= 0
                ? `= ${formatDuration(parsed)}`
                : spec.nullLabel
                  ? `empty = ${spec.nullLabel}`
                  : ""
              : spec.nullable
                ? `empty = ${spec.nullLabel ?? "none"}`
                : "";
            return (
              <div key={key} className={`field${err ? " field-invalid" : ""}`}>
                {editable ? (
                  <>
                    <label htmlFor={inputId}>
                      {spec.label}{" "}
                      <span className="muted small">({spec.isDuration ? "seconds" : unit || "value"})</span>
                    </label>
                    <input
                      id={inputId}
                      type="number"
                      inputMode="decimal"
                      step={spec.integer ? 1 : "any"}
                      min={spec.min}
                      max={spec.max}
                      value={current}
                      placeholder={spec.nullable ? (spec.nullLabel ?? "") : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setOverrides((o) => ({ ...o, [key]: v }));
                        setSaved(false);
                        setError(null);
                      }}
                      aria-invalid={err ? true : undefined}
                      aria-describedby={`${inputId}-hint`}
                      disabled={busy}
                    />
                    <div id={`${inputId}-hint`} className="field-help">
                      {hint}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="field-label">{spec.label}</div>
                    <div>
                      <ReadOnlyValue rule={rule} field={key} />
                    </div>
                  </>
                )}
                {err ? (
                  <div className="field-error" role="alert">
                    {err}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="rule-toggles">
          {BOOL_KEYS.map((key) => {
            const value = overrides[key] ?? rule[key];
            const err = fieldError(key);
            return editable ? (
              <label key={key} className="toggle">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setOverrides((o) => ({ ...o, [key]: checked }));
                    setSaved(false);
                    setError(null);
                  }}
                  disabled={busy}
                />
                {BOOL_FIELDS[key]}
                {err ? <span className="field-error"> {err}</span> : null}
              </label>
            ) : (
              <span key={key} className="toggle-readonly">
                <span aria-hidden="true">{value ? "✓" : "✕"} </span>
                {BOOL_FIELDS[key]}: {value ? "yes" : "no"}
              </span>
            );
          })}
        </div>

        {editable ? (
          <>
            {error ? <ErrorBox error={error} title="Could not save rule" compact /> : null}
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || Object.keys(patch).length === 0 || Object.keys(localErrors).length > 0}
              >
                {busy ? "Saving…" : "Save changes"}
              </button>
              <button type="button" className="btn" onClick={reset} disabled={busy || !dirty}>
                Reset
              </button>
              {saved ? (
                <span className="saved-note" role="status">
                  <span aria-hidden="true">✓ </span>Saved
                </span>
              ) : dirty ? (
                <span className="muted small">Unsaved changes</span>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </form>
  );
}

export function RulesPage() {
  const { can } = useAuth();
  const { refreshNow } = useRefresh();
  const rules = useResource("rules", (s) => api.rules(s));
  const [savedRules, setSavedRules] = useState<Record<string, AlertRuleDto>>({});
  const editable = can("admin");

  // A newer server copy (from auto-refresh) replaces the locally saved one.
  const merged = (rules.data ?? []).map((r) => {
    const local = savedRules[r.id];
    return local && local.updatedAt > r.updatedAt ? local : r;
  });

  return (
    <>
      <PageHeader
        title="Alert rules"
        subtitle={
          editable
            ? "Edit thresholds, durations and notification settings inline; each rule saves independently."
            : "Read-only: only administrators can change alert rules."
        }
        actions={<RefreshStatus updatedAt={rules.updatedAt} loading={rules.loading} onRefresh={refreshNow} />}
      />
      {rules.data ? (
        <>
          {rules.error ? <StaleWarning error={rules.error} onRetry={rules.reload} /> : null}
          {merged.length === 0 ? (
            <Empty>No alert rules are configured.</Empty>
          ) : (
            <div className="rule-list">
              {merged.map((r) => (
                <RuleCard
                  key={r.id}
                  rule={r}
                  editable={editable}
                  onSaved={(updated) => setSavedRules((s) => ({ ...s, [updated.id]: updated }))}
                />
              ))}
            </div>
          )}
        </>
      ) : rules.error ? (
        <ErrorBox error={rules.error} title="Could not load alert rules" onRetry={rules.reload} />
      ) : (
        <Loading label="Loading rules…" />
      )}
    </>
  );
}
