"use client";

import type { ReactNode } from "react";
import { LoggerProvider } from "@campfhir/bored-logs/client";

// Wraps the app in a client-side Logger that writes to the browser console
// (ConsoleAdapter, on by default) and ships batched records to /api/logs.
//
// `flushInterval={0}` disables the periodic auto-flush so the demo's
// "queued → ship" flow is explicit and visible; a real app would leave the 5s
// timer on. `batchSize` is bumped so a burst of demo clicks never auto-flushes
// mid-demonstration.
export default function DemoLoggerProvider({ children }: { children: ReactNode }) {
  return (
    <LoggerProvider
      endpoint="/api/logs"
      application="bored-logs-demo"
      level="debug"
      flushInterval={0}
      batchSize={100}
    >
      {children}
    </LoggerProvider>
  );
}
