import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { invariant } from "../errors.ts";
import type {
  ColumnType,
  DoctorResult,
  Row,
  Scalar,
  StoredRow,
  TableAdapter,
  TableInspection,
  TableSchema,
} from "../types.ts";

// ---------------------------------------------------------------------------
// ZIP container (.xlsx is an OOXML package: a ZIP of XML parts). Node's zlib
// provides the DEFLATE codec, so no third-party dependency is required.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++)
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  invariant(eocd >= 0, "ADAPTER_ERROR", "Invalid .xlsx file: missing ZIP end-of-central-directory record.");
  const count = buffer.readUInt16LE(eocd + 10);
  invariant(count !== 0xffff, "ADAPTER_ERROR", "ZIP64 .xlsx files are not supported.");
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    invariant(
      buffer.readUInt32LE(offset) === 0x02014b50,
      "ADAPTER_ERROR",
      "Invalid .xlsx file: corrupt ZIP central directory.",
    );
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zip(entries: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuffer.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(0, 32);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

// ---------------------------------------------------------------------------
// OOXML helpers
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll("&amp;", "&");
}

function columnIndex(reference: string): number {
  const letters = reference.replace(/[^A-Z]/g, "");
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function columnLetter(index: number): string {
  let letters = "";
  let remaining = index + 1;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

// Excel stores dates as a serial number of days since 1899-12-30 (the epoch is
// shifted to absorb Excel's fictional 1900 leap day).
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function excelSerialToDate(serial: number): Date {
  return new Date(EXCEL_EPOCH + Math.round(serial * 86400000));
}

function extractText(fragment: string): string {
  return [...fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => unescapeXml(match[1])).join("");
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => extractText(match[1]));
}

function parseSheet(xml: string, sharedStrings: string[]): Scalar[][] {
  const grid: Scalar[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells: Scalar[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1];
      const inner = cellMatch[2] ?? "";
      const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
      const at = reference ? columnIndex(reference) : cells.length;
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      let value: Scalar = null;
      if (type === "inlineStr") value = extractText(inner);
      else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw !== undefined) {
          if (type === "s") value = sharedStrings[Number(raw)] ?? null;
          else if (type === "str") value = unescapeXml(raw);
          else if (type === "b") value = raw === "1";
          else if (type === "e") value = null;
          else value = Number(raw);
        }
      }
      cells[at] = value;
    }
    for (let index = 0; index < cells.length; index++) if (cells[index] === undefined) cells[index] = null;
    grid.push(cells);
  }
  return grid;
}

function decodeCell(value: Scalar | undefined, type: ColumnType): Scalar {
  if (value === undefined || value === null || value === "") return null;
  if (type === "number") return typeof value === "number" ? value : Number(value);
  if (type === "boolean") return typeof value === "boolean" ? value : String(value).toLowerCase() === "true";
  if (type === "date" || type === "datetime")
    return typeof value === "number" ? excelSerialToDate(value) : new Date(String(value));
  return String(value);
}

function cellXml(reference: string, value: Scalar): string {
  if (value === null || value === "") return `<c r="${reference}"/>`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function buildSheetXml(headers: string[], rows: Row[]): string {
  const lines = [
    `<row r="1">${headers.map((header, index) => cellXml(`${columnLetter(index)}1`, header)).join("")}</row>`,
  ];
  rows.forEach((row, position) => {
    const reference = position + 2;
    const cells = headers.map((header, index) =>
      cellXml(`${columnLetter(index)}${reference}`, row[header] ?? null),
    );
    lines.push(`<row r="${reference}">${cells.join("")}</row>`);
  });
  const lastColumn = headers.length > 0 ? columnLetter(headers.length - 1) : "A";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${lastColumn}${rows.length + 1}"/><sheetData>${lines.join("")}</sheetData></worksheet>`
  );
}

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

