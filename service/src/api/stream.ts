import type http from "node:http";
import crypto from "node:crypto";
import { subscribe, lastEvents, type LiveEvent } from "../live/bus.js";
import { logger } from "../core/log.js";

/**
 * GET /api/stream – Server-Sent Events for the live dashboard (W19, module 5.26). Plain Node, no library.
 *  - a full snapshot on connect (event "snapshot"), then the latest activity lines, then small deltas from the bus;
 *  - a comment line every 20 s keeps the connection open through proxies and sleep;
 *  - at most 5 clients; the browser's EventSource reconnects by itself and gets a fresh snapshot.
 * EventSource cannot send headers, so the session token comes as ?t=… (same rule as the dashboard page).
 */

export const MAX_CLIENTS = 5;
export const HEARTBEAT_MS = 20_000;

interface Client { res: http.ServerResponse; close: () => void }
const clients = new Set<Client>();

export const streamClientCount = () => clients.size;

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** U+2028 / U+2029 are valid in JSON but end a line in some readers; built from a string so the compiler keeps the escapes. */
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");

export function sseFrame(event: string, data: unknown, id?: number): string {
  const json = JSON.stringify(data ?? null).replace(LINE_SEPARATORS, (c) => (c.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"));
  return `${id != null ? `id: ${id}\n` : ""}event: ${event}\ndata: ${json}\n\n`;
}

export interface StreamOpts {
  /** Builds the full snapshot (normally dashboardData.overviewSnapshot). */
  snapshot: () => unknown;
  heartbeatMs?: number;
  maxClients?: number;
}

/**
 * Serve one SSE connection. Returns false (and answers 401/403/503) when the request is refused.
 * `req`/`res` only need the small part of the Node API used here, so tests pass simple fakes.
 */
export function handleStream(req: http.IncomingMessage, res: http.ServerResponse, token: string, opts: StreamOpts): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const json = (status: number, error: string) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify({ error }));
    return false;
  };
  const given = url.searchParams.get("t") ?? (req.headers?.["x-aiw-token"] as string | undefined);
  if (!sameToken(given ?? undefined, token)) return json(401, "missing or invalid session token");
  const host = String(req.headers?.host ?? "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(403, "bad host");
  if (clients.size >= (opts.maxClients ?? MAX_CLIENTS)) return json(503, "too many dashboard windows are open – close one and reload");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no",
  });
  const write = (s: string) => { try { res.write(s); } catch { client.close(); } };

  let closed = false;
  let unsubscribe: () => void = () => {};
  let beat: NodeJS.Timeout | undefined;
  const client: Client = {
    res,
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (beat) clearInterval(beat);
      clients.delete(client);
      try { res.end(); } catch { /* already gone */ }
    },
  };
  clients.add(client);

  write("retry: 3000\n\n");
  try { write(sseFrame("snapshot", opts.snapshot())); }
  catch (e: any) { logger.warn("dashboard snapshot failed", { error: e.message }); write(sseFrame("snapshot", { error: "Could not load the dashboard data." })); }
  for (const e of lastEvents("activity")) write(sseFrame(e.kind, { ...(e.payload as object), at: e.at }, e.seq));

  if (closed) return true;                               // the client went away while the snapshot was written
  unsubscribe = subscribe((e: LiveEvent) => {
    if (closed || e.kind === "snapshot") return;
    write(sseFrame(e.kind, e.payload, e.seq));
  });
  beat = setInterval(() => write(`: ping ${Date.now()}\n\n`), opts.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref?.();

  req.on?.("close", client.close);
  res.on?.("close", client.close);
  res.on?.("error", client.close);
  return true;
}

/** Close every open stream (service shutdown). */
export function closeAllStreams(): void {
  for (const c of [...clients]) c.close();
}
