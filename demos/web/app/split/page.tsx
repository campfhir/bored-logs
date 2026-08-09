import SidebarVariant from "../_variants/sidebar";
import { getInitialLogs } from "../_lib/initial-logs";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <SidebarVariant initialLogs={await getInitialLogs()} />;
}
