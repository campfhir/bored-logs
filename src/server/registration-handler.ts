/**
 * The client-registration endpoint for end-to-end shipment encryption.
 *
 * `createLogRegistrationHandler` returns a standard Web-Fetch
 * `(Request) => Promise<Response>` — mount it wherever your router lives
 * (Next.js Route Handler, Hono, an Express bridge, …), typically as a sibling
 * of the ingest endpoint (the `HttpAdapter` defaults to `<endpoint>/register`).
 *
 * The exchange: the client POSTs its identity and ECDSA public signing key;
 * the server upserts the registration and answers with its ECDH public
 * encryption key. Registration is trust-on-first-use with last-write-wins —
 * FRONT THIS ENDPOINT WITH THE SAME AUTH AS INGEST (the adapter sends its
 * configured `headers`/`credentials` here too), or anyone who can reach it
 * can overwrite a client's signing key.
 */
import type { E2EServerContext } from "./e2e-context";
import { E2E_ERROR_HEADER } from "../adapters/http/e2e-wire";

/** Options for {@link createLogRegistrationHandler}. */
export type LogRegistrationHandlerOptions = {
  /**
   * Gate registrations (checked BEFORE anything touches the store) — the
   * one-line way to front the TOFU endpoint with the same auth as ingest.
   * Return false to answer 401.
   */
  authorize?: (request: Request) => boolean | Promise<boolean>;
};

/** Build the registration Fetch handler bound to a shared {@link E2EServerContext}. */
export function createLogRegistrationHandler(
  context: E2EServerContext,
  options: LogRegistrationHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async function handler(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (options.authorize && !(await options.authorize(request))) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json", [E2E_ERROR_HEADER]: "unauthorized" },
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return registrationError("bad-e2e-headers", "invalid JSON body", context);
    }
    const { clientId, algo, signingKey } = (body ?? {}) as {
      clientId?: unknown;
      algo?: unknown;
      signingKey?: unknown;
    };
    if (typeof clientId !== "string" || typeof algo !== "string" || signingKey == null) {
      return registrationError(
        "bad-e2e-headers",
        "expected { clientId, algo, signingKey } JSON body",
        context,
      );
    }

    const result = await context.registerClient({
      clientId,
      algo,
      signingKey: signingKey as JsonWebKey,
    });
    if (!result.ok) {
      // A key-continuity conflict is the caller's misconfiguration (or an
      // attempted takeover) — 409, distinct from validation errors.
      const status = result.code === "client-key-conflict" ? 409 : 400;
      return registrationError(result.code, result.error, context, status);
    }

    return new Response(
      JSON.stringify({ clientId, algo, serverKey: result.serverKeyJwk }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function registrationError(
  code: string,
  error: string,
  context: E2EServerContext,
  status = 400,
): Response {
  return new Response(JSON.stringify({ error, supportedAlgos: [...context.algos] }), {
    status,
    headers: { "content-type": "application/json", [E2E_ERROR_HEADER]: code },
  });
}
