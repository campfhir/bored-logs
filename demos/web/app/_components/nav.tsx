"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "../theme-toggle";

// The layout variants. Each is a full-page idea for arranging the same
// bored-logs components (search, level filter, date range, table/cards).
const VARIANTS = [
  { href: "/", label: "Toolbar", hint: "Filters stacked above the results" },
  { href: "/split", label: "Sidebar", hint: "Filters in a left rail" },
  { href: "/compact", label: "Compact", hint: "Everything in one dense bar" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2 dark:border-slate-800 sm:px-6">
      <span className="text-sm font-semibold tracking-tight">
        bored-logs <span className="text-slate-400 dark:text-slate-500">demo</span>
      </span>
      <div className="flex flex-wrap gap-1">
        {VARIANTS.map((v) => {
          const active = pathname === v.href;
          return (
            <Link
              key={v.href}
              href={v.href}
              title={v.hint}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-md bg-sky-500/15 px-2.5 py-1 text-sm font-medium text-sky-700 dark:text-sky-300"
                  : "rounded-md px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }
            >
              {v.label}
            </Link>
          );
        })}
      </div>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </nav>
  );
}
