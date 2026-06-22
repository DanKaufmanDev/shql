#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { connect } from "./database.ts";
import { loadSchema } from "./schema.ts";
import { ShqlError } from "./errors.ts";
import type { GoogleSheetsAuth } from "./types.ts";
import { writeTypes } from "./codegen.ts";
import { backupTable, restoreTable } from "./migrations.ts";
import { materialize } from "./pipeline.ts";
import { createShqlServer, listen } from "./server.ts";

const HELP = `shql — Sheets Query Language

Usage:
  shql tables [--schema path]
  shql describe <table> [--schema path]
  shql validate [--schema path]
  shql inspect [table] [--schema path]
  shql init [table] [--schema path]
  shql doctor [--schema path]
  shql explain <query> [--schema path]
  shql materialize <query> --into <table> [--mode append|replace|merge] [--key field] [--dry-run]
  shql generate types [--out path]
  shql backup <table> --out <path>
  shql restore <table> --file <path>
  shql serve [--port number]
  shql query <query> [--schema path] [--params JSON]
  shql query --file <path> [--schema path] [--params JSON]

Options:
  --schema <path>  Schema file (default: database.shql)
  --params <json>  Named query parameters as a JSON object
  --file <path>    Read the query from a file
  --out <path>     Output file
  --into <table>   Materialization target
  --mode <mode>    append, replace, or merge
  --key <field>    Merge key
  --port <number>  HTTP server port
  --dry-run        Preview without writing
  --json            Emit compact JSON
  --help            Show this help

Authentication environment variables:
  GOOGLE_ACCESS_TOKEN
  GOOGLE_SERVICE_ACCOUNT_JSON
  GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
  GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REFRESH_TOKEN
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function authFromEnvironment(): GoogleSheetsAuth {
  if (process.env.GOOGLE_ACCESS_TOKEN) {
    return { type: "access-token", accessToken: process.env.GOOGLE_ACCESS_TOKEN };
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!credentials.client_email || !credentials.private_key)
      throw new ShqlError(
        "AUTH_ERROR",
        "GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.",
      );
    return {
      type: "service-account",
      clientEmail: credentials.client_email,
      privateKey: credentials.private_key,
      tokenUri: credentials.token_uri,
    };
  }
  if (
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    return {
      type: "oauth",
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    };
  }
  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      type: "service-account",
      clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
      privateKey: process.env.GOOGLE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    };
  }
  throw new ShqlError(
    "AUTH_ERROR",
    "Set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY, or GOOGLE_ACCESS_TOKEN.",
  );
}

function cleanArguments(args: string[]): string[] {
  const withValue = new Set([
    "--schema",
    "--params",
    "--file",
    "--out",
    "--into",
    "--mode",
    "--key",
    "--port",
  ]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (withValue.has(args[index])) {
      index++;
      continue;
    }
    if (["--json", "--dry-run"].includes(args[index])) continue;
    result.push(args[index]);
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const positional = cleanArguments(args);
  const command = positional[0];
  const schemaPath = option(args, "--schema") ?? "database.shql";
  const schema = await loadSchema(schemaPath);
  const needsGoogleAuth = [...schema.connections.values()].some(
    (connection) => connection.provider === "google-sheets",
  );
  const db = await connect({ schema, auth: needsGoogleAuth ? authFromEnvironment() : undefined });
  let output: unknown;

  if (command === "tables") output = db.tables();
  else if (command === "describe") {
    if (!positional[1]) throw new ShqlError("VALIDATION_ERROR", "describe requires a table name.");
    output = db.describe(positional[1]);
  } else if (command === "validate") {
    output = await db.validate();
    if ((output as Awaited<ReturnType<typeof db.validate>>).some((result) => !result.ok))
      process.exitCode = 2;
  } else if (command === "inspect") {
    output = await db.inspect(positional[1]);
  } else if (command === "init") {
    await db.initialize(positional[1]);
    output = { ok: true, initialized: positional[1] ?? db.tables() };
  } else if (command === "doctor") {
    output = await db.doctor();
  } else if (command === "explain") {
    const queryFile = option(args, "--file");
    const query = queryFile ? await readFile(queryFile, "utf8") : positional.slice(1).join(" ");
    if (!query) throw new ShqlError("QUERY_ERROR", "explain requires SHQL text or --file <path>.");
    output = db.explain(query);
  } else if (command === "materialize") {
    const target = option(args, "--into");
    if (!target) throw new ShqlError("VALIDATION_ERROR", "materialize requires --into <table>.");
    const queryFile = option(args, "--file");
    const query = queryFile ? await readFile(queryFile, "utf8") : positional.slice(1).join(" ");
    output = await materialize(db, query, target, {
      mode: (option(args, "--mode") as "append" | "replace" | "merge" | undefined) ?? "append",
      key: option(args, "--key"),
      dryRun: args.includes("--dry-run"),
    });
  } else if (command === "generate" && positional[1] === "types") {
    const path = option(args, "--out") ?? "shql.generated.d.ts";
    await writeTypes(db.schema, path);
    output = { ok: true, path };
  } else if (command === "backup") {
    if (!positional[1]) throw new ShqlError("VALIDATION_ERROR", "backup requires a table.");
    const path = option(args, "--out");
    if (!path) throw new ShqlError("VALIDATION_ERROR", "backup requires --out <path>.");
    output = { rows: await backupTable(db, positional[1], path), path };
  } else if (command === "restore") {
    if (!positional[1]) throw new ShqlError("VALIDATION_ERROR", "restore requires a table.");
    const path = option(args, "--file");
    if (!path) throw new ShqlError("VALIDATION_ERROR", "restore requires --file <path>.");
    output = { rows: await restoreTable(db, positional[1], path), path };
  } else if (command === "serve") {
    const port = Number(option(args, "--port") ?? 4545);
    const server = createShqlServer(db, {
      port,
      token: process.env.SHQL_SERVER_TOKEN,
      allowMutations: process.env.SHQL_ALLOW_MUTATIONS === "true",
    });
    const address = await listen(server, { port });
    process.stdout.write(`SHQL server listening on http://${address.hostname}:${address.port}\n`);
    return;
  } else if (command === "query") {
    const queryFile = option(args, "--file");
    const query = queryFile ? await readFile(queryFile, "utf8") : positional.slice(1).join(" ");
    if (!query) throw new ShqlError("QUERY_ERROR", "query requires SHQL text or --file <path>.");
    const rawParameters = option(args, "--params") ?? "{}";
    const parameters = JSON.parse(rawParameters);
    output = args.includes("--dry-run")
      ? await db.preview(query, parameters)
      : await db.query(query, parameters);
  } else throw new ShqlError("VALIDATION_ERROR", `Unknown command ${command}.`);

  process.stdout.write(
    `${JSON.stringify(output, (_key, value) => (value instanceof Date ? value.toISOString() : value), args.includes("--json") ? 0 : 2)}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ShqlError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details)}\n`);
  } else process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
