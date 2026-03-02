import { CircleUserRound } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/", label: "Submit New Request" },
  { to: "/requests", label: "My Requests" },
  { to: "/agent", label: "Agent Queue" }
];

export function TopNav() {
  const location = useLocation();

  return (
    <header className="sticky top-0 z-30 border-b border-slate-100 bg-white/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 md:px-8">
        <Link to="/" className="text-lg font-semibold text-ink">
          NexusFlow
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`text-sm ${location.pathname === link.to ? "text-brand-500" : "text-slate-600 hover:text-ink"}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <button className="rounded-mdplus border border-slate-200 p-2 text-slate-600 hover:bg-slate-50">
          <CircleUserRound size={18} />
        </button>
      </div>
    </header>
  );
}
