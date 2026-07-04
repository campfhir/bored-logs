import CompactVariant from "../_variants/compact";
import { getInitialLogs } from "../_lib/initial-logs";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <CompactVariant initialLogs={await getInitialLogs()} />;
}
