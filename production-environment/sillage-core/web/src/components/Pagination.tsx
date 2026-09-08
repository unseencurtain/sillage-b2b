export function Pagination({
  page,
  limit,
  total,
  onPageChange,
}: {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const showing = total === 0 ? 0 : Math.min(page * limit, total);
  const from = total === 0 ? 0 : (page - 1) * limit + 1;

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button
        type="button"
        className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </button>
      <span className="font-mono text-muted">
        page {page}
        {total > 0 ? ` · ${from}–${showing} of ${total.toLocaleString()}` : ""}
      </span>
      <button
        type="button"
        className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
        disabled={page * limit >= total}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
