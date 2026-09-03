import { fileURLToPath } from "node:url";

/**
 * Resolve every workspace package to its SOURCE entry so the test suites run
 * without a build step (the package.json `exports` point at dist/).
 */
const src = (dir: string) => fileURLToPath(new URL(`./packages/${dir}/src/index.ts`, import.meta.url));

export const workspaceAlias = {
  "@campfhir/bored-logs-psql-migration": src("psql-migration"),
  "@campfhir/bored-logs-psql": src("psql"),
  "@campfhir/bored-logs-server": src("server"),
  "@campfhir/bored-logs-client": src("client"),
  "@campfhir/bored-logs-http": src("http"),
  "@campfhir/bored-logs-ui": src("ui"),
  // Longest names first — vitest/vite alias matching is prefix-based.
  "@campfhir/bored-logs": src("core"),
};
