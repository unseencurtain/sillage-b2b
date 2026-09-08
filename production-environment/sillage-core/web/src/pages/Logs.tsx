import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pagination } from "@/components/Pagination";
import { api } from "@/lib/api";
import { useFmtDate } from "@/lib/utils";

export function Logs() {
  const fmtDate = useFmtDate();
  const [level, setLevel] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["logs", level, page],
    queryFn: () => api.logs(page, level || undefined),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted">
            Recent sil_events
            {data ? ` · ${data.total.toLocaleString()} total` : ""}
          </p>
        </div>
        <select
          className="rounded-lg border border-line bg-panel px-3 py-2 text-sm"
          value={level}
          onChange={(e) => {
            setPage(1);
            setLevel(e.target.value);
          }}
        >
          <option value="">All levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </select>
      </header>

      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Level</th>
              <th className="px-4 py-3">Scope</th>
              <th className="px-4 py-3">Message</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-muted">
                  Loading…
                </td>
              </tr>
            ) : (data?.events ?? []).length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-muted">
                  No events
                </td>
              </tr>
            ) : (
              (data?.events ?? []).map((e) => (
                <tr key={e.id} className="border-b border-line/70 last:border-0 align-top">
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-muted">
                    {fmtDate(e.created_at)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{e.level}</td>
                  <td className="px-4 py-3 font-mono text-xs">{e.scope}</td>
                  <td className="px-4 py-3">{e.message}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {data ? (
        <Pagination page={page} limit={data.limit} total={data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
