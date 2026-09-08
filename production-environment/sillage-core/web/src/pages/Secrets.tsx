import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { api, type SecretStatus } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

const HELP: Record<string, string> = {
  BEAUTYFORT_USER: "BeautyFort SOAP username for catalogue + order APIs.",
  BEAUTYFORT_SECRET: "BeautyFort SOAP password/secret. Never shown after save.",
  BTS_JWT_TOKEN: "BTS Wholesaler JWT from their portal. Powers catalogue + dispatch.",
  WHOLESALE_PERFUMES_USER: "wholesale-perfumes.eu (SoleLuna) API username.",
  WHOLESALE_PERFUMES_TOKEN: "wholesale-perfumes.eu API token. Never shown after save.",
};

function sourceLabel(source: SecretStatus["source"]) {
  if (source === "overlay") return "dashboard overlay";
  if (source === "env") return "compose .env";
  return "not set";
}

export function Secrets() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { data, isLoading, error } = useQuery({
    queryKey: ["secrets"],
    queryFn: api.secrets,
  });

  const setMut = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.setSecret(key, value),
    onSuccess: (_res, vars) => {
      setDrafts((d) => ({ ...d, [vars.key]: "" }));
      qc.invalidateQueries({ queryKey: ["secrets"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast(`${vars.key} saved — applied immediately (no restart)`, "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  const clearMut = useMutation({
    mutationFn: (key: string) => api.clearSecret(key),
    onSuccess: (_res, key) => {
      qc.invalidateQueries({ queryKey: ["secrets"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      toast(`${key} cleared from overlay + runtime`, "ok");
    },
    onError: (err: Error) => toast(err.message, "error"),
  });

  if (isLoading) return <p className="text-muted">Loading secrets…</p>;
  if (error || !data) return <p className="text-danger">Failed to load secrets</p>;

  const busy = setMut.isPending || clearMut.isPending;
  const missing = data.secrets.filter((s) => !s.set);
  const allSet = missing.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
        <p className="text-sm text-muted">
          Vendor API credentials for this storefront. Values are never shown after save — only set /
          empty. Hot-reloaded; no container recreate.
        </p>
      </header>

      {!allSet ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-950">
          <div className="font-semibold">First login — fill these before syncing</div>
          <p className="mt-1">
            Still empty: {missing.map((s) => s.label).join(", ")}. Paste each value and press Set,
            then go to{" "}
            <Link to="/sync" className="font-medium underline underline-offset-2">
              Sync → Run sync now
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-ok">
          All required secrets are set. Next:{" "}
          <Link to="/sync" className="font-medium underline underline-offset-2">
            Run sync now
          </Link>
          .
        </div>
      )}

      <div className="rounded-xl border border-line bg-panel px-4 py-3 text-sm text-muted">
        <div className="flex items-start gap-2">
          <KeyRound size={16} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <p>
              Stored in a gitignored overlay (
              <span className="font-mono text-xs text-ink">{data.path}</span>
              ). Overlay wins over compose <span className="font-mono text-xs">.env</span> and is
              applied on save and at the start of each sync.
            </p>
            {data.note ? <p className="mt-1">{data.note}</p> : null}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {data.secrets.map((s) => {
          const draft = drafts[s.key] ?? "";
          const saving = setMut.isPending && setMut.variables?.key === s.key;
          const clearing = clearMut.isPending && clearMut.variables === s.key;
          return (
            <section key={s.key} className="rounded-xl border border-line bg-panel p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">{s.label}</h2>
                  <div className="mt-0.5 font-mono text-xs text-muted">{s.key}</div>
                  <p className="mt-1 text-xs text-muted">{HELP[s.key] ?? "Vendor API credential."}</p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "rounded-md border px-2 py-0.5 font-mono",
                      s.set
                        ? "border-emerald-200 bg-emerald-50 text-ok"
                        : "border-amber-200 bg-amber-50 text-amber-800",
                    )}
                  >
                    {s.set ? s.masked || "••••••••" : "empty — required"}
                  </span>
                  <span className="text-muted">{sourceLabel(s.source)}</span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="min-w-[16rem] flex-1">
                  <span className="mb-1 block text-xs text-muted">New value</span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-sm"
                    placeholder={s.set ? "•••••••• (replace)" : "paste secret"}
                    value={draft}
                    disabled={busy}
                    onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  />
                </label>
                <button
                  type="button"
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink disabled:opacity-50"
                  disabled={busy || !draft.trim()}
                  onClick={() => setMut.mutate({ key: s.key, value: draft })}
                >
                  {saving ? "Saving…" : "Set"}
                </button>
                <button
                  type="button"
                  title={s.set ? `Clear ${s.key} from overlay + runtime` : "Nothing to clear"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 bg-red-50 px-3 py-2 text-sm font-medium text-danger hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy || !s.set}
                  onClick={() => {
                    if (window.confirm(`Clear ${s.key}? Runtime will lose this credential until set again.`)) {
                      clearMut.mutate(s.key);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  {clearing ? "Clearing…" : "Clear"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
