import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <div className="min-w-0">
        <div className="font-medium text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
          checked ? "bg-accent" : "bg-slate-300",
        )}
        onClick={() => onChange(!checked)}
      >
        <span
          className={cn(
            "absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[22px]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
