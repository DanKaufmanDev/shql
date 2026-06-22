import { invariant } from "../errors.ts";
import type { DoctorResult, Row, StoredRow, TableAdapter, TableInspection, TableSchema } from "../types.ts";

export class MemoryAdapter implements TableAdapter {
  private readonly data = new Map<string, StoredRow[]>();

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.data.set(
        table,
        rows.map((values, index) => ({ rowNumber: index + 2, values: { ...values } })),
      );
    }
  }

  async read(table: TableSchema): Promise<StoredRow[]> {
    return (this.data.get(table.name) ?? []).map((row) => ({
      rowNumber: row.rowNumber,
      values: { ...row.values },
    }));
  }

  async append(table: TableSchema, rows: Row[]): Promise<StoredRow[]> {
    const current = this.data.get(table.name) ?? [];
    const firstRow = current.reduce((max, row) => Math.max(max, row.rowNumber), 1) + 1;
    const appended = rows.map((values, index) => ({ rowNumber: firstRow + index, values: { ...values } }));
    current.push(...appended);
    this.data.set(table.name, current);
    return appended.map((row) => ({ rowNumber: row.rowNumber, values: { ...row.values } }));
  }

  async update(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const current = this.data.get(table.name) ?? [];
    for (const update of rows) {
      const index = current.findIndex((row) => row.rowNumber === update.rowNumber);
      invariant(index >= 0, "CONFLICT", `Row ${update.rowNumber} no longer exists in ${table.name}.`);
      if (update.expectedVersion !== undefined) {
        invariant(
          current[index].values._shql_version === update.expectedVersion,
          "CONFLICT",
          `Row ${update.rowNumber} in ${table.name} changed after it was read.`,
        );
      }
      current[index] = { rowNumber: update.rowNumber, values: { ...update.values } };
    }
  }

  async delete(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const current = this.data.get(table.name) ?? [];
    for (const target of rows) {
      if (target.expectedVersion === undefined) continue;
      const existing = current.find((row) => row.rowNumber === target.rowNumber);
      invariant(
        existing?.values._shql_version === target.expectedVersion,
        "CONFLICT",
        `Row ${target.rowNumber} in ${table.name} changed after it was read.`,
      );
    }
    const deleted = new Set(rows.map((row) => row.rowNumber));
    const remaining = current.filter((row) => !deleted.has(row.rowNumber));
    remaining.forEach((row, index) => {
      row.rowNumber = index + 2;
    });
    this.data.set(table.name, remaining);
  }

  snapshot(table: string): Row[] {
    return (this.data.get(table) ?? []).map((row) => ({ ...row.values }));
  }

  async inspect(table: TableSchema): Promise<TableInspection> {
    const rows = this.data.get(table.name) ?? [];
    const headers = table.columns.length
      ? table.columns.map((column) => column.name)
      : Object.keys(rows[0]?.values ?? {});
    return {
      table: table.name,
      tabId: table.tabId,
      title: table.name,
      headers,
      rowCount: rows.length,
      inferredColumns: table.columns,
    };
  }

  async initialize(table: TableSchema): Promise<void> {
    if (!this.data.has(table.name)) this.data.set(table.name, []);
  }

  async doctor(): Promise<DoctorResult> {
    return { ok: true, message: "In-memory adapter is ready." };
  }
}
