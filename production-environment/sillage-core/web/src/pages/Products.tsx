import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pagination } from "@/components/Pagination";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { cn, eur } from "@/lib/utils";

export function Products() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ["products", q, page],
    queryFn: () => api.products(q, page),
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted">
            {data ? `${data.total.toLocaleString()} products` : "Catalogue search"}
            . Stock is the winning offer. Shop is a dropdown:{" "}
            <strong className="font-medium text-ink">Follow rules</strong> uses hide-without-image
            and stock; <strong className="font-medium text-ink">Keep hidden</strong> stays off the
            catalogue on the next rewrite. Photo opens the image the shop would print.
          </p>
        </div>
        <input
          className="w-full max-w-sm rounded-lg border border-line bg-panel px-3 py-2 text-sm"
          placeholder="Search SKU, name, EAN…"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
      </header>

      <div className="overflow-x-auto overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas/70 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Photo</th>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Shop</th>
              <th className="px-4 py-3">Cost</th>
              <th className="px-4 py-3">WP</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-muted">
                  Loading…
                </td>
              </tr>
            ) : (data?.items ?? []).length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-muted">
                  No products match that search.
                </td>
              </tr>
            ) : (
              (data?.items ?? []).map((p) => (
                <tr key={p.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-3">
                    <PhotoLink url={p.photo_url} shopUrl={p.shop_url} name={p.name} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{p.sku}</td>
                  <td className="px-4 py-3 max-w-md truncate">{p.name}</td>
                  <td className="px-4 py-3">{p.vendor}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{p.stock}</td>
                  <td className="px-4 py-3">
                    <ShopControl
                      id={p.id}
                      sku={p.sku}
                      operatorHidden={p.operator_hidden === true}
                      visibility={p.shop_visibility}
                    />
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">{eur(p.vendor_price)}</td>
                  <td className="px-4 py-3 font-mono text-muted">{p.wp_post_id}</td>
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

function PhotoLink({
  url,
  shopUrl,
  name,
}: {
  url?: string | null;
  shopUrl?: string | null;
  name: string;
}) {
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 text-xs font-medium text-ink underline-offset-2 hover:underline"
        title="Open photo"
      >
        <img src={url} alt="" className="h-10 w-10 rounded-md border border-line object-cover bg-canvas" />
        <span>Open photo</span>
      </a>
    );
  }
  if (shopUrl) {
    return (
      <a
        href={shopUrl}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-muted underline-offset-2 hover:underline"
        title={name}
      >
        Product page
      </a>
    );
  }
  return <span className="text-xs text-muted">No photo</span>;
}

function ShopControl({
  id,
  sku,
  operatorHidden,
  visibility,
}: {
  id: number;
  sku: string;
  operatorHidden: boolean;
  visibility?: "visible" | "hidden_no_image" | "hidden_stock" | "hidden_operator";
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: (hidden: boolean) => api.setProductVisibility(id, hidden),
    onSuccess: (_data, hidden) => {
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      toast(
        hidden
          ? `${sku} kept hidden. Next rewrite will leave it off the catalogue.`
          : `${sku} follows shop rules again.`,
        "ok",
      );
    },
    onError: (err) => {
      toast(err instanceof Error ? err.message : "Could not update visibility", "error");
    },
  });

  return (
    <div className="flex min-w-[11rem] flex-col gap-1">
      <select
        className="rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs"
        disabled={mutation.isPending}
        value={operatorHidden ? "hidden" : "rules"}
        onChange={(e) => mutation.mutate(e.target.value === "hidden")}
      >
        <option value="rules">Follow rules</option>
        <option value="hidden">Keep hidden</option>
      </select>
      <ShopBadge visibility={visibility} />
    </div>
  );
}

function ShopBadge({
  visibility,
}: {
  visibility?: "visible" | "hidden_no_image" | "hidden_stock" | "hidden_operator";
}) {
  if (visibility === "hidden_operator") {
    return (
      <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-900">
        Hidden · pinned
      </span>
    );
  }
  if (visibility === "hidden_no_image") {
    return (
      <span className={cn("rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900")}>
        Hidden · no image
      </span>
    );
  }
  if (visibility === "hidden_stock") {
    return (
      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
        Hidden · stock
      </span>
    );
  }
  if (visibility === "visible") {
    return <span className="text-xs font-medium text-ok">Visible</span>;
  }
  return <span className="text-xs text-muted">—</span>;
}
