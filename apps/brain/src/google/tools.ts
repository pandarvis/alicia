import type { ToolProvider } from "../tools/catalog.ts";
import { calendarTools } from "./calendar-tools.ts";
import { gmailTools } from "./gmail-tools.ts";
import type { GoogleClient } from "./google-client.ts";

/** The Google tool family (3a's ToolProvider): every tool bound to the turn's person. No tool sends anything. */
export function googleTools(client: GoogleClient, timeZone: string): ToolProvider {
  return (scope) => {
    const access = client.forTurn(scope);
    // The scope itself: whether the turn is trusted is read when a tool runs.
    return [...calendarTools(access, timeZone, scope), ...gmailTools(access, timeZone)];
  };
}
