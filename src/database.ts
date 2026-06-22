import { Engine } from "./engine.ts";
import { invariant } from "./errors.ts";
import { loadSchema } from "./schema.ts";
import { explainQuery, type QueryPlan } from "./planner.ts";
import type { Query } from "./query.ts";
import { parseQuery } from "./query.ts";
import type { Governance, GovernanceContext } from "./governance.ts";
import { GoogleSheetsAdapter } from "./adapters/google-sheets.ts";
import { JsonAdapter } from "./adapters/json.ts";
import { CsvAdapter } from "./adapters/csv.ts";
import { XlsxAdapter } from "./adapters/xlsx.ts";
import { MemoryAdapter } from "./adapters/memory.ts";
import { HttpAdapter } from "./adapters/http.ts";
import type {
  ConnectOptions,
  DatabaseSchema,
  DoctorResult,
  QueryResult,
  PreviewResult,
  Scalar,
  TableAdapter,
  TableInspection,
  TableSchema,
} from "./types.ts";

export class ShqlDatabase {
  private readonly engine: Engine;
  private readonly adapters: Map<string, TableAdapter>;
  private readonly governance?: Governance;
  private readonly context?: GovernanceContext;
  readonly schema: DatabaseSchema;

  constructor(
    schema: DatabaseSchema,
    adapter: TableAdapter | Map<string, TableAdapter>,
    governance?: Governance,
    context?: GovernanceContext,
  ) {
    this.schema = schema;
    this.adapters = adapter instanceof Map ? adapter : new Map([[schema.defaultConnection, adapter]]);
    this.engine = new Engine(schema, (table) => this.adapterFor(table));
    this.governance = governance;
    this.context = context;
  }

  private adapterFor(table: TableSchema): TableAdapter {
    const adapter = this.adapters.get(table.connection) ?? this.adapters.get(this.schema.defaultConnection);
    invariant(adapter, "ADAPTER_ERROR", `No adapter is configured for connection ${table.connection}.`);
    return adapter;
  }

  query(source: string, parameters: Record<string, Scalar | undefined> = {}): Promise<QueryResult> {
    return this.execute(parseQuery(source), parameters);
  }

  async execute(
    source: string | Query,
    parameters: Record<string, Scalar | undefined> = {},
  ): Promise<QueryResult> {
    const query = typeof source === "string" ? parseQuery(source) : source;
    if (this.governance && this.context) this.governance.authorize(query, this.context);
    try {
      let result = await this.engine.execute(query, parameters);
      if (this.governance && this.context) {
        result = this.governance.mask(result, query, this.context);
        await this.governance.audit(query, this.context, result);
      }
      return result;
    } catch (error) {
      if (this.governance && this.context) await this.governance.audit(query, this.context, undefined, error);
      throw error;
    }
  }

  adapter(table: string): TableAdapter {
    return this.adapterFor(this.describe(table));
  }

  explain(source: string): QueryPlan {
    return explainQuery(source, this.schema);
  }

  async preview(source: string, parameters: Record<string, Scalar | undefined> = {}): Promise<PreviewResult> {
    const query = parseQuery(source);
    if (query.operation === "select") {
      const result = await this.execute(query, parameters);
      return { operation: "select", affectedRows: result.affectedRows, rows: result.rows, warnings: [] };
    }
    if (query.operation === "insert") {
      return {
        operation: "insert",
        affectedRows: query.rows.length,
        rows: [],
        warnings: ["Generated IDs and defaults are not evaluated during preview."],
      };
    }
    if (query.operation === "upsert") {
      return {
        operation: "upsert",
        affectedRows: 1,
        rows: [],
        warnings: ["Preview does not determine whether UPSERT will insert or update."],
      };
    }
    const selection: Query = {
      operation: "select",
      table: query.table,
      alias: query.alias,
      joins: query.joins,
      lets: query.lets,
      where: query.where,
      groupBy: [],
      select: [{ expression: "*" }],
      sort: [],
    };
    const result = await this.execute(selection, parameters);
    return {
      operation: query.operation,
      affectedRows: result.rows.length,
      rows: result.rows.slice(0, 100),
      warnings: result.rows.length > 100 ? ["Preview rows are limited to the first 100 matches."] : [],
    };
  }

  tables(): string[] {
    return [...this.schema.tables.keys()];
  }

  describe(table: string): TableSchema {
    const schema = this.schema.tables.get(table);
    invariant(schema, "VALIDATION_ERROR", `Unknown table ${table}.`);
    return schema;
  }

