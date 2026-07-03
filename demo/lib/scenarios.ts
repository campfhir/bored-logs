// ---------------------------------------------------------------------------
// Fake log generators — deterministic-ish variety so the table, filters, and
// level badges all have something interesting to show.
// ---------------------------------------------------------------------------

export type GeneratedLog = {
  level: string;
  /** `{key}` tokens are interpolated from `attrs` by the logger. */
  template: string;
  attrs: Record<string, unknown>;
};

export type Scenario = {
  id: string;
  label: string;
  description: string;
  generate: () => GeneratedLog[];
};

const SERVICES = ["auth", "api", "db", "cache", "payments", "worker"];
const ENVS = ["prod", "staging"];
const REGIONS = ["us-east-1", "eu-west-1", "ap-south-1"];
const PATHS = ["/login", "/checkout", "/api/orders", "/api/users", "/health"];
const METHODS = ["GET", "POST", "PUT", "DELETE"];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const int = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const id = (prefix: string): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: pick(ENVS),
    region: pick(REGIONS),
    requestId: id("req"),
    ...extra,
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "login",
    label: "Login flow",
    description: "A user authenticating — info entries across the auth service.",
    generate: () => {
      const userId = id("user");
      return [
        {
          level: "debug",
          template: "Auth attempt for {userId} via {method} {path}",
          attrs: base({ userId, service: "auth", method: "POST", path: "/login", statusCode: 100 }),
        },
        {
          level: "info",
          template: "User {userId} logged in from {region}",
          attrs: base({ userId, service: "auth", method: "POST", path: "/login", statusCode: 200, latencyMs: int(40, 180) }),
        },
        {
          level: "info",
          template: "Session issued for {userId}",
          attrs: base({ userId, service: "auth", sessionId: id("sess"), statusCode: 200, latencyMs: int(5, 30) }),
        },
      ];
    },
  },
  {
    id: "checkout",
    label: "Checkout",
    description: "An order placed, with a payment retry warning.",
    generate: () => {
      const userId = id("user");
      const orderId = id("order");
      return [
        {
          level: "info",
          template: "Order {orderId} created by {userId}",
          attrs: base({ userId, orderId, service: "api", method: "POST", path: "/api/orders", statusCode: 201, amount: int(20, 500), latencyMs: int(60, 220) }),
        },
        {
          level: "warn",
          template: "Payment retry {attempt} for order {orderId}",
          attrs: base({ orderId, service: "payments", attempt: 2, statusCode: 402, latencyMs: int(200, 900) }),
        },
        {
          level: "info",
          template: "Order {orderId} confirmed",
          attrs: base({ userId, orderId, service: "payments", statusCode: 200, amount: int(20, 500), latencyMs: int(80, 300) }),
        },
      ];
    },
  },
  {
    id: "errors",
    label: "Error burst",
    description: "A cascade of errors and a critical outage.",
    generate: () => [
      {
        level: "error",
        template: "Unhandled exception in {service}: {error}",
        attrs: base({ service: pick(SERVICES), error: "TypeError: cannot read 'id' of undefined", statusCode: 500, latencyMs: int(100, 1200) }),
      },
      {
        level: "error",
        template: "{method} {path} failed with {statusCode}",
        attrs: base({ service: "api", method: pick(METHODS), path: pick(PATHS), statusCode: 500, latencyMs: int(300, 2000) }),
      },
      {
        level: "critical",
        template: "Database connection pool exhausted on {service}",
        attrs: base({ service: "db", statusCode: 503, poolSize: 20, waiting: int(30, 120) }),
      },
    ],
  },
  {
    id: "slow",
    label: "Slow requests",
    description: "High-latency warnings worth filtering on.",
    generate: () =>
      Array.from({ length: 4 }, () => ({
        level: "warn",
        template: "Slow response {latencyMs}ms on {method} {path}",
        attrs: base({ service: pick(SERVICES), method: pick(METHODS), path: pick(PATHS), statusCode: 200, latencyMs: int(1200, 5000) }),
      })),
  },
  {
    id: "traffic",
    label: "Random traffic ×25",
    description: "A mixed burst across every level and service.",
    generate: () =>
      Array.from({ length: 25 }, () => {
        const level = pick(["debug", "info", "info", "info", "warn", "error"]);
        const statusCode = level === "error" ? pick([500, 502, 503]) : pick([200, 201, 204, 304]);
        return {
          level,
          template: "{method} {path} → {statusCode} in {latencyMs}ms",
          attrs: base({
            service: pick(SERVICES),
            method: pick(METHODS),
            path: pick(PATHS),
            statusCode,
            latencyMs: int(5, 900),
            userId: id("user"),
          }),
        };
      }),
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
