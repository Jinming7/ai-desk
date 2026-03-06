import type { ReactNode } from "react";
import { useMemo, useState } from "react";

const STORAGE_KEY = "nexusflow_support_access_ok";

export function AgentRouteGuard({ children, requestedPath }: { children: ReactNode; requestedPath: string }) {
  const passcode = import.meta.env.VITE_AGENT_ACCESS_CODE;
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hasGate = useMemo(() => typeof passcode === "string" && passcode.trim().length > 0, [passcode]);
  const isVerified = useMemo(() => window.localStorage.getItem(STORAGE_KEY) === "true", []);

  if (isVerified) {
    return <>{children}</>;
  }

  if (!hasGate) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-2xl border border-rose-200 bg-rose-50 p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-rose-900">403 Forbidden</h1>
        <p className="mt-2 text-sm text-rose-800">
          Internal portal access is not configured. Requested route: <code>{requestedPath}</code>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-20 max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-xl font-semibold text-ink">Support Portal Access</h1>
      <p className="mt-2 text-sm text-slate-600">Enter the temporary access code to open Support Portal.</p>
      <input
        className="mt-4 h-10 w-full rounded-mdplus border border-slate-200 px-3"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Access code"
      />
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
      <button
        className="mt-4 rounded-mdplus bg-brand-500 px-4 py-2 text-sm font-medium text-white"
        onClick={() => {
          if (input === passcode) {
            window.localStorage.setItem(STORAGE_KEY, "true");
            window.location.reload();
            return;
          }
          setError("Invalid code");
        }}
      >
        Enter Support Portal
      </button>
    </div>
  );
}
