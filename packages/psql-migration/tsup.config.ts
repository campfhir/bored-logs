import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  clean: true,
  // Never bundle sibling packages or peer deps — the consumer supplies them.
  external: [/^@campfhir\//, "react", "react-dom", "kysely", "kysely/helpers/postgres", "pg"],
});
