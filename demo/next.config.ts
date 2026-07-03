import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const nextConfig: NextConfig = {
  // Consume the library's shipped `dist` (linked via `link:..`) but let Next
  // process its "use client" component boundary.
  transpilePackages: ["@campfhir/bored-logs"],
  // Keep the native-ish Postgres driver out of the bundle; require it at runtime.
  serverExternalPackages: ["pg"],
  // This app is nested in the library repo; trace from the demo dir, not the
  // monorepo root (silences the multiple-lockfiles warning).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
