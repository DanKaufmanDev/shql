import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ShqlDatabase } from "./database.ts";
import type { JobRunner } from "./jobs.ts";

export interface ServerOptions {
  token?: string;
  port?: number;
  hostname?: string;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  allowMutations?: boolean;
  allowedTables?: string[];
  jobs?: JobRunner;
}

async function jsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, (_key, value) => (value instanceof Date ? value.toISOString() : value)));
}

export function createShqlServer(db: ShqlDatabase, options: ServerOptions = {}): Server {
  const limits = new Map<string, { minute: number; count: number }>();
  const allowed = options.allowedTables ? new Set(options.allowedTables) : undefined;
  return createServer(async (request, response) => {
    try {
      if (options.token && request.headers.authorization !== `Bearer ${options.token}`)
        return send(response, 401, { error: "Unauthorized" });
      const address = request.socket.remoteAddress ?? "unknown";
      const minute = Math.floor(Date.now() / 60_000);
      const current = limits.get(address);
      const rate = current?.minute === minute ? current : { minute, count: 0 };
      rate.count++;
      limits.set(address, rate);
      if (rate.count > (options.rateLimitPerMinute ?? 120))
        return send(response, 429, { error: "Rate limit exceeded" });

      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/v1/health") return send(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/v1/tables")
        return send(response, 200, { tables: db.tables() });
      if (request.method === "GET" && url.pathname === "/v1/schema") {
        return send(response, 200, { tables: db.tables().map((name) => db.describe(name)) });
      }
      if (request.method === "POST" && ["/v1/query", "/v1/explain"].includes(url.pathname)) {
        const body = await jsonBody(request, options.maxBodyBytes ?? 1_000_000);
        if (typeof body.query !== "string") return send(response, 400, { error: "query must be a string" });
        const plan = db.explain(body.query);
        if (allowed && plan.tables.some((table) => !allowed.has(table)))
          return send(response, 403, { error: "Query accesses a disallowed table" });
        if (!options.allowMutations && plan.operation !== "select")
          return send(response, 403, { error: "Mutations are disabled" });
        if (url.pathname === "/v1/explain") return send(response, 200, plan);
        if (body.dryRun === true)
          return send(
            response,
            200,
            await db.preview(body.query, (body.parameters ?? {}) as Record<string, never>),
          );
        return send(
          response,
          200,
          await db.query(body.query, (body.parameters ?? {}) as Record<string, never>),
        );
      }
      const jobMatch = /^\/v1\/jobs\/([^/]+)\/run$/.exec(url.pathname);
      if (request.method === "POST" && jobMatch && options.jobs)
        return send(response, 202, await options.jobs.run(decodeURIComponent(jobMatch[1])));
      if (request.method === "GET" && url.pathname === "/v1/jobs" && options.jobs)
        return send(response, 200, { jobs: options.jobs.list() });
      return send(response, 404, { error: "Not found" });
    } catch (error) {
      const status = Number((error as { status?: number }).status) || 500;
      return send(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function listen(
  server: Server,
  options: ServerOptions = {},
): Promise<{ port: number; hostname: string }> {
  const port = options.port ?? 4545;
  const hostname = options.hostname ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => server.listen(port, hostname, resolve).once("error", reject));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : port, hostname };
}
