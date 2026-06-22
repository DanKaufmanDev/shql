import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { invariant } from "../errors.ts";
import type {
  DoctorResult,
  Row,
  Scalar,
  StoredRow,
  TableAdapter,
  TableInspection,
  TableSchema,
} from "../types.ts";

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function encodeCell(value: Scalar): string {
  const text = value === null ? "" : value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function decodeCell(value: string | undefined, type: TableSchema["columns"][number]["type"]): Scalar {
  if (value === undefined || value === "") return null;
  if (type === "number") return Number(value);
  if (type === "boolean") return value.toLowerCase() === "true";
  if (type === "date" || type === "datetime") return new Date(value);
  return value;
}

export class CsvAdapter implements TableAdapter {
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  private file(table: TableSchema): string {
    return extname(this.source).toLowerCase() === ".csv"
      ? resolve(this.source)
      : resolve(this.source, `${table.tabId}.csv`);
  }

  private async rows(table: TableSchema): Promise<Row[]> {
    try {
      const parsed = parseCsv(await readFile(this.file(table), "utf8"));
      const headers = parsed.shift() ?? [];
      const types = new Map(table.columns.map((column) => [column.name, column.type]));
      return parsed
        .filter((cells) => cells.some(Boolean))
        .map(
          (cells) =>
            Object.fromEntries(
              headers.map((header, index) => [header, decodeCell(cells[index], types.get(header) ?? "text")]),
            ) as Row,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async save(table: TableSchema, rows: Row[]): Promise<void> {
    const headers = table.columns.map((column) => column.name);
    const output =
      [
        headers.join(","),
        ...rows.map((row) => headers.map((header) => encodeCell(row[header])).join(",")),
      ].join("\n") + "\n";
    const file = this.file(table);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, output, "utf8");
    await rename(temporary, file);
  }

  async read(table: TableSchema): Promise<StoredRow[]> {
    return (await this.rows(table)).map((values, index) => ({ rowNumber: index + 2, values }));
  }
  async append(table: TableSchema, rows: Row[]): Promise<StoredRow[]> {
    const current = await this.rows(table);
    await this.save(table, [...current, ...rows]);
    return rows.map((values, index) => ({ rowNumber: current.length + index + 2, values: { ...values } }));
  }
  async update(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const current = await this.rows(table);
    for (const row of rows) {
      const index = row.rowNumber - 2;
      invariant(current[index], "CONFLICT", `CSV row ${row.rowNumber} no longer exists.`);
      if (row.expectedVersion !== undefined)
        invariant(
          current[index]._shql_version === row.expectedVersion,
          "CONFLICT",
          `CSV row ${row.rowNumber} changed.`,
        );
      current[index] = { ...row.values };
    }
    await this.save(table, current);
  }
  async delete(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const deleted = new Set(rows.map((row) => row.rowNumber));
    await this.save(
      table,
      (await this.rows(table)).filter((_row, index) => !deleted.has(index + 2)),
    );
  }
  async inspect(table: TableSchema): Promise<TableInspection> {
    const rows = await this.rows(table);
    return {
      table: table.name,
      tabId: table.tabId,
      title: this.file(table),
      headers: table.columns.map((column) => column.name),
      rowCount: rows.length,
      inferredColumns: table.columns,
    };
  }
  async initialize(table: TableSchema): Promise<void> {
    try {
      await access(this.file(table));
    } catch {
      await this.save(table, []);
    }
  }
  async doctor(): Promise<DoctorResult> {
    return { ok: true, message: `CSV connection is configured at ${this.source}.` };
  }
}
