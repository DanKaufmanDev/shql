import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { invariant } from "../errors.ts";
import type { DoctorResult, Row, StoredRow, TableAdapter, TableInspection, TableSchema } from "../types.ts";

type JsonStore = Row[] | Record<string, Row[]>;

export class JsonAdapter implements TableAdapter {
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  private file(table: TableSchema): string {
    return extname(this.source).toLowerCase() === ".json"
      ? resolve(this.source)
      : resolve(this.source, `${table.tabId}.json`);
  }

  private async store(table: TableSchema): Promise<JsonStore> {
    try {
      const parsed = JSON.parse(await readFile(this.file(table), "utf8")) as JsonStore;
      invariant(
        Array.isArray(parsed) || (parsed && typeof parsed === "object"),
        "ADAPTER_ERROR",
        "JSON source must contain an array or table object.",
      );
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private rows(store: JsonStore, table: TableSchema): Row[] {
    const rows = Array.isArray(store) ? store : (store[table.tabId] ?? store[table.name] ?? []);
    const types = new Map(table.columns.map((column) => [column.name, column.type]));
    return rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([name, value]) => {
            const type = types.get(name);
            if ((type === "date" || type === "datetime") && value !== null && !(value instanceof Date))
              return [name, new Date(String(value))];
            return [name, value];
          }),
        ) as Row,
    );
  }

  private async save(table: TableSchema, rows: Row[]): Promise<void> {
    const file = this.file(table);
    await mkdir(dirname(file), { recursive: true });
    const existing = await this.store(table);
    const output: JsonStore = Array.isArray(existing) ? rows : { ...existing, [table.tabId]: rows };
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }

  async read(table: TableSchema): Promise<StoredRow[]> {
    return this.rows(await this.store(table), table).map((values, index) => ({
      rowNumber: index + 1,
      values: { ...values },
    }));
  }

  async append(table: TableSchema, rows: Row[]): Promise<StoredRow[]> {
    const current = this.rows(await this.store(table), table);
    const appended = rows.map((values, index) => ({
      rowNumber: current.length + index + 1,
      values: { ...values },
    }));
    await this.save(table, [...current, ...rows]);
    return appended;
  }

  async update(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const current = this.rows(await this.store(table), table);
    for (const row of rows) {
      invariant(current[row.rowNumber - 1], "CONFLICT", `JSON row ${row.rowNumber} no longer exists.`);
      if (row.expectedVersion !== undefined)
        invariant(
          current[row.rowNumber - 1]._shql_version === row.expectedVersion,
          "CONFLICT",
          `JSON row ${row.rowNumber} changed.`,
        );
      current[row.rowNumber - 1] = { ...row.values };
    }
    await this.save(table, current);
  }

  async delete(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const deleted = new Set(rows.map((row) => row.rowNumber));
    const current = this.rows(await this.store(table), table);
    await this.save(
      table,
      current.filter((_row, index) => !deleted.has(index + 1)),
    );
  }

  async inspect(table: TableSchema): Promise<TableInspection> {
    const rows = this.rows(await this.store(table), table);
    const expected = table.columns.map((column) => column.name);
    // JSON records are key-value, so report expected order when the actual keys
    // are a permutation of the schema, and the literal keys when they drift.
    const actual = rows.length ? Object.keys(rows[0]) : expected;
    const headers =
      actual.length === expected.length && expected.every((name) => actual.includes(name))
        ? expected
        : actual;
    return {
      table: table.name,
      tabId: table.tabId,
      title: this.file(table),
      headers,
      rowCount: rows.length,
      inferredColumns: table.columns,
    };
  }

  async initialize(table: TableSchema): Promise<void> {
    const file = this.file(table);
    await mkdir(dirname(file), { recursive: true });
    try {
      await access(file);
    } catch {
      await writeFile(file, "[]\n", "utf8");
    }
  }

  async doctor(): Promise<DoctorResult> {
    return { ok: true, message: `JSON connection is configured at ${dirname(resolve(this.source))}.` };
  }
}
