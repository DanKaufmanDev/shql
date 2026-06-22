import assert from "node:assert/strict";
import test from "node:test";
import {
  connect,
  GoogleSheetsAdapter,
  MemoryAdapter,
  parseQuery,
  parseSchema,
  ShqlError,
} from "../src/index.ts";

const schemaSource = `
SHEET \${GOOGLE_SHEETS_ID}

TABLE customers FROM #{CUSTOMERS_TAB_ID} {
  _shql_id: id
  name: text
  email: text
  status: text
  score: number?
  created_at: datetime
}
`;

const env = { GOOGLE_SHEETS_ID: "spreadsheet-1", CUSTOMERS_TAB_ID: "123" };

function setup() {
  const schema = parseSchema(schemaSource, env);
  const adapter = new MemoryAdapter({
    customers: [
      {
        _shql_id: "a",
        name: "Ada",
        email: "ada@example.com",
        status: "active",
        score: 10,
        created_at: new Date("2026-01-01"),
      },
      {
        _shql_id: "b",
        name: "Lin",
        email: "lin@example.com",
        status: "inactive",
        score: 20,
        created_at: new Date("2026-02-01"),
      },
      {
        _shql_id: "c",
        name: "Sam",
        email: "sam@example.com",
        status: "active",
        score: null,
        created_at: new Date("2026-03-01"),
      },
    ],
  });
  return { schema, adapter };
}

test("parses spreadsheet and tab environment references", () => {
  const { schema } = setup();
  assert.equal(schema.spreadsheetId, "spreadsheet-1");
  assert.equal(schema.tables.get("customers")?.tabId, "123");
  assert.equal(schema.tables.get("customers")?.columns[4].nullable, true);
});

test("supports compact read-only table declarations", () => {
  const schema = parseSchema(
    `
    [\${GOOGLE_SHEETS_ID}]
    [#{CUSTOMERS_TAB_ID} AS customers]
  `,
    env,
  );
  assert.equal(schema.spreadsheetId, "spreadsheet-1");
  assert.equal(schema.tables.get("customers")?.tabId, "123");
  assert.deepEqual(schema.tables.get("customers")?.columns, []);
});

test("parses pipeline queries", () => {
  const query = parseQuery(`FROM customers WHERE status = $status SELECT name SORT name DESC TAKE 2;`);
  assert.equal(query.operation, "select");
  assert.equal(query.table, "customers");
});

test("filters, computes, projects, sorts and limits", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(
    `
    FROM customers
    LET label = UPPER(name)
    WHERE status = $status
    SELECT name, label
    SORT name DESC
    TAKE 1
  `,
    { status: "active" },
  );
  assert.deepEqual(result.rows, [{ name: "Sam", label: "SAM" }]);
});

test("groups and aggregates", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(`
    FROM customers
    GROUP BY status
    SELECT status, COUNT(*) AS count
    SORT status ASC
  `);
  assert.deepEqual(result.rows, [
    { status: "active", count: 2 },
    { status: "inactive", count: 1 },
  ]);
  await assert.rejects(db.query(`FROM customers SELECT name, COUNT(*) AS count`), /must appear in GROUP BY/);
});

test("inserts with generated ids and parameters", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(
    `
    INSERT INTO customers {
      name: $name,
      email: $email,
      status: "active",
      score: NULL,
      created_at: NOW()
    }
    RETURNING _shql_id, name
  `,
    { name: "Grace", email: "grace@example.com" },
  );
  assert.equal(result.affectedRows, 1);
  assert.equal(result.rows[0].name, "Grace");
  assert.equal(typeof result.rows[0]._shql_id, "string");
});

test("updates matching records and rejects id changes", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(`
    FROM customers
    WHERE _shql_id = "a"
    UPDATE { status: "inactive", score: 11 }
    RETURNING name, status, score
  `);
  assert.deepEqual(result.rows, [{ name: "Ada", status: "inactive", score: 11 }]);
  await assert.rejects(
    db.query(`FROM customers WHERE _shql_id = "a" UPDATE { _shql_id: "new" }`),
    (error: unknown) => error instanceof ShqlError && error.code === "VALIDATION_ERROR",
  );
});

