import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  success: "bg-emerald-50 text-ok ring-emerald-200",
  partial: "bg-amber-50 text-warn ring-amber-200",
  error: "bg-red-50 text-danger ring-red-200",
  failed: "bg-red-50 text-danger ring-red-200",
  received: "bg-slate-100 text-slate-700 ring-slate-200",
  approved: "bg-sky-50 text-sky-800 ring-sky-200",
  submitting: "bg-amber-50 text-warn ring-amber-200",
  submitted: "bg-teal-50 text-accent ring-teal-200",
  confirmed: "bg-teal-50 text-accent ring-teal-200",
  dispatched: "bg-emerald-50 text-ok ring-emerald-200",
  delivered: "bg-emerald-50 text-ok ring-emerald-200",
  needs_attention: "bg-red-50 text-danger ring-red-200",
  cancelled: "bg-slate-100 text-slate-500 ring-slate-200",
  running: "bg-amber-50 text-warn ring-amber-200",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset font-mono",
        tones[status] ?? "bg-slate-100 text-slate-700 ring-slate-200",
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