  async inspect(table?: string): Promise<TableInspection[]> {
    const tables = (table ? [this.describe(table)] : [...this.schema.tables.values()]).filter(
      (schema) => !schema.view,
    );
    return Promise.all(
      tables.map((schema) => {
        const adapter = this.adapterFor(schema);
        invariant(
          adapter.inspect,
          "ADAPTER_ERROR",
          `Connection ${schema.connection} does not support inspection.`,
        );
        return adapter.inspect(schema);
      }),
    );
  }

  async validate(): Promise<
    Array<{ table: string; ok: boolean; issues: string[]; inspection: TableInspection }>
  > {
    const inspections = await this.inspect();
    const results = inspections.map((inspection) => {
      const table = this.describe(inspection.table);
      const expected = table.columns.map((column) => column.name);
      const issues: string[] = [];
      if (expected.length === 0) issues.push("Compact inferred table is read-only.");
      else if (
        inspection.headers.length !== expected.length ||
        expected.some((name, index) => inspection.headers[index] !== name)
      ) {
        issues.push(
          `Header mismatch. Expected: ${expected.join(", ") || "(none)"}. Actual: ${inspection.headers.join(", ") || "(none)"}.`,
        );
      }
      const ids = table.columns.filter((column) => column.type === "id");
      if (ids.length === 0 && expected.length > 0) issues.push("Typed table has no id column.");
      const version = table.columns.find((column) => column.name === "_shql_version");
      if (!version && expected.length > 0)
        issues.push("Typed table has no _shql_version column; concurrent writes are not protected.");
      if (version && version.type !== "number") issues.push("_shql_version must have type number.");
      return { table: table.name, ok: issues.length === 0, issues, inspection };
    });
    for (const result of results) {
      try {
        await this.engine.execute(`FROM ${result.table} SELECT *`);
      } catch (error) {
        result.issues.push(error instanceof Error ? error.message : String(error));
        result.ok = false;
      }
    }
    return results;
  }

  async initialize(table?: string): Promise<void> {
    const tables = (table ? [this.describe(table)] : [...this.schema.tables.values()]).filter(
      (schema) => !schema.view,
    );
    for (const schema of tables) {
      const adapter = this.adapterFor(schema);
      invariant(
        adapter.initialize,
        "ADAPTER_ERROR",
        `Connection ${schema.connection} does not support initialization.`,
      );
      await adapter.initialize(schema);
    }
  }

  async doctor(): Promise<DoctorResult> {
    const results: DoctorResult[] = [];
    for (const [name, adapter] of this.adapters) {
      invariant(adapter.doctor, "ADAPTER_ERROR", `Connection ${name} does not support diagnostics.`);
      results.push(await adapter.doctor());
    }
    return {
      ok: results.every((result) => result.ok),
      message: results.map((result) => result.message).join(" "),
    };
  }
}

export async function connect(options: ConnectOptions): Promise<ShqlDatabase> {
  const schema =
    typeof options.schema === "string"
      ? await loadSchema(options.schema, options.env ?? process.env)
      : options.schema;
  if (options.adapter) return new ShqlDatabase(schema, options.adapter, options.governance, options.context);
  const adapters = new Map<string, TableAdapter>();
  for (const connection of schema.connections.values()) {
    const configured = options.connections?.[connection.name];
    if (configured?.adapter) {
      adapters.set(connection.name, configured.adapter);
      continue;
    }
    if (connection.provider === "json") {
      adapters.set(connection.name, new JsonAdapter(connection.source));
      continue;
    }
    if (connection.provider === "csv") {
      adapters.set(connection.name, new CsvAdapter(connection.source));
      continue;
    }
    if (connection.provider === "excel") {
      adapters.set(connection.name, new XlsxAdapter(connection.source));
      continue;
    }
    if (connection.provider === "memory") {
      adapters.set(connection.name, new MemoryAdapter());
      continue;
    }
    if (connection.provider === "http") {
      adapters.set(
        connection.name,
        new HttpAdapter(connection.source, configured?.fetch ?? options.fetch, configured?.headers),
      );
      continue;
    }
    invariant(
      connection.provider === "google-sheets",
      "ADAPTER_ERROR",
      `Connection ${connection.name} (${connection.provider}) requires a configured adapter.`,
    );
    const auth = configured?.auth ?? options.auth;
    invariant(auth, "AUTH_ERROR", `Google Sheets authentication is required for ${connection.name}.`);
    adapters.set(
      connection.name,
      new GoogleSheetsAdapter(connection.source, auth, configured?.fetch ?? options.fetch),
    );
  }
  return new ShqlDatabase(schema, adapters, options.governance, options.context);
}