test("deletes matching records and requires WHERE", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(`FROM customers WHERE status = "inactive" DELETE RETURNING _shql_id`);
  assert.deepEqual(result.rows, [{ _shql_id: "b" }]);
  assert.equal(adapter.snapshot("customers").length, 2);
  assert.throws(() => parseQuery(`FROM customers DELETE`), /requires a WHERE/);
});

test("rejects missing parameters and invalid columns", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  await assert.rejects(db.query(`FROM customers WHERE status = $status SELECT *`), /Missing query parameter/);
  await assert.rejects(db.query(`INSERT INTO customers { nope: "x" }`), /Unknown column/);
});

test("Google adapter resolves tab ids and reads compact tables", async () => {
  const responses = [
    { sheets: [{ properties: { sheetId: 123, title: "Customers" } }] },
    {
      values: [
        ["name", "status"],
        ["Ada", "active"],
        ["Lin", "inactive"],
      ],
    },
  ];
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const schema = parseSchema(`[spreadsheet-1]\n[#123 AS customers]`);
  const adapter = new GoogleSheetsAdapter(
    schema.spreadsheetId,
    { type: "access-token", accessToken: "token" },
    fetcher as typeof fetch,
  );
  const db = await connect({ schema, adapter });
  const result = await db.query(`FROM customers WHERE status = "active" SELECT name`);
  assert.deepEqual(result.rows, [{ name: "Ada" }]);
  assert.match(requests[0], /fields=sheets.properties/);
  assert.match(requests[1], /values/);
});

test("Google adapter verifies header order before appending", async () => {
  const { schema } = setup();
  const responses = [
    { sheets: [{ properties: { sheetId: 123, title: "Customers" } }] },
    { values: [["_shql_id", "name", "email", "status", "score", "created_at"]] },
    { updates: { updatedRange: "Customers!A2:F2" } },
  ];
  const fetcher = async () =>
    new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const adapter = new GoogleSheetsAdapter(
    schema.spreadsheetId,
    { type: "access-token", accessToken: "token" },
    fetcher as typeof fetch,
  );
  const db = await connect({ schema, adapter });
  const result = await db.query(`INSERT INTO customers {
    name: "Ada", email: "ada@example.com", status: "active", score: NULL, created_at: NOW()
  } RETURNING name`);
  assert.deepEqual(result.rows, [{ name: "Ada" }]);
  assert.equal(result.affectedRows, 1);
});

test("supports batch inserts", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(`INSERT INTO customers [
    { name: "Grace", email: "grace@example.com", status: "active", score: 30, created_at: NOW() },
    { name: "Edsger", email: "edsger@example.com", status: "active", score: 40, created_at: NOW() }
  ] RETURNING name`);
  assert.deepEqual(result.rows, [{ name: "Grace" }, { name: "Edsger" }]);
  assert.equal(result.affectedRows, 2);
});

test("upserts by a declared key", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const updated = await db.query(`UPSERT INTO customers KEY email VALUE {
    email: "ada@example.com", name: "Ada Lovelace", status: "active"
  } RETURNING _shql_id, name`);
  assert.deepEqual(updated.rows, [{ _shql_id: "a", name: "Ada Lovelace" }]);
  const inserted = await db.query(`UPSERT INTO customers KEY email VALUE {
    email: "new@example.com", name: "New", status: "active", score: NULL, created_at: NOW()
  } RETURNING name`);
  assert.deepEqual(inserted.rows, [{ name: "New" }]);
});

