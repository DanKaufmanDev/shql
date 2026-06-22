import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, parseSchema } from "../src/index.ts";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds an uncompressed (method 0) ZIP. The adapter's reader ignores CRCs and
// supports stored entries, so this is enough to exercise the read path with
// workbooks shaped like the ones Excel itself produces.
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function workbookFiles(sheet: string, workbookProperties = ""): Record<string, string> {
  return {
    "[Content_Types].xml":
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels":
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml":
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `${workbookProperties}<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet,
  };
}

test("excel adapter round-trips typed reads, writes and multiple sheets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-xlsx-"));
  const workbook = join(directory, "company.xlsx");
  const schema = parseSchema(`
    CONNECTION book FROM EXCEL "${workbook}"
    TABLE people FROM book.#People {
      _shql_id: id
      _shql_version: number
      name: text
      score: number
      active: boolean
      joined: date
    }
    TABLE notes FROM book.#Notes {
      _shql_id: id
      _shql_version: number
      body: text
    }
  `);
  const db = await connect({ schema });
  await db.initialize();

  const inserted = await db.query(
    `INSERT INTO people { name: "Ada", score: 90, active: TRUE, joined: DATE("2024-01-05") } RETURNING *`,
  );
  assert.equal(inserted.rows[0]._shql_version, 1);
  await db.query(`INSERT INTO notes { body: "hello" }`);

  const rows = (await db.query(`FROM people WHERE active = TRUE SELECT name, score, joined`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ada");
  assert.equal(rows[0].score, 90);
  assert.ok(rows[0].joined instanceof Date);
  assert.equal((rows[0].joined as Date).toISOString().slice(0, 10), "2024-01-05");

  const id = inserted.rows[0]._shql_id as string;
  await db.query(`FROM people WHERE _shql_id = $id UPDATE { score: 95 }`, { id });
  assert.equal((await db.query(`FROM people SELECT score`)).rows[0].score, 95);

  // The second worksheet is untouched by writes to the first.
  assert.deepEqual((await db.query(`FROM notes SELECT body`)).rows, [{ body: "hello" }]);

  await db.query(`FROM people WHERE _shql_id = $id DELETE`, { id });
  assert.equal((await db.query(`FROM people SELECT *`)).rows.length, 0);
  assert.equal((await db.query(`FROM notes SELECT *`)).rows.length, 1);
});

test("excel adapter reads shared strings and serial dates from external workbooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-xlsx-ext-"));
  const workbook = join(directory, "external.xlsx");
  const sheet =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>_shql_id</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c><c r="C1" t="inlineStr"><is><t>joined</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>p1</t></is></c><c r="B2" t="s"><v>0</v></c><c r="C2"><v>45000</v></c></row>` +
    `</sheetData></worksheet>`;
  await writeFile(
    workbook,
    storedZip({
      "[Content_Types].xml":
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      "_rels/.rels":
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml":
        `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels":
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Grace</t></si></sst>`,
      "xl/worksheets/sheet1.xml": sheet,
    }),
  );

  const schema = parseSchema(`
    CONNECTION book FROM XLSX "${workbook}"
    TABLE data FROM book.#Data {
      _shql_id: id
      name: text
      joined: date
    }
  `);
  const db = await connect({ schema });
  const rows = (await db.query(`FROM data SELECT name, joined`)).rows;
  assert.equal(rows[0].name, "Grace");
  assert.ok(rows[0].joined instanceof Date);
  assert.equal((rows[0].joined as Date).getUTCFullYear(), 2023);
});

test("excel adapter honors the 1904 workbook date system", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-xlsx-1904-"));
  const workbook = join(directory, "mac.xlsx");
  const sheet =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>_shql_id</t></is></c><c r="B1" t="inlineStr"><is><t>joined</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>p1</t></is></c><c r="B2"><v>1</v></c></row>` +
    `</sheetData></worksheet>`;
  await writeFile(workbook, storedZip(workbookFiles(sheet, `<workbookPr date1904="1"/>`)));
  const schema = parseSchema(`
    CONNECTION book FROM EXCEL "${workbook}"
    TABLE data FROM book.#Data {
      _shql_id: id
      joined: date
    }
  `);
  const rows = (await (await connect({ schema })).query(`FROM data SELECT joined`)).rows;
  assert.equal((rows[0].joined as Date).toISOString().slice(0, 10), "1904-01-02");
});

test("excel adapter rejects unsafe ZIP containers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-xlsx-unsafe-"));
  const sheet =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>_shql_id</t></is></c></row></sheetData></worksheet>`;
  const valid = storedZip(workbookFiles(sheet));
  const central = valid.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);

  const cases: Array<{ name: string; mutate(buffer: Buffer): void; message: RegExp }> = [
    {
      name: "unsupported.xlsx",
      mutate: (buffer) => buffer.writeUInt16LE(99, central + 10),
      message: /compression method 99/,
    },
    {
      name: "oversized.xlsx",
      mutate: (buffer) => buffer.writeUInt32LE(64 * 1024 * 1024 + 1, central + 24),
      message: /exceeds the .* limit/,
    },
    {
      name: "crc.xlsx",
      mutate: (buffer) => buffer.writeUInt32LE(123, central + 16),
      message: /CRC mismatch/,
    },
  ];
  for (const entry of cases) {
    const workbook = join(directory, entry.name);
    const corrupted = Buffer.from(valid);
    entry.mutate(corrupted);
    await writeFile(workbook, corrupted);
    const schema = parseSchema(`
      CONNECTION book FROM EXCEL "${workbook}"
      TABLE data FROM book.#Data { _shql_id: id }
    `);
    await assert.rejects((await connect({ schema })).query(`FROM data SELECT *`), entry.message);
  }
});

test("excel adapter refuses destructive rewrites unless explicitly enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-xlsx-destructive-"));
  const workbook = join(directory, "formula.xlsx");
  const sheet =
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>_shql_id</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>p1</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row>` +
    `</sheetData></worksheet>`;
  await writeFile(workbook, storedZip(workbookFiles(sheet)));
  const schema = parseSchema(`
    CONNECTION book FROM EXCEL "${workbook}"
    TABLE data FROM book.#Data {
      _shql_id: id
      value: number
    }
  `);
  const safe = await connect({ schema });
  await assert.rejects(
    safe.query(`FROM data WHERE _shql_id = "p1" UPDATE { value: 3 }`),
    /Refusing to rewrite.*formulas/,
  );

  const destructive = await connect({
    schema,
    connections: { book: { allowDestructiveXlsxWrites: true } },
  });
  await destructive.query(`FROM data WHERE _shql_id = "p1" UPDATE { value: 3 }`);
  assert.deepEqual((await destructive.query(`FROM data SELECT value`)).rows, [{ value: 3 }]);
});
