import { invariant } from "../errors.ts";
import type { DoctorResult, Row, StoredRow, TableAdapter, TableInspection, TableSchema } from "../types.ts";

export interface SqlResult<T extends Row = Row> {
  rows: T[];
  rowCount?: number;
}
export interface SqlClient {
  query<T extends Row = Row>(sql: string, parameters?: unknown[]): Promise<SqlResult<T>>;
}
export type SqlDialect = "postgres" | "mysql" | "sqlite";

function identifier(value: string, dialect: SqlDialect): string {
  invariant(/^[A-Za-z_][A-Za-z0-9_.]*$/.test(value), "SCHEMA_ERROR", `Unsafe SQL identifier ${value}.`);
  const quote = dialect === "mysql" ? "`" : '"';
  return value
    .split(".")
    .map((part) => `${quote}${part}${quote}`)
    .join(".");
}

export class SqlAdapter implements TableAdapter {
  private readonly client: SqlClient;
  private readonly dialect: SqlDialect;
  constructor(client: SqlClient, dialect: SqlDialect = "postgres") {
    this.client = client;
    this.dialect = dialect;
  }
  private marker(index: number): string {
    return this.dialect === "postgres" ? `$${index}` : "?";
  }
  async read(table: TableSchema): Promise<StoredRow[]> {
    const result = await this.client.query(`SELECT * FROM ${identifier(table.tabId, this.dialect)}`);
    return result.rows.map((values, index) => ({ rowNumber: index + 1, values }));
  }
  async append(table: TableSchema, rows: Row[]): Promise<StoredRow[]> {
    const columns = table.columns.map((column) => column.name);
    const stored: StoredRow[] = [];
    for (const values of rows) {
      const sql = `INSERT INTO ${identifier(table.tabId, this.dialect)} (${columns.map((column) => identifier(column, this.dialect)).join(", ")}) VALUES (${columns.map((_column, index) => this.marker(index + 1)).join(", ")})${this.dialect === "postgres" ? " RETURNING *" : ""}`;
      const result = await this.client.query(
        sql,
        columns.map((column) => values[column]),
      );
      stored.push({ rowNumber: stored.length + 1, values: result.rows[0] ?? values });
    }
    return stored;
  }
  async update(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const id = table.columns.find((column) => column.type === "id")?.name;
    invariant(id, "SCHEMA_ERROR", `SQL table ${table.name} requires an id column.`);
    const columns = table.columns.filter((column) => column.name !== id);
    for (const row of rows) {
      const parameters = columns.map((column) => row.values[column.name]);
      parameters.push(row.values[id]);
      let where = `${identifier(id, this.dialect)} = ${this.marker(parameters.length)}`;
      if (row.expectedVersion !== undefined) {
        parameters.push(row.expectedVersion);
        where += ` AND ${identifier("_shql_version", this.dialect)} = ${this.marker(parameters.length)}`;
      }
      const result = await this.client.query(
        `UPDATE ${identifier(table.tabId, this.dialect)} SET ${columns.map((column, index) => `${identifier(column.name, this.dialect)} = ${this.marker(index + 1)}`).join(", ")} WHERE ${where}`,
        parameters,
      );
      invariant(
        result.rowCount !== 0,
        "CONFLICT",
        `SQL row ${String(row.values[id])} changed or disappeared.`,
      );
    }
  }
  async delete(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const id = table.columns.find((column) => column.type === "id")?.name;
    invariant(id, "SCHEMA_ERROR", `SQL table ${table.name} requires an id column.`);
    for (const row of rows) {
      const result = await this.client.query(
        `DELETE FROM ${identifier(table.tabId, this.dialect)} WHERE ${identifier(id, this.dialect)} = ${this.marker(1)}`,
        [row.values[id]],
      );
      invariant(result.rowCount !== 0, "CONFLICT", `SQL row ${String(row.values[id])} disappeared.`);
    }
  }
  async inspect(table: TableSchema): Promise<TableInspection> {
    const rows = await this.read(table);
    return {
      table: table.name,
      tabId: table.tabId,
      title: table.tabId,
      headers: table.columns.map((column) => column.name),
      rowCount: rows.length,
      inferredColumns: table.columns,
    };
  }
  async initialize(table: TableSchema): Promise<void> {
    const types = {
      id: "TEXT",
      text: "TEXT",
      number: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      date: "DATE",
      datetime: "TIMESTAMP",
    } as const;
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${identifier(table.tabId, this.dialect)} (${table.columns.map((column) => `${identifier(column.name, this.dialect)} ${types[column.type]}${column.nullable ? "" : " NOT NULL"}${column.type === "id" ? " PRIMARY KEY" : ""}`).join(", ")})`,
    );
  }
  async doctor(): Promise<DoctorResult> {
    await this.client.query("SELECT 1");
    return { ok: true, message: `${this.dialect} connection is ready.` };
  }
}