test("increments versions and detects stale adapter writes", async () => {
  const schema = parseSchema(`SHEET test
    TABLE customers FROM #1 {
      _shql_id: id
      _shql_version: number
      name: text
    }
  `);
  const adapter = new MemoryAdapter({ customers: [{ _shql_id: "a", _shql_version: 1, name: "Ada" }] });
  const db = await connect({ schema, adapter });
  const result = await db.query(
    `FROM customers WHERE _shql_id = "a" UPDATE { name: "Grace" } RETURNING _shql_version`,
  );
  assert.deepEqual(result.rows, [{ _shql_version: 2 }]);
  const table = schema.tables.get("customers")!;
  await assert.rejects(
    adapter.update(table, [
      { rowNumber: 2, expectedVersion: 1, values: { _shql_id: "a", _shql_version: 2, name: "Stale" } },
    ]),
    /changed after it was read/,
  );
});

test("validates and inspects adapter layouts", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const inspection = await db.inspect("customers");
  assert.equal(inspection[0].rowCount, 3);
  const validation = await db.validate();
  assert.equal(validation[0].ok, false);
  assert.match(validation[0].issues.join(" "), /_shql_version/);
  assert.equal((await db.doctor()).ok, true);
});

test("rejects duplicate stable ids", async () => {
  const { schema } = setup();
  const adapter = new MemoryAdapter({
    customers: [
      {
        _shql_id: "duplicate",
        name: "A",
        email: "a@x",
        status: "active",
        score: null,
        created_at: new Date(),
      },
      {
        _shql_id: "duplicate",
        name: "B",
        email: "b@x",
        status: "active",
        score: null,
        created_at: new Date(),
      },
    ],
  });
  const db = await connect({ schema, adapter });
  await assert.rejects(db.query(`FROM customers SELECT *`), /Duplicate id/);
});

test("retries transient Google API failures", async () => {
  let attempts = 0;
  const fetcher = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0.001" },
      });
    }
    return new Response(JSON.stringify({ spreadsheetId: "sheet", properties: { title: "Test" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const adapter = new GoogleSheetsAdapter(
    "sheet",
    { type: "access-token", accessToken: "token" },
    fetcher as typeof fetch,
  );
  assert.equal((await adapter.doctor()).ok, true);
  assert.equal(attempts, 2);
});

test("supports named connections and cross-connection joins", async () => {
  const schema = parseSchema(`
    CONNECTION sales FROM MEMORY sales
    CONNECTION crm FROM MEMORY crm

    TABLE orders FROM sales.#orders {
      _shql_id: id
      customer_id: text
      total: number
    }

    TABLE customers FROM crm.#customers {
      _shql_id: id
      name: text
      segment: text
    }
  `);
  const sales = new MemoryAdapter({
    orders: [
      { _shql_id: "o1", customer_id: "c1", total: 100 },
      { _shql_id: "o2", customer_id: "missing", total: 50 },
    ],
  });
  const crm = new MemoryAdapter({
    customers: [{ _shql_id: "c1", name: "Ada", segment: "enterprise" }],
  });
  const db = await connect({
    schema,
    connections: { sales: { adapter: sales }, crm: { adapter: crm } },
  });
  const result = await db.query(`
    FROM orders AS o
    JOIN customers AS c ON o.customer_id = c._shql_id
    SELECT o._shql_id AS order_id, c.name, o.total
  `);
  assert.deepEqual(result.rows, [{ order_id: "o1", name: "Ada", total: 100 }]);
});

test("supports LEFT JOIN and CASE expressions", async () => {
  const { schema, adapter } = setup();
  const db = await connect({ schema, adapter });
  const result = await db.query(`
    FROM customers AS c
    LEFT JOIN customers AS other ON c.email = other.email
    SELECT c.name, CASE
      WHEN c.score >= 20 THEN "high"
      WHEN c.score >= 10 THEN "medium"
      ELSE "unknown"
    END AS tier
    SORT name ASC
  `);
  assert.deepEqual(result.rows, [
    { name: "Ada", tier: "medium" },
    { name: "Lin", tier: "high" },
    { name: "Sam", tier: "unknown" },
  ]);
});
