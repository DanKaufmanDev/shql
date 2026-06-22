import { ShqlError, invariant } from "../errors.ts";
import type { DoctorResult, Row, StoredRow, TableAdapter, TableInspection, TableSchema } from "../types.ts";

export class HttpAdapter implements TableAdapter {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;
  constructor(baseUrl: string, fetcher = globalThis.fetch, headers: Record<string, string> = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetcher = fetcher;
    this.headers = headers;
  }
  private url(table: TableSchema, suffix = ""): string {
    return `${this.baseUrl}/${encodeURIComponent(table.tabId)}${suffix}`;
  }
  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetcher(url, {
      ...init,
      headers: { "content-type": "application/json", ...this.headers, ...init.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new ShqlError("ADAPTER_ERROR", `HTTP connector returned ${response.status}.`, { body });
    return body;
  }
  async read(table: TableSchema): Promise<StoredRow[]> {
    const body = (await this.request(this.url(table))) as Row[] | { rows?: Row[] };
    const rows = Array.isArray(body) ? body : (body.rows ?? []);
    return rows.map((values, index) => ({ rowNumber: index + 1, values }));
  }
  async append(table: TableSchema, rows: Row[]): Promise<StoredRow[]> {
    const body = (await this.request(this.url(table), {
      method: "POST",
      body: JSON.stringify({ rows }),
    })) as { rows?: Row[] };
    return (body.rows ?? rows).map((values, index) => ({ rowNumber: index + 1, values }));
  }
  async update(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const id = table.columns.find((column) => column.type === "id")?.name;
    invariant(id, "SCHEMA_ERROR", `HTTP table ${table.name} requires an id column.`);
    for (const row of rows)
      await this.request(this.url(table, `/${encodeURIComponent(String(row.values[id]))}`), {
        method: "PATCH",
        body: JSON.stringify({ values: row.values, expectedVersion: row.expectedVersion }),
      });
  }
  async delete(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const id = table.columns.find((column) => column.type === "id")?.name;
    invariant(id, "SCHEMA_ERROR", `HTTP table ${table.name} requires an id column.`);
    for (const row of rows)
      await this.request(this.url(table, `/${encodeURIComponent(String(row.values[id]))}`), {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: row.expectedVersion }),
      });
  }
  async inspect(table: TableSchema): Promise<TableInspection> {
    const rows = await this.read(table);
    return {
      table: table.name,
      tabId: table.tabId,
      title: this.url(table),
      headers: table.columns.map((column) => column.name),
      rowCount: rows.length,
      inferredColumns: table.columns,
    };
  }
  async initialize(): Promise<void> {}
  async doctor(): Promise<DoctorResult> {
    await this.request(`${this.baseUrl}/health`);
    return { ok: true, message: `HTTP connection ${this.baseUrl} is reachable.` };
  }
}
