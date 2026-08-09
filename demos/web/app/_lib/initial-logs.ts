import type { LogRow } from "@campfhir/bored-logs";
import { search } from "../actions";

/**
 * Fetch the first page of logs for a variant's server render. Swallows DB
 * errors (e.g. the database isn't up yet) so the page still renders empty and
 * the client can retry after simulating.
 */
export async function getInitialLogs(): Promise<LogRow[]> {
  try {
    return await search(null, [], "desc");
  } catch {
    return [];
  }
}
