import { DurableObject } from "cloudflare:workers";

/**
 * A Link registry on Cloudflare: one Worker plus one Durable Object per deployment, which is one
 * network. Servers send a heartbeat every 10 seconds and get the live server list back in the same
 * response, so a network of any size costs one request per server per heartbeat.
 *
 * Protocol (every request needs `Authorization: Bearer <LINK_TOKEN>`):
 *   GET    /v1/secret        -> {"secret": "..."}          created on first call
 *   PUT    /v1/servers/{id}  body: server JSON, with its online players -> {"servers": [...]}
 *   DELETE /v1/servers/{id}  -> 204
 */

export interface Env {
  LINK_TOKEN: string;
  REGISTRY: DurableObjectNamespace<Registry>;
}

/** Link sends a heartbeat every 10 seconds; missing three in a row drops a server out of matchmaking. */
const STALE_AFTER_MS = 30_000;
const MAX_SERVERS = 500;
/** Per server. Far above any real Hytale server, but it keeps one bad heartbeat from bloating storage. */
const MAX_ONLINE = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LinkPlayer {
  uuid: string;
  name: string;
}

interface LinkServer {
  id: string;
  group: string;
  host: string;
  port: number;
  players: number;
  maxPlayers: number;
  online: LinkPlayer[];
  lastSeen?: number;
}

export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
  }

  secret(): string {
    const existing = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'secret'").toArray();
    if (existing.length > 0) {
      return existing[0].value;
    }
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('secret', ?)", secret);
    return secret;
  }

  heartbeat(server: LinkServer): LinkServer[] | null {
    const now = Date.now();
    this.sql.exec("DELETE FROM servers WHERE last_seen < ?", now - STALE_AFTER_MS);
    const known = this.sql.exec("SELECT 1 FROM servers WHERE id = ?", server.id).toArray().length > 0;
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM servers").one().n;
    if (!known && count >= MAX_SERVERS) {
      return null;
    }
    this.sql.exec(
      "INSERT INTO servers (id, body, last_seen) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, last_seen = excluded.last_seen",
      server.id,
      JSON.stringify(server),
      now,
    );
    return this.sql
      .exec<{ body: string; last_seen: number }>("SELECT body, last_seen FROM servers ORDER BY id")
      .toArray()
      .map((row) => ({ ...(JSON.parse(row.body) as LinkServer), lastSeen: row.last_seen }));
  }

  leave(id: string): void {
    this.sql.exec("DELETE FROM servers WHERE id = ?", id);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.LINK_TOKEN || !authorized(request.headers.get("Authorization"), env.LINK_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("network"));
    const url = new URL(request.url);

    if (url.pathname === "/v1/secret" && request.method === "GET") {
      return json({ secret: await registry.secret() });
    }

    const match = url.pathname.match(/^\/v1\/servers\/([^/]+)$/);
    if (!match) {
      return json({ error: "not found" }, 404);
    }
    const id = decodeURIComponent(match[1]);

    if (request.method === "DELETE") {
      await registry.leave(id);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "PUT") {
      return json({ error: "method not allowed" }, 405);
    }

    let server: LinkServer | null;
    try {
      server = parseServer(await request.json(), id);
    } catch {
      server = null;
    }
    if (!server) {
      return json({ error: "body must be a server whose id matches the path" }, 400);
    }
    const servers = await registry.heartbeat(server);
    if (!servers) {
      return json({ error: `this registry holds at most ${MAX_SERVERS} servers` }, 409);
    }
    return json({ servers });
  },
} satisfies ExportedHandler<Env>;

function parseServer(body: unknown, id: string): LinkServer | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const b = body as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  if (b.id !== id || !text(b.id, 64) || !text(b.group, 64) || !text(b.host, 255)) {
    return null;
  }
  if (!int(b.port) || (b.port as number) < 1 || (b.port as number) > 65535) {
    return null;
  }
  return {
    id: b.id as string,
    group: b.group as string,
    host: b.host as string,
    port: b.port as number,
    players: int(b.players) ? (b.players as number) : -1,
    maxPlayers: int(b.maxPlayers) ? (b.maxPlayers as number) : -1,
    online: parseOnline(b.online),
  };
}

/** Keeps the well-formed entries and drops the rest, so one bad name doesn't cost the whole list. */
function parseOnline(value: unknown): LinkPlayer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const players: LinkPlayer[] = [];
  for (const entry of value.slice(0, MAX_ONLINE)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { uuid, name } = entry as Record<string, unknown>;
    if (typeof uuid === "string" && UUID.test(uuid) && typeof name === "string" && name.length > 0 && name.length <= 64) {
      players.push({ uuid, name });
    }
  }
  return players;
}

/** Constant-time, so response timing does not reveal how much of a guessed token was right. */
function authorized(header: string | null, token: string): boolean {
  const presented = new TextEncoder().encode(header ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  if (presented.byteLength !== expected.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(presented, expected);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
