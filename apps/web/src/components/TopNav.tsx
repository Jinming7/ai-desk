import { ChevronDown, CircleUserRound } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/requests", label: "My Requests" },
  { to: "/agent", label: "Agent Queue" }
];

export function TopNav() {
  const location = useLocation();

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-white">
      <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between px-4 py-4 md:px-8">
        <Link to="/" className="flex items-center gap-3 text-lg font-semibold text-ink">
          <img src="https://ones.com/favicon.ico" alt="ONES logo" className="h-6 w-6 rounded" />
          <span>NexusFlow</span>
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`text-sm font-medium ${location.pathname === link.to ? "text-brand-500" : "text-muted hover:text-ink"}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600"
          >
            Submit New Request
          </Link>
          <button className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:bg-slate-50">
            <CircleUserRound size={18} />
            <span className="hidden md:inline">Profile</span>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
