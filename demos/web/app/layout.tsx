import type { Metadata } from "next";
import "./globals.css";
import Nav from "./_components/nav";
import DemoLoggerProvider from "./_components/logger-provider";

export const metadata: Metadata = {
  title: "bored-logs demo",
  description: "Live demo of @campfhir/bored-logs UI components + Postgres adapter",
};

// Set the theme class before paint so there's no light/dark flash on load.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="flex h-dvh flex-col bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <DemoLoggerProvider>
          <Nav />
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </DemoLoggerProvider>
      </body>
    </html>
  );
}
