/**
 * App A — a Deno worker that ships its logs over HTTP to the central log
 * server (App B, a Node/Express app — see ../server-b).
 *
 * The library is runtime-agnostic here: `createLogger` + `HttpAdapter` use
 * only fetch and timers, so the same code runs on Deno, Node, Bun, or Edge.
 * No database, no `pg` — App A never touches Postgres.
 *
 *   deno task start            # process 20 fake orders, flush, exit
 *   ORDERS=100 deno task start
 */
import { createLogger, ConsoleAdapter, secure, redact } from "@campfhir/bored-logs";
import { HttpAdapter } from "@campfhir/bored-logs/adapters/http";

const LOG_SERVER = Deno.env.get("LOG_SERVER_URL") ?? "http://localhost:4600";
const TOKEN = Deno.env.get("LOG_SHIP_TOKEN") ?? "demo-secret";
const ORDERS = Number(Deno.env.get("ORDERS") ?? 20);

const ship = new HttpAdapter({
  endpoint: `${LOG_SERVER}/api/logs`,
  headers: { authorization: `Bearer ${TOKEN}` },
  batchSize: 10, // the server advertises its own max; the adapter negotiates
  flushInterval: 1000,
  onError: (err) => console.error("[app-a] log shipment failed:", err),
});

const logger = createLogger({
  application: "app-a", // travels on every record — searchable on the server
  version: "1.4.2",
  region: "us-west-2", // a global attribute, stamped on every record
});
logger.addAdapter(new ConsoleAdapter({ showTimestamp: false }));
logger.addAdapter(ship);

// Flush the queue before the process goes away.
Deno.addSignalListener("SIGINT", async () => {
  await logger.flush();
  Deno.exit(0);
});

const SKUS = ["A-1", "B-2", "C-3", "D-4"];
const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

logger.info("app-a starting — shipping to {target}", { target: LOG_SERVER });

for (let i = 1; i <= ORDERS; i++) {
  const order = {
    orderId: `ord_${1000 + i}`,
    // Nested attributes — queryable on the server as session.id, users[*],
    // cart.items[*].sku, cart.total …
    session: { id: `sess_${i % 5}`, device: rand(["ios", "android", "web"]) },
    users: [`u_${i % 7}`, `u_${(i * 3) % 7}`],
    cart: {
      items: [{ sku: rand(SKUS), qty: 1 + (i % 3) }],
      total: Math.round(1000 + Math.random() * 9000) / 100,
    },
    // secure() ships tagged and is encrypted at rest by the LOG SERVER —
    // app-a holds no key material. redact() never leaves this process.
    paymentToken: secure(`tok_${crypto.randomUUID().slice(0, 8)}`),
    debugTrace: redact(`trace ${i} — local only`),
  };

  if (i % 7 === 0) {
    logger.error("payment declined for {orderId}", { ...order, reason: "insufficient_funds" });
  } else {
    logger.info("order {orderId} placed", order);
  }

  await new Promise((r) => setTimeout(r, 50));
}

await logger.flush();
logger.info("app-a done — {n} orders processed", { n: ORDERS });
await logger.flush();
Deno.exit(0);
