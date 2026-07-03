import type { LogRow } from "@campfhir/bored-logs";
import Dashboard from "./dashboard";
import { search } from "./actions";

// The demo talks to a live database on every request — never prerender.
export const dynamic = "force-dynamic";

export default async function Page() {
  let initialLogs: LogRow[];
  try {
    initialLogs = await search(null, [], "desc");
  } catch {
    // DB not up yet — render empty; the client can retry after simulating.
    initialLogs = [];
  }
  return <Dashboard initialLogs={initialLogs} />;
}
