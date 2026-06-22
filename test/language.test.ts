import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAdapter, connect, parseSchema } from "../src/index.ts";

function itemsDb() {
  const schema = parseSchema(`
    SHEET test
    TABLE items FROM #items {
      _shql_id: id
      _shql_version: number
      name: text
      category: text
      price: number
      tag: text?
    }
  `);
  const rows = [
    { _shql_id: "i1", _shql_version: 1, name: "apple", category: "fruit", price: 3, tag: "x" },
    { _shql_id: "i2", _shql_version: 1, name: "banana", category: "fruit", price: 2, tag: "y" },
    { _shql_id: "i3", _shql_version: 1, name: "carrot", category: "veg", price: 1, tag: null },
    { _shql_id: "i4", _shql_version: 1, name: "donut", category: "snack", price: 5, tag: null },
    { _shql_id: "i5", _shql_version: 1, name: "eclair", category: "snack", price: 4, tag: null },
  ];
  return connect({ schema, adapter: new MemoryAdapter({ items: rows }) });
}

test("IN and NOT IN filter by membership", async () => {
  const db = await itemsDb();
  assert.deepEqual(
    (await db.query(`FROM items WHERE category IN ("fruit", "veg") SELECT name SORT name ASC`)).rows,
    [{ name: "apple" }, { name: "banana" }, { name: "carrot" }],
  );
  assert.deepEqual(
    (await db.query(`FROM items WHERE category NOT IN ("snack") SELECT _shql_id SORT _shql_id ASC`)).rows,
    [{ _shql_id: "i1" }, { _shql_id: "i2" }, { _shql_id: "i3" }],
  );
  // An empty membership list matches nothing.
  assert.equal((await db.query(`FROM items WHERE category IN () SELECT _shql_id`)).rows.length, 0);
});

test("DISTINCT removes duplicate projected rows", async () => {
  const db = await itemsDb();
  assert.deepEqual((await db.query(`FROM items SELECT DISTINCT category SORT category ASC`)).rows, [
    { category: "fruit" },
    { category: "snack" },
    { category: "veg" },
  ]);
});

test("SKIP and TAKE paginate after SORT", async () => {
  const db = await itemsDb();
  assert.deepEqual((await db.query(`FROM items SELECT name, price SORT price DESC TAKE 2 SKIP 1`)).rows, [
    { name: "eclair", price: 4 },
    { name: "apple", price: 3 },
  ]);
  // OFFSET is an alias for SKIP.
  assert.deepEqual((await db.query(`FROM items SELECT name, price SORT price DESC TAKE 1 OFFSET 0`)).rows, [
    { name: "donut", price: 5 },
  ]);
});

test("HAVING filters aggregated groups", async () => {
  const db = await itemsDb();
  assert.deepEqual(
    (
      await db.query(
        `FROM items GROUP BY category SELECT category, COUNT(*) AS n HAVING COUNT(*) > 1 SORT category ASC`,
      )
    ).rows,
    [
      { category: "fruit", n: 2 },
      { category: "snack", n: 2 },
    ],
  );
  await assert.rejects(db.query(`FROM items SELECT name HAVING price > 1`), /HAVING requires/);
});

test("string concatenation and scalar functions", async () => {
  const db = await itemsDb();
  assert.equal(
    (await db.query(`FROM items WHERE _shql_id = "i1" SELECT name || ":" || category AS label`)).rows[0]
      .label,
    "apple:fruit",
  );
  assert.equal(
    (await db.query(`FROM items WHERE _shql_id = "i1" SELECT CONCAT(name, "-", price) AS label`)).rows[0]
      .label,
    "apple-3",
  );
  const row = (
    await db.query(
      `FROM items WHERE _shql_id = "i3" SELECT ROUND(price / 3, 2) AS r, ABS(0 - price) AS a, REPLACE(name, "r", "R") AS n, TRIM("  hi  ") AS t`,
    )
  ).rows[0];
  assert.equal(row.r, 0.33);
  assert.equal(row.a, 1);
  assert.equal(row.n, "caRRot");
  assert.equal(row.t, "hi");
});

test("IS NULL composes with boolean operators", async () => {
  const db = await itemsDb();
  assert.deepEqual(
    (await db.query(`FROM items WHERE tag IS NULL AND category = "snack" SELECT _shql_id SORT _shql_id ASC`))
      .rows,
    [{ _shql_id: "i4" }, { _shql_id: "i5" }],
  );
  assert.deepEqual(
    (await db.query(`FROM items WHERE tag IS NOT NULL SELECT _shql_id SORT _shql_id ASC`)).rows,
    [{ _shql_id: "i1" }, { _shql_id: "i2" }],
  );
});
