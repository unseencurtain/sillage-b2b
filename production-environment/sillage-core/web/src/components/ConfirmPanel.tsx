import { AlertTriangle } from "lucide-react";

export function ConfirmPanel({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  pending,
  danger,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-4">
      <div className="flex gap-2">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{title}</div>
          <p className="mt-1 text-sm text-muted">{description}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-sm hover:bg-canvas disabled:opacity-50"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className={
                danger
                  ? "rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  : "rounded-lg bg-accent px-3 py-1.5 text-sm text-accent-ink disabled:opacity-50"
              }
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