function contentTypesXml(worksheetFiles: string[]): string {
  const overrides = worksheetFiles
    .map(
      (file) =>
        `<Override PartName="/xl/worksheets/${file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `${overrides}</Types>`
  );
}

interface Workbook {
  entries: Map<string, Buffer>;
  sheets: Map<string, string>;
  sharedStrings: string[];
}

function freshWorkbook(sheetName: string): Workbook {
  const entries = new Map<string, Buffer>();
  entries.set("[Content_Types].xml", Buffer.from(contentTypesXml(["sheet1.xml"]), "utf8"));
  entries.set("_rels/.rels", Buffer.from(ROOT_RELS, "utf8"));
  entries.set(
    "xl/workbook.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "utf8",
    ),
  );
  entries.set(
    "xl/_rels/workbook.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "utf8",
    ),
  );
  return { entries, sheets: new Map([[sheetName, "xl/worksheets/sheet1.xml"]]), sharedStrings: [] };
}

// Adds a worksheet to an existing package by splicing new entries into the
// workbook, relationship, and content-type parts, preserving everything else.
function addSheet(workbook: Workbook, sheetName: string): string {
  const existing = new Set([...workbook.sheets.values()].map((path) => path.split("/").pop()));
  let counter = 1;
  while (existing.has(`sheet${counter}.xml`)) counter++;
  const file = `sheet${counter}.xml`;
  const path = `xl/worksheets/${file}`;

  const relsKey = "xl/_rels/workbook.xml.rels";
  let rels = workbook.entries.get(relsKey)!.toString("utf8");
  const relationshipId = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
  rels = rels.replace(
    "</Relationships>",
    `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${file}"/></Relationships>`,
  );
  workbook.entries.set(relsKey, Buffer.from(rels, "utf8"));

  let workbookXml = workbook.entries.get("xl/workbook.xml")!.toString("utf8");
  const sheetId = Math.max(0, ...[...workbookXml.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  workbookXml = workbookXml.replace(
    "</sheets>",
    `<sheet name="${escapeXml(sheetName)}" sheetId="${sheetId}" r:id="${relationshipId}"/></sheets>`,
  );
  workbook.entries.set("xl/workbook.xml", Buffer.from(workbookXml, "utf8"));

  let contentTypes = workbook.entries.get("[Content_Types].xml")!.toString("utf8");
  contentTypes = contentTypes.replace(
    "</Types>",
    `<Override PartName="/xl/worksheets/${file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  workbook.entries.set("[Content_Types].xml", Buffer.from(contentTypes, "utf8"));

  workbook.sheets.set(sheetName, path);
  return path;
}

/**
 * Reads and writes a single `.xlsx` workbook. Each typed SHQL table maps to one
 * worksheet identified by name (the schema `tabId`), mirroring the spreadsheet
 * model used by the Google Sheets adapter.
 *
 * Mutations rewrite the target worksheet using inline strings and ISO-8601
 * dates; other worksheets, styles, and shared strings are preserved verbatim.
 * Cell formatting, formulas, and charts on the rewritten sheet are not retained.
 */
export class XlsxAdapter implements TableAdapter {
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  private async load(): Promise<Workbook | null> {
    let buffer: Buffer;
    try {
      buffer = await readFile(this.source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const entries = unzip(buffer);
    const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8") ?? "";
    const relsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
    const relationships = new Map<string, string>();
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
      if (id && target) relationships.set(id, target);
    }
    const sheets = new Map<string, string>();
    for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/>/g)) {
      const name = /\bname="([^"]+)"/.exec(match[0])?.[1];
      const relationshipId = /\br:id="([^"]+)"/.exec(match[0])?.[1];
      const target = relationshipId ? relationships.get(relationshipId) : undefined;
      if (name && target)
        sheets.set(unescapeXml(name), target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
    return {
      entries,
      sheets,
      sharedStrings: parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8")),
    };
  }

  private grid(workbook: Workbook | null, table: TableSchema): Scalar[][] {
    if (!workbook) return [];
    const path = workbook.sheets.get(table.tabId);
    if (!path) return [];
    return parseSheet(workbook.entries.get(path)!.toString("utf8"), workbook.sharedStrings);
  }

  private async rows(table: TableSchema): Promise<Row[]> {
    const grid = this.grid(await this.load(), table);
    const headers = (grid[0] ?? []).map((cell) => (cell === null ? "" : String(cell)));
    const types = new Map(table.columns.map((column) => [column.name, column.type]));
    return grid
      .slice(1)
      .filter((cells) => cells.some((cell) => cell !== null && cell !== ""))
      .map(
        (cells) =>
          Object.fromEntries(
            headers.map((header, index) => [header, decodeCell(cells[index], types.get(header) ?? "text")]),
          ) as Row,
      );
  }

  private async save(table: TableSchema, rows: Row[]): Promise<void> {
    const headers = table.columns.map((column) => column.name);
    const workbook = (await this.load()) ?? freshWorkbook(table.tabId);
    const path = workbook.sheets.get(table.tabId) ?? addSheet(workbook, table.tabId);
    workbook.entries.set(path, Buffer.from(buildSheetXml(headers, rows), "utf8"));
    const file = resolve(this.source);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, zip(workbook.entries));
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
      invariant(current[index], "CONFLICT", `Excel row ${row.rowNumber} no longer exists.`);
      if (row.expectedVersion !== undefined)
        invariant(
          current[index]._shql_version === row.expectedVersion,
          "CONFLICT",
          `Excel row ${row.rowNumber} changed.`,
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
    const grid = this.grid(await this.load(), table);
    return {
      table: table.name,
      tabId: table.tabId,
      title: resolve(this.source),
      headers: grid.length
        ? grid[0].map((cell) => (cell === null ? "" : String(cell)))
        : table.columns.map((column) => column.name),
      rowCount: grid.slice(1).filter((cells) => cells.some((cell) => cell !== null && cell !== "")).length,
      inferredColumns: table.columns,
    };
  }

  async initialize(table: TableSchema): Promise<void> {
    const workbook = await this.load();
    if (workbook?.sheets.has(table.tabId)) return;
    await this.save(table, []);
  }

  async doctor(): Promise<DoctorResult> {
    return { ok: true, message: `Excel workbook is configured at ${resolve(this.source)}.` };
  }
}
