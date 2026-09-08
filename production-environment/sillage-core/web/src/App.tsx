import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Sync } from "@/pages/Sync";
import { Products } from "@/pages/Products";
import { Vendors } from "@/pages/Vendors";
import { Orders } from "@/pages/Orders";
import { Secrets } from "@/pages/Secrets";
import { Settings } from "@/pages/Settings";
import { Logs } from "@/pages/Logs";
import { ToastProvider } from "@/components/Toast";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function RequireAuth() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
  });
  if (isLoading) return <div className="p-8 text-muted">Checking session…</div>;
  if (isError || !data?.ok) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route
              element={
                <TimezoneProvider>
                  <Layout />
                </TimezoneProvider>
              }
            >
              <Route index element={<Overview />} />
              <Route path="sync" element={<Sync />} />
              <Route path="products" element={<Products />} />
              <Route path="vendors" element={<Vendors />} />
              <Route path="orders" element={<Orders />} />
              <Route path="secrets" element={<Secrets />} />
              <Route path="settings" element={<Settings />} />
              <Route path="logs" element={<Logs />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
