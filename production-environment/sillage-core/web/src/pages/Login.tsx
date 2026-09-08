import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";

export function Login() {
  const navigate = useNavigate();
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8 shadow-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api.login(user, password);
            navigate("/");
          } catch {
            setError("Invalid credentials");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="text-2xl font-semibold tracking-tight">Sillage</div>
        <p className="mt-1 text-sm text-muted">Sign in to the operations dashboard</p>
        <label className="mt-6 block text-sm">
          <span className="text-muted">User</span>
          <input
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="mt-3 block text-sm">
          <span className="text-muted">Password</span>
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-line px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-accent-ink disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
