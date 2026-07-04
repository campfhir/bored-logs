import ToolbarVariant from "./_variants/toolbar";
import { getInitialLogs } from "./_lib/initial-logs";

// The demo talks to a live database on every request — never prerender.
export const dynamic = "force-dynamic";

export default async function Page() {
  return <ToolbarVariant initialLogs={await getInitialLogs()} />;
}
