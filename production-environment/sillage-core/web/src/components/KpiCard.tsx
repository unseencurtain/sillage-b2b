export function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-panel p-4 shadow-sm">
      {accent ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-accent/80 to-teal-400/60" />
      ) : null}
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {hint ? (
        <div className={`mt-1.5 text-sm ${hint.includes("LIVE") && !hint.includes("dry-run") ? "font-medium text-warn" : "text-muted"}`}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
