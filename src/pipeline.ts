import { invariant } from "./errors.ts";
import type { Expression, Query } from "./query.ts";
import type { QueryResult, Row, Scalar } from "./types.ts";
import type { ShqlDatabase } from "./database.ts";

export interface MaterializeOptions {
  mode?: "append" | "replace" | "merge";
  key?: string;
  dryRun?: boolean;
}

export interface MaterializeResult {
  sourceRows: number;
  writtenRows: number;
  mode: NonNullable<MaterializeOptions["mode"]>;
  dryRun: boolean;
  sample: Row[];
}

function literal(value: Scalar): Expression {
  return { kind: "literal", value };
}

function writableValues(row: Row, managedVersion = "_shql_version"): Record<string, Expression> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([name]) => name !== managedVersion)
      .map(([name, value]) => [name, literal(value)]),
  );
}

export async function materialize(
  db: ShqlDatabase,
  sourceQuery: string,
  target: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const mode = options.mode ?? "append";
  const source = await db.query(sourceQuery);
  invariant(
    source.operation === "select",
    "VALIDATION_ERROR",
    "Materialization source must be a SELECT query.",
  );
  const table = db.describe(target);
  const columns = new Set(table.columns.map((column) => column.name));
  const rows = source.rows.map(
    (row) => Object.fromEntries(Object.entries(row).filter(([name]) => columns.has(name))) as Row,
  );
  if (options.dryRun)
    return { sourceRows: rows.length, writtenRows: 0, mode, dryRun: true, sample: rows.slice(0, 10) };

  if (mode === "replace") {
    const adapter = db.adapter(target);
    const existing = await adapter.read(table);
    await adapter.delete(table, existing);
  }
  if (mode === "merge") {
    invariant(options.key, "VALIDATION_ERROR", "MERGE materialization requires a key.");
    for (const row of rows) {
      const values = writableValues(row);
      const idColumn = table.columns.find((column) => column.type === "id")?.name;
      if (idColumn && idColumn !== options.key) delete values[idColumn];
      const query: Query = {
        operation: "upsert",
        table: target,
        key: options.key,
        values,
        returning: [],
      };
      await db.execute(query);
    }
  } else if (rows.length) {
    const query: Query = {
      operation: "insert",
      table: target,
      rows: rows.map((row) => writableValues(row)),
      returning: [],
    };
    await db.execute(query);
  }
  return {
    sourceRows: rows.length,
    writtenRows: rows.length,
    mode,
    dryRun: false,
    sample: rows.slice(0, 10),
  };
}

export async function sync(
  db: ShqlDatabase,
  source: string,
  target: string,
  key: string,
  where?: string,
): Promise<MaterializeResult> {
  return materialize(db, `FROM ${source}${where ? ` WHERE ${where}` : ""} SELECT *`, target, {
    mode: "merge",
    key,
  });
}

export async function transform(
  db: ShqlDatabase,
  query: string,
  parameters: Record<string, Scalar | undefined> = {},
): Promise<QueryResult> {
  return db.query(query, parameters);
}
