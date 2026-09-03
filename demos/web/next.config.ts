import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // `@campfhir/bored-logs*` imports resolve to ../../packages/*/src via
  // tsconfig `paths` (live local source, no tsup rebuild); transpilePackages
  // stays as the guard for anything that falls back to the `link:` dist copies.
  transpilePackages: [
    "@campfhir/bored-logs",
    "@campfhir/bored-logs-server",
    "@campfhir/bored-logs-client",
    "@campfhir/bored-logs-ui",
    "@campfhir/bored-logs-psql",
    "@campfhir/bored-logs-psql-migration",
    "@campfhir/bored-logs-http",
  ],
  // Allow compiling the library sources, which live outside the demo root.
  experimental: { externalDir: true },
  // Turbopack must treat the repository as the workspace so ../../packages compiles.
  turbopack: { root: dirname(dirname(dirname(fileURLToPath(import.meta.url)))) },
  compiler: {
    // Keep `console.*` calls in production builds via SWC, so `ConsoleAdapter` output appears in browser devtools.
    removeConsole: false,
  },
  // Keep the native-ish Postgres driver out of the bundle; require it at runtime.
  serverExternalPackages: ["pg"],
  // The app graph now includes ../../packages, so trace from the repository root.
  outputFileTracingRoot: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
};

export default nextConfig;
