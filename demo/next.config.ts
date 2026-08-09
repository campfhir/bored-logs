import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // `@campfhir/bored-logs` imports resolve to ../src via tsconfig `paths`
  // (live local source, no tsup rebuild); transpilePackages stays as the
  // guard for anything that falls back to the `link:..` dist copy.
  transpilePackages: ["@campfhir/bored-logs"],
  // Allow compiling the library source, which lives outside the demo root.
  experimental: { externalDir: true },
  // Turbopack must treat the repository as the workspace so ../src compiles.
  turbopack: { root: dirname(dirname(fileURLToPath(import.meta.url))) },
  compiler: {
    // Keep `console.*` calls in production builds via SWC, so `ConsoleAdapter` output appears in browser devtools.
    removeConsole: false,
  },
  // Keep the native-ish Postgres driver out of the bundle; require it at runtime.
  serverExternalPackages: ["pg"],
  // The app graph now includes ../src, so trace from the repository root.
  outputFileTracingRoot: dirname(dirname(fileURLToPath(import.meta.url))),
};

export default nextConfig;
