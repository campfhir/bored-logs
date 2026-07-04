import { defineConfig } from "tsup";

// Packages that must not be bundled — either peer deps (supplied by the
// consumer) or packages that Node.js can require from node_modules.
const EXTERNAL = [
  "react",
  "react-dom",
  "next",
  "kysely",
  "pg",
];

export default defineConfig([
  // ── Server-only entries ────────────────────────────────────────────────────
  // No "use client" — these are imported on the server (instrumentation.ts,
  // server actions, migrations).
  {
    entry: {
      index: "src/index.ts",
      "server/index": "src/server/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    external: EXTERNAL,
  },

  // ── Adapter entries ────────────────────────────────────────────────────────
  // Each adapter and its migration are Node.js-only — use dynamic import in
  // instrumentation.ts so pg/kysely are never loaded in browser/Edge runtimes.
  {
    entry: {
      "adapters/psql": "src/adapters/psql/adapter.ts",
      "adapters/psql/migration": "src/adapters/psql/migration/index.ts",
      // Universal (browser + Node/Edge) — ships log batches over HTTP. No banner:
      // it uses only fetch/navigator/timers and imports no React.
      "adapters/http": "src/adapters/http/adapter.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    external: EXTERNAL,
  },

  // ── Client component entries ───────────────────────────────────────────────
  // The "use client" banner tells Next.js (and any bundler that understands
  // the React Server Components convention) that this module and its imports
  // run exclusively in the browser.
  {
    entry: {
      "components/index": "src/components/index.ts",
      "client/index": "src/client/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    banner: { js: '"use client";' },
    external: EXTERNAL,
  },
]);
