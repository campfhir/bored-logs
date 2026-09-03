"use client";

import { useEffect, useRef, useState } from "react";
import { loadout as fetchLoadout } from "../actions";
import type { Loadout } from "@/lib/loadout";

// A nav-level dropdown showing what this demo is built from: the
// @campfhir/bored-logs-* packages in use, the Postgres layout the adapter and
// migrator share (schema · prefix · physical table names), and which
// migrations are applied. Loaded on first open via the `loadout` server action.
export default function LoadoutPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Loadout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || data) return;
    fetchLoadout()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, data]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Packages, database layout, and migration status"
        className={
          open
            ? "rounded-md bg-sky-500/15 px-2.5 py-1 text-sm font-medium text-sky-700 dark:text-sky-300"
            : "rounded-md px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        }
      >
        Loadout
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(44rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900">
          {error && <p className="text-red-600 dark:text-red-400">Could not load: {error}</p>}
          {!data && !error && <p className="text-slate-500">Loading…</p>}
          {data && (
            <div className="flex flex-col gap-4">
              <section>
                <Heading>Packages in this demo</Heading>
                <table className="mt-2 w-full text-left text-xs">
                  <tbody>
                    {data.packages.map((p) => (
                      <tr key={p.name} className="border-t border-slate-100 align-top dark:border-slate-800">
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          <code className="text-sky-700 dark:text-sky-300">{p.name}</code>
                          <span className="ml-1.5 text-slate-400">{p.version}</span>
                        </td>
                        <td className="py-1.5 text-slate-600 dark:text-slate-300">
                          {p.role}
                          <div className="text-[11px] text-slate-400">{p.usedIn}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Heading>Database layout</Heading>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-slate-500">database</dt>
                    <dd><code>{data.database}</code></dd>
                    <dt className="text-slate-500">schema</dt>
                    <dd><code>{data.layout.schema ?? "(search_path)"}</code></dd>
                    <dt className="text-slate-500">tablePrefix</dt>
                    <dd><code>{data.layout.prefix === "" ? '""' : data.layout.prefix}</code></dd>
                  </dl>
                  <ul className="mt-2 text-xs">
                    {Object.entries(data.layout.tables).map(([logical, physical]) => (
                      <li key={logical} className="flex gap-2 py-0.5">
                        <code className="text-slate-400">{logical}</code>
                        <span className="text-slate-400">→</span>
                        <code>{data.layout.schema ? `${data.layout.schema}.` : ""}{physical}</code>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <Heading>Migrations</Heading>
                  <ul className="mt-2 text-xs">
                    {data.migrations.map((m) => (
                      <li key={m.name} className="flex items-center gap-2 py-0.5">
                        <span
                          className={
                            m.applied
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-amber-600 dark:text-amber-400"
                          }
                        >
                          {m.applied ? "✓" : "•"}
                        </span>
                        <code>{m.name}</code>
                        <span className="text-slate-400">{m.applied ? "applied" : "pending"}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-slate-400">
                    Same <code>schema</code> / <code>tablePrefix</code> options passed to{" "}
                    <code>up()</code> and to <code>PostgresAdapter</code>. Override with{" "}
                    <code>LOG_SCHEMA</code> / <code>LOG_TABLE_PREFIX</code>.
                  </p>
                </div>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{children}</h3>;
}
