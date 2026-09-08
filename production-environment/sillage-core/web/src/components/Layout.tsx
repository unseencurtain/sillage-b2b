import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  ClipboardList,
  FlaskConical,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Package,
  RefreshCw,
  Settings,
  Store,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/sync", label: "Sync", icon: RefreshCw },
  { to: "/products", label: "Products", icon: Package },
  { to: "/vendors", label: "Vendors", icon: Store },
  { to: "/orders", label: "Orders", icon: Boxes },
  { to: "/secrets", label: "Secrets", icon: KeyRound },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/logs", label: "Logs", icon: ClipboardList },
];

export function Layout() {
  const navigate = useNavigate();
  // Shares the Overview page's cache entry, so this costs no extra request on the page that
  // matters and one cheap one everywhere else.
  const { data } = useQuery({ queryKey: ["overview"], queryFn: api.overview, staleTime: 15_000 });
  const devBox = data?.devBox === true;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-sidebar text-sidebar-ink">
        <div className="border-b border-white/10 px-5 py-5">
          <div className="text-lg font-semibold tracking-tight text-white">Sillage</div>
          <div className="mt-0.5 text-xs text-white/50">wholesale · sandbox</div>
        </div>
        {devBox ? (
          // The dev shop is restored from the live one and carries the same catalogue and
          // credentials. Something has to say which is which before anyone presses a button.
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg bg-amber-400/15 px-3 py-2 text-xs text-amber-200">
            <FlaskConical size={14} className="mt-0.5 shrink-0" />
            <span>
              <strong className="font-semibold">Development box.</strong> A copy of the live shop —
              changes here reach no customer.
            </span>
          </div>
        ) : null}
        <nav className="flex-1 space-y-1 p-3">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
                  isActive ? "bg-white/10 text-white" : "text-white/65 hover:bg-white/5 hover:text-white",
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <button
          type="button"
          className="m-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/60 hover:bg-white/5 hover:text-white"
          onClick={async () => {
            await api.logout();
            navigate("/login");
          }}
        >
          <LogOut size={16} />
          Sign out
        </button>
      </aside>
      <main className="min-w-0 flex-1 p-6 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}
