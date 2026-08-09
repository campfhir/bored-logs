import { createLogIngestHandler } from "@campfhir/bored-logs/server";
import { ensureBoredLogs } from "@/lib/logger";

// ---------------------------------------------------------------------------
// POST /api/logs — the ingest endpoint the browser's `useLogger` ships to.
//
// It feeds the shipped records into the *same* server logger + Postgres adapter
// the rest of the demo uses, so client-originated logs land in the same table
// as the server-simulated ones. `transform` enriches each record with
// server-only context (the client can't be trusted to set these).
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const { logger, adapter } = await ensureBoredLogs();

  const handler = createLogIngestHandler({
    logger,
    transform: (record, req) => ({
      ...record,
      attrs: {
        ...record.attrs,
        origin: "browser",
        userAgent: req.headers.get("user-agent") ?? undefined,
      },
    }),
  });

  const res = await handler(request);
  // The Postgres adapter batches on a 5s timer; flush now so shipped logs show
  // up immediately when the client refreshes the table.
  await adapter.flush();
  return res;
}
