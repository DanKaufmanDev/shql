import { readFile } from "node:fs/promises";
import { ShqlError, invariant } from "./errors.ts";
import type {
  ColumnSchema,
  ColumnType,
  ConnectionProvider,
  ConnectionSchema,
  DatabaseSchema,
  TableSchema,
} from "./types.ts";

const COLUMN_TYPES = new Set<ColumnType>(["id", "text", "number", "boolean", "date", "datetime"]);

function resolveValue(raw: string, env: Record<string, string | undefined>, kind: string): string {
  const value = raw.trim();
  const match = /^\$?\{([A-Z_][A-Z0-9_]*)\}$/.exec(value);
  if (!match) return value.replace(/^['"]|['"]$/g, "");
  const resolved = env[match[1]];
  invariant(resolved, "SCHEMA_ERROR", `Missing environment variable ${match[1]} for ${kind}.`);
  return resolved;
}

function withoutComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

export function parseSchema(
  source: string,
  env: Record<string, string | undefined> = process.env,
): DatabaseSchema {
  const input = withoutComments(source);
  const sheetMatch = /\bSHEET\s+([^\s]+)/i.exec(input) ?? /^\s*\[([^#][^\]]*)\]/m.exec(input);
  const connections = new Map<string, ConnectionSchema>();
  const connectionPattern = /\bCONNECTION\s+([A-Za-z_][\w]*)\s+FROM\s+([A-Za-z_-]+)\s+([^\s]+)/gi;
  let connectionMatch: RegExpExecArray | null;
  while ((connectionMatch = connectionPattern.exec(input))) {
    const [, name, rawProvider, rawSource] = connectionMatch;
    const lowered = rawProvider.toLowerCase();
    const provider = (lowered === "xlsx" ? "excel" : lowered) as ConnectionProvider;
    invariant(
      ["google-sheets", "memory", "json", "csv", "excel", "http", "postgres", "mysql", "sqlite"].includes(
        provider,
      ),
      "SCHEMA_ERROR",
      `Unknown connection provider ${rawProvider}.`,
    );
    invariant(!connections.has(name), "SCHEMA_ERROR", `Connection ${name} is declared more than once.`);
    connections.set(name, {
      name,
      provider,
      source: resolveValue(rawSource, env, `CONNECTION ${name}`),
    });
  }
  if (sheetMatch) {
    connections.set("default", {
      name: "default",
      provider: "google-sheets",
      source: resolveValue(sheetMatch[1], env, "SHEET"),
    });
  }
  invariant(
    connections.size > 0,
    "SCHEMA_ERROR",
    "Schema must declare SHEET <spreadsheet-id>, [<spreadsheet-id>], or a CONNECTION.",
  );
  const defaultConnection = connections.has("default") ? "default" : connections.keys().next().value!;
  const spreadsheetId = connections.get(defaultConnection)!.source;
  const tables = new Map<string, TableSchema>();
  const tablePattern =
    /\bTABLE\s+([A-Za-z_][\w]*)\s+FROM\s+(?:([A-Za-z_][\w]*)\.)?#(\{[A-Z_][A-Z0-9_]*\}|[^\s{]+)\s*\{([\s\S]*?)\}/gi;
  let match: RegExpExecArray | null;

  while ((match = tablePattern.exec(input))) {
    const [, name, rawConnection, rawTabId, body] = match;
    const connection = rawConnection ?? defaultConnection;
    invariant(
      connections.has(connection),
      "SCHEMA_ERROR",
      `Table ${name} uses unknown connection ${connection}.`,
    );
    invariant(!tables.has(name), "SCHEMA_ERROR", `Table ${name} is declared more than once.`);
    const columns: ColumnSchema[] = [];
    const columnNames = new Set<string>();

    for (const declaration of body
      .split(/\n/)
      .map((part) => part.trim().replace(/,$/, ""))
      .filter(Boolean)) {
      const columnMatch = /^([A-Za-z_][\w]*)\s*:\s*([A-Za-z]+)(\?)?(?:\s+([\s\S]+))?$/.exec(declaration);
      invariant(columnMatch, "SCHEMA_ERROR", `Invalid column declaration in ${name}: ${declaration}`);
      const [, columnName, rawType, optional, constraints = ""] = columnMatch;
      const type = rawType.toLowerCase() as ColumnType;
      invariant(COLUMN_TYPES.has(type), "SCHEMA_ERROR", `Unknown type ${rawType} on ${name}.${columnName}.`);
      invariant(!columnNames.has(columnName), "SCHEMA_ERROR", `Duplicate column ${name}.${columnName}.`);
      columnNames.add(columnName);
      const column: ColumnSchema = { name: columnName, type, nullable: Boolean(optional) };
      if (/\bUNIQUE\b/i.test(constraints)) column.unique = true;
      const allowed = /\bIN\s*(\[[^\]]*\])/i.exec(constraints);
      if (allowed) {
        try {
          column.allowed = JSON.parse(allowed[1]) as ColumnSchema["allowed"];
        } catch {
          throw new ShqlError("SCHEMA_ERROR", `Invalid IN constraint on ${name}.${columnName}.`);
        }
      }
      const min = />=\s*(-?\d+(?:\.\d+)?)/.exec(constraints);
      const max = /<=\s*(-?\d+(?:\.\d+)?)/.exec(constraints);
      if (min) column.min = Number(min[1]);
      if (max) column.max = Number(max[1]);
      const pattern = /\bMATCHES\s+\/((?:\\.|[^/])+)\/[a-z]*/i.exec(constraints);
      if (pattern) column.pattern = pattern[1];
      if (/\bMATCHES\s+EMAIL\b/i.test(constraints)) column.pattern = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
      const defaultMatch =
        /\bDEFAULT\s+(NOW\(\)|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|-?\d+(?:\.\d+)?|TRUE|FALSE|NULL)/i.exec(
          constraints,
        );
      if (defaultMatch) {
        const raw = defaultMatch[1];
        if (/^NOW\(\)$/i.test(raw)) column.defaultNow = true;
        else if (/^['"]/.test(raw)) column.defaultValue = raw.slice(1, -1);
        else if (/^TRUE$/i.test(raw)) column.defaultValue = true;
        else if (/^FALSE$/i.test(raw)) column.defaultValue = false;
        else if (/^NULL$/i.test(raw)) column.defaultValue = null;
        else column.defaultValue = Number(raw);
      }
      columns.push(column);
    }

    invariant(columns.length > 0, "SCHEMA_ERROR", `Table ${name} must declare at least one column.`);
    invariant(
      columns.filter((column) => column.type === "id").length <= 1,
      "SCHEMA_ERROR",
      `Table ${name} may contain at most one id column.`,
    );
    tables.set(name, {
      name,
      tabId: resolveValue(rawTabId, env, `TABLE ${name}`),
      connection,
      columns,
    });
  }

  const compactTablePattern = /\[#(\{[A-Z_][A-Z0-9_]*\}|[^\s\]]+)\s+AS\s+([A-Za-z_][\w]*)\]/gi;
  while ((match = compactTablePattern.exec(input))) {
    const [, rawTabId, name] = match;
    invariant(!tables.has(name), "SCHEMA_ERROR", `Table ${name} is declared more than once.`);
    tables.set(name, {
      name,
      tabId: resolveValue(rawTabId, env, `TABLE ${name}`),
      connection: defaultConnection,
      columns: [],
    });
  }

  const viewPattern = /\bVIEW\s+([A-Za-z_][\w]*)\s+AS\s*\{([\s\S]*?)\}/gi;
  while ((match = viewPattern.exec(input))) {
    const [, name, query] = match;
    invariant(!tables.has(name), "SCHEMA_ERROR", `View ${name} conflicts with an existing table.`);
    tables.set(name, {
      name,
      tabId: `@view:${name}`,
      connection: defaultConnection,
      columns: [],
      view: query.trim(),
    });
  }

  invariant(tables.size > 0, "SCHEMA_ERROR", "Schema must declare at least one TABLE.");
  return { spreadsheetId, defaultConnection, connections, tables };
}

export async function loadSchema(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DatabaseSchema> {
  try {
    return parseSchema(await readFile(path, "utf8"), env);
  } catch (error) {
    if (error instanceof ShqlError) throw error;
    throw new ShqlError("SCHEMA_ERROR", `Unable to load schema from ${path}.`, { cause: String(error) });
  }
}
