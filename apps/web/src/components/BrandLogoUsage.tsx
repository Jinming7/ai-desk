import { Link } from "react-router-dom";

interface BrandLogoUsageProps {
  title: string;
}

export function BrandLogoUsage({ title }: BrandLogoUsageProps) {
  return (
    <Link to="/" className="inline-flex items-center gap-3 text-[#16171A]" aria-label="ONES and NexusFlow brand">
      <img src="/ones-logo.svg" alt="ONES" className="h-6 w-auto" />
      <span className="text-[#D1D5DB]" aria-hidden>
        |
      </span>
      <span className="text-base font-semibold tracking-tight">{title}</span>
    </Link>
  );
}
