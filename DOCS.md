# SHQL documentation

SHQL (**Sheets Query Language**) is a tabular data language. It gives a small, readable query and mutation language to data that lives in spreadsheets, files, APIs, and databases, behind a single typed schema.

The data model is uniform across every source:

- A workbook, spreadsheet, file, or endpoint is a **database**.
- Each worksheet, tab, file, or resource is a **table**.
- The first row holds **column names**; the remaining rows are **records**.
- A `.shql` schema binds stable SHQL names to physical sources and defines column types.
- Queries execute as a top-to-bottom data pipeline.

Google Sheets is the first-class, human-facing source, but it is one connector among several. The published package (`@shql/core`) has **no runtime dependencies** and targets Node.js 20.11 or newer. TypeScript is compiled to standard ESM with declaration files and source maps.

## Status and scope

Implemented:

- Typed and compact schema declarations with environment-variable substitution
- Named connections across Google Sheets, Excel, CSV, JSON, HTTP, SQL, and in-memory sources
- Reads: `FROM`, `JOIN` / `LEFT JOIN`, `LET`, `WHERE`, `GROUP BY`, `SELECT` (with `DISTINCT`), `HAVING`, `SORT`, `TAKE`, `SKIP` / `OFFSET`
- Expressions: arithmetic, comparison, logical, `IN` / `NOT IN`, `IS NULL`, string concatenation (`||`), `CASE`, scalar and aggregate functions
- Writes: object-style `INSERT` (single and batch), `UPDATE`, guarded `DELETE`, key-based `UPSERT`, all with `RETURNING`
- Reusable read-only `VIEW` declarations
- Named parameters that are never parsed as source
- Managed `_shql_version` optimistic concurrency and stale-write detection
- `validate`, `inspect`, `init`, and `doctor` operations
- Platform APIs: `transform` / `materialize` / `sync`, query plans, jobs, an HTTP server, governance and audit, migrations and backups, and TypeScript codegen
- Google service-account, OAuth-refresh, and access-token authentication; retry handling for rate limits and transient failures

Not yet implemented:

- Multi-statement transactions
- Subqueries and set operations (`UNION`)
- Formula preservation
- Pushdown / streaming execution (whole tables are read into memory)

SHQL is intended for internal tools, operational workflows, lightweight data pipelines, reporting, and modest datasets. It is not a replacement for a transactional database.

## Requirements

- Node.js 20.11 or newer.
- For **Google Sheets** connections only: a Google Cloud project with the Sheets API enabled, a service account or OAuth/access token, and a spreadsheet shared with the authenticated identity.
- File (`CSV`, `JSON`, `EXCEL`), `HTTP`, in-memory, and bring-your-own `SQL` connections need no Google credentials.

## Installation

```bash
npm install @shql/core
```

```bash
npm install --global @shql/core
shql --help
```

SHQL is an ESM package with TypeScript declarations:

```ts
import { connect } from "@shql/core";
```

## Data model

For positional sources (Google Sheets, Excel, CSV) the first physical row is the header row and must match the schema's column names and order for typed writes. For JSON the record keys are the columns. For HTTP and SQL the adapter maps records to the schema.

Use a dedicated `id` column such as `_shql_id`. SHQL generates a UUID when inserting a record whose `id` is omitted; existing rows must already have unique IDs.

For mutable tables, declare `_shql_version: number`. New records begin at version `1`, and each SHQL update increments it. Applications cannot assign this field directly; it powers optimistic concurrency.

## Schema files

A schema declares connections and tables. The default schema filename used by the CLI is `database.shql`. Comments use `//`.

### Sources

A single default Google Sheets source:

```shql
SHEET ${GOOGLE_SHEETS_ID}
```

Or named connections, which make storage explicit and allow cross-source queries:

```shql
CONNECTION operations FROM GOOGLE-SHEETS ${OPERATIONS_SHEET_ID}
CONNECTION exports    FROM JSON  "./data/exports.json"
CONNECTION imports    FROM CSV   "./data/imports"
CONNECTION catalog    FROM EXCEL "./data/catalog.xlsx"
CONNECTION crm        FROM HTTP  ${CRM_API_URL}
```

| Provider                      | Source value                          | Read | Write |
| ----------------------------- | ------------------------------------- | :--: | :---: |
| `GOOGLE-SHEETS`               | Spreadsheet ID                        |  ✓   |   ✓   |
| `EXCEL` (alias `XLSX`)        | Path to a `.xlsx` workbook            |  ✓   |   ✓   |
| `CSV`                         | A `.csv` file or a directory of them  |  ✓   |   ✓   |
| `JSON`                        | A `.json` file or a directory of them |  ✓   |   ✓   |
| `HTTP`                        | Base URL of a JSON endpoint           |  ✓   |   ✓   |
| `MEMORY`                      | (none; in-process)                    |  ✓   |   ✓   |
| `POSTGRES`, `MYSQL`, `SQLITE` | Handled by a supplied `SqlAdapter`    |  ✓   |   ✓   |

### Typed tables

Typed declarations are required for writes:

```shql
TABLE customers FROM #{CUSTOMERS_TAB_ID} {
  _shql_id: id
  _shql_version: number
  name: text
  email: text
  status: text
  score: number?
  created_at: datetime
}
```

The name after `TABLE` is the stable SHQL name. The value after `#` is the physical locator within the connection — a numeric `gid` for Google Sheets, a worksheet name for Excel, or a file/resource key. A leading `connection.` prefix selects a named connection:

```shql
TABLE titles FROM catalog.#Sheet1 { ... }
TABLE orders FROM operations.#{ORDERS_TAB_ID} { ... }
```

Renaming a physical Google tab does not break the schema because the numeric tab ID is stable. Environment references resolve when the schema is loaded; literal IDs also work (`SHEET 1AbCdEf`, `FROM #123456789`).

### Compact tables

Compact declarations infer all headers as nullable text and are read-only — useful for exploration:

```shql
[${GOOGLE_SHEETS_ID}]
[#{CUSTOMERS_TAB_ID} AS customers]
[#{ORDERS_TAB_ID} AS orders]
```

Convert a compact table to a typed declaration before inserting, updating, or deleting.

### Views

A view is a reusable, read-only named query in the schema:

```shql
VIEW active_customers AS {
  FROM customers
  WHERE status = "active"
  SELECT _shql_id, name, email
}
```

Query a view like any table: `FROM active_customers SELECT name`.

### Column types

| Type       | Runtime value | Meaning                                                  |
| ---------- | ------------- | -------------------------------------------------------- |
| `id`       | `string`      | Stable record identity; generated on insert when omitted |
| `text`     | `string`      | Text value                                               |
| `number`   | `number`      | Finite number                                            |
| `boolean`  | `boolean`     | `true` or `false`                                        |
| `date`     | `Date`        | Date value                                               |
| `datetime` | `Date`        | Date and time value                                      |

Append `?` to make a field nullable (`score: number?`). Blank cells read as `null`; inserts and updates reject `null` for non-nullable columns. A table may declare at most one `id` column.

### Constraints and defaults

Constraints follow the type on a column declaration:

```shql
TABLE customers FROM #{CUSTOMERS_TAB_ID} {
  _shql_id: id
  _shql_version: number
  email: text UNIQUE MATCHES EMAIL
  status: text IN ["active", "inactive", "trial"] DEFAULT "active"
  score: number? >= 0 <= 100
  region: text MATCHES /^[A-Z]{2}$/
  created_at: datetime DEFAULT NOW()
}
```

| Constraint        | Effect                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| `UNIQUE`          | Rejects duplicate non-null values within the table                                      |
| `IN [ ... ]`      | Restricts to an allowed set (a JSON array of values)                                    |
| `>= n` / `<= n`   | Inclusive numeric minimum / maximum                                                     |
| `MATCHES /re/`    | Text must match the regular expression                                                  |
| `MATCHES EMAIL`   | Shorthand for an email pattern                                                          |
| `DEFAULT <value>` | Applied on insert when omitted: `NOW()`, a string, a number, `TRUE`, `FALSE`, or `NULL` |

Schema validation rejects unknown types, duplicate tables or columns, missing environment variables, unknown providers, and more than one `id` column.

## Connections and adapters

Each connection resolves to a `TableAdapter`. Built-in adapters require no configuration beyond the connection source, except Google Sheets (authentication) and SQL (a client).

### Google Sheets

The default for `SHEET` and `GOOGLE-SHEETS` connections. Requires authentication (see below). Reads request unformatted values, writes use `USER_ENTERED`, datetimes are written as ISO 8601, and transient `429`/`5xx` responses are retried with backoff.

### Excel workbooks

`EXCEL` (alias `XLSX`) connections read and write `.xlsx` files directly. A workbook is one connection and each worksheet is a table, addressed by its sheet name — the same model as Google Sheets:

```shql
CONNECTION catalog FROM EXCEL "./data/catalog.xlsx"

TABLE titles FROM catalog.#Sheet1 {
  _shql_id: id
  _shql_version: number
  title: text
  price: number
}
```

```ts
const db = await connect({ schema: parseSchema(schemaText) });
await db.initialize(); // creates the workbook and worksheets if absent
await db.query(`INSERT INTO titles { title: "SHQL", price: 0 }`);
```

Notes and limits:

- No third-party dependency — the OOXML package is read and written with Node's built-in `zlib`.
- Sheet names used as `tabId` must not contain spaces.
- On mutation, the target worksheet is rewritten (inline strings, ISO-8601 dates). Other worksheets and shared strings are preserved. By default, SHQL refuses to rewrite a worksheet containing formulas, styles, charts, drawings, validation, merged cells, or other presentation features it cannot preserve.
- Destructive rewrites require an explicit per-connection opt-in after creating a backup: `connections: { catalog: { allowDestructiveXlsxWrites: true } }`.
- Externally produced workbooks that store dates as serial numbers are decoded using the workbook's 1900 or 1904 date system when the column type is `date` or `datetime`.
- Archives are checked for supported compression, valid bounds, CRC integrity, duplicate parts, and bounded compressed/expanded sizes before XML is parsed.
- ZIP64 workbooks (more than 65,535 parts) are not supported.

### CSV and JSON

`CSV` and `JSON` connections accept either a single file or a directory; in a directory, each table's `tabId` selects the file (`<tabId>.csv` / `<tabId>.json`). A JSON file may be an array (single table) or an object keyed by table. Writes are atomic (write-to-temp then rename).

### HTTP

`HTTP` connections read from and write to a JSON endpoint under a base URL. Supply per-connection `headers` and a custom `fetch` through `connect` options.

### SQL

`SqlAdapter` is a portable client contract for PostgreSQL, MySQL, and SQLite. It does not bundle a driver; provide a `SqlClient` (an object exposing `query(sql, params)`), so SHQL adds no database dependency:

```ts
import { connect, SqlAdapter } from "@shql/core";

const adapter = new SqlAdapter(client /* { query(sql, params) } */);
const db = await connect({ schema, connections: { warehouse: { adapter } } });
```

### In-memory

`MemoryAdapter` holds rows in process — ideal for tests and local logic with no credentials:

```ts
import { connect, MemoryAdapter, parseSchema } from "@shql/core";

const adapter = new MemoryAdapter({
  customers: [{ _shql_id: "c1", _shql_version: 1, name: "Ada" }],
});
const db = await connect({ schema: parseSchema(schemaText), adapter });
```

Custom adapters implement `read`, `append`, `update`, and `delete` from `TableAdapter` (with optional `inspect`, `initialize`, and `doctor`).

## Authentication

Authentication is only required for Google Sheets connections.

### Service account

Create a service account, enable the Sheets API, download its JSON credentials, and share the spreadsheet with its `client_email`. The CLI accepts the full document or separate values:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
# or
export GOOGLE_CLIENT_EMAIL='service-account@example.iam.gserviceaccount.com'
export GOOGLE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n'
```

### OAuth refresh token

```bash
export GOOGLE_OAUTH_CLIENT_ID='...'
export GOOGLE_OAUTH_CLIENT_SECRET='...'
export GOOGLE_OAUTH_REFRESH_TOKEN='...'
```

### Access token

```bash
export GOOGLE_ACCESS_TOKEN='ya29...'
```

The caller refreshes access tokens; the service-account and OAuth adapters obtain and cache tokens automatically. Never commit credentials or `.env` files.

### Node API

```ts
const db = await connect({
  schema: "./database.shql",
  auth: {
    type: "service-account",
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL!,
    privateKey: process.env.GOOGLE_PRIVATE_KEY!.replaceAll("\\n", "\n"),
  },
});
```

`auth` accepts `{ type: "service-account", ... }`, `{ type: "oauth", ... }`, or `{ type: "access-token", accessToken }`. Per-connection authentication, headers, and `fetch` can be supplied through `connect`'s `connections` option.

## Query language

Clauses execute in written order. The canonical select pipeline is:

```text
FROM → JOIN → LET → WHERE → GROUP BY → SELECT [DISTINCT] → HAVING → SORT → TAKE / SKIP
```

Keywords are case-insensitive; identifiers are case-sensitive. A trailing semicolon is optional. Wrap an identifier that collides with a keyword in backticks (`` `select` ``).

### Selecting and projecting

```shql
FROM customers
SELECT *
```

```shql
FROM orders
SELECT _shql_id, total * 1.13 AS total_with_tax
```

`SELECT DISTINCT` removes duplicate output rows:

```shql
FROM customers
SELECT DISTINCT region
SORT region ASC
```

### Filtering

```shql
FROM customers
WHERE status = "active" AND created_at >= $since
SELECT name, email
```

Null checks use `IS NULL` / `IS NOT NULL`, which compose with `AND` / `OR`:

```shql
FROM customers
WHERE score IS NULL AND status = "active"
SELECT name
```

### Membership

```shql
FROM customers
WHERE status IN ("active", "trial")
SELECT name
```

`NOT IN` negates the test. An empty list (`IN ()`) matches nothing, and a `null` left-hand value never matches.

### Computed fields with `LET`

`LET` adds a value available to every later clause without changing the source. Bindings evaluate top to bottom:

```shql
FROM orders
LET subtotal = price * quantity
LET total = subtotal * 1.13
WHERE total >= 100
SELECT customer_id, total
SORT total DESC
```

### Parameters

Parameters begin with `$` and are supplied separately. They are data, never parsed as SHQL, which prevents query injection. A missing parameter is a `VALIDATION_ERROR`.

```shql
FROM customers
WHERE status = $status
SELECT name, email
```

```ts
await db.query(query, { status: "active" });
```

### Sorting and pagination

```shql
FROM customers
SELECT name, created_at
SORT created_at DESC, name ASC
TAKE 50 SKIP 100
```

`SORT` operates on the projected output, so sort by a selected column (or its alias). `TAKE` limits the row count; `SKIP` (alias `OFFSET`) discards leading rows. They may appear in either order and apply after sorting (skip, then take).

### Literals

```text
"text"   'text'   42   3.14   TRUE   FALSE   NULL
```

Strings accept single or double quotes and the escapes `\n` and `\t`.

### Operators

From lowest to highest precedence:

| Category       | Operators                                                                       |
| -------------- | ------------------------------------------------------------------------------- |
| Logical        | `OR`, `AND`                                                                     |
| Comparison     | `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `IN`, `NOT IN`, `IS NULL`, `IS NOT NULL` |
| Additive       | `+`, `-`, `\|\|` (string concatenation)                                         |
| Multiplicative | `*`, `/`                                                                        |
| Unary          | `NOT`, `-`                                                                      |

Null semantics: comparisons involving `null` are false except `IS NULL` / `IS NOT NULL`; `IN` with a `null` left side is false; arithmetic requires finite numbers (division by zero and non-numeric operands are rejected); `||` and `CONCAT` treat `null` as an empty string.

### Scalar functions

| Function                                | Result                                 |
| --------------------------------------- | -------------------------------------- |
| `NOW()`                                 | Current datetime                       |
| `UPPER(text)` / `LOWER(text)`           | Case conversion                        |
| `LEN(text)`                             | Text length                            |
| `TRIM(text)`                            | Trim leading/trailing whitespace       |
| `REPLACE(text, search, with)`           | Replace all occurrences                |
| `CONCAT(a, b, ...)`                     | Concatenate values (nulls become `""`) |
| `CONTAINS(text, part)`                  | Substring test                         |
| `STARTS_WITH(text, prefix)`             | Prefix test                            |
| `ENDS_WITH(text, suffix)`               | Suffix test                            |
| `ROUND(number [, digits])`              | Round to `digits` decimals (default 0) |
| `ABS(number)`                           | Absolute value                         |
| `COALESCE(a, b, ...)`                   | First non-null value                   |
| `TEXT` / `NUMBER` / `DATE` / `DATETIME` | Type conversion                        |

```shql
FROM customers
WHERE ENDS_WITH(email, "@example.com")
SELECT UPPER(name) AS name, name || " <" || email || ">" AS contact
```

### Grouping, aggregation, and `HAVING`

```shql
FROM orders
WHERE status = "paid"
GROUP BY customer_id
SELECT customer_id, COUNT(*) AS orders, SUM(total) AS revenue
HAVING SUM(total) >= 1000
SORT revenue DESC
```

Aggregates are `COUNT`, `SUM`, `AVG`, `MIN`, and `MAX`. `COUNT(*)` counts all rows; field aggregates ignore nulls. A non-aggregate projected field must appear in `GROUP BY`. `HAVING` filters groups and must use aggregate expressions; it requires `GROUP BY` or an aggregate `SELECT`. Omitting `GROUP BY` aggregates the whole filtered table into one group.

### Joins

Joins run in memory and can cross connections:

```shql
FROM orders AS o
JOIN customers AS c ON o.customer_id = c._shql_id
SELECT o._shql_id AS order_id, c.name, o.total
```

`LEFT JOIN` keeps unmatched left rows (right columns become `null`). Qualify columns with the table name or alias when names collide. Use `shql explain` to review join cost on large sources.

### Conditional expressions

```shql
FROM customers
SELECT name, CASE
  WHEN spend >= 1000 THEN "enterprise"
  WHEN spend >= 250 THEN "growth"
  ELSE "standard"
END AS segment
```

### Writing data

Mutations require a typed table; compact tables are read-only.

```shql
-- Insert (RETURNING is optional on every mutation)
INSERT INTO customers {
  name: $name, email: $email, status: "active", created_at: NOW()
}
RETURNING _shql_id, _shql_version, name

-- Batch insert
INSERT INTO customers [
  { name: "Ada", email: "ada@example.com", status: "active", created_at: NOW() },
  { name: "Lin", email: "lin@example.com", status: "active", created_at: NOW() }
]

-- Upsert: update the unique match on KEY, else insert
UPSERT INTO customers
KEY email
VALUE { email: $email, name: $name, status: $status, created_at: NOW() }

-- Update (WHERE required; id is immutable)
FROM customers WHERE _shql_id = $id
UPDATE { status: "inactive" }
RETURNING _shql_id, status

-- Delete (WHERE required)
FROM customers WHERE _shql_id = $id
DELETE
```

`INSERT` generates `_shql_id`, initializes `_shql_version`, applies defaults, and validates every field. `UPSERT`'s value object must include the key; more than one existing match is a `CONFLICT`. `UPDATE` and `DELETE` reject a missing `WHERE` to prevent accidental whole-table writes.

### Grammar

An informal grammar for the v1 syntax:

```text
statement := select | insert | update | delete | upsert

select  := FROM table [AS alias]
           [ [LEFT] JOIN table [AS alias] ON expression ]...
           [LET name = expression]...
           [WHERE expression]
           [GROUP BY expression [, expression]...]
           SELECT [DISTINCT] (* | projection [, projection]...)
           [HAVING expression]
           [SORT expression [ASC | DESC] [, ...]]
           [TAKE integer] [SKIP integer]          // either order; OFFSET = SKIP

insert  := INSERT INTO table (object | [ object [, object]... ])
           [RETURNING projection-list]

update  := FROM table [LET ...] WHERE expression
           UPDATE object [RETURNING projection-list]

delete  := FROM table [LET ...] WHERE expression
           DELETE [RETURNING projection-list]

upsert  := UPSERT INTO table KEY field VALUE object
           [RETURNING projection-list]

projection := (expression [AS name]) | *
expression := literal | field | $param | (expression)
            | NOT expression | - expression
            | expression binary-op expression
            | expression [NOT] IN ( [expression [, expression]...] )
            | expression IS [NOT] NULL
            | CASE (WHEN expression THEN expression)... [ELSE expression] END
            | name ( [expression [, expression]...] )
```

Subqueries, set operations, and multi-system transactions are intentionally outside the current language.

## Node API

### `connect(options)`

| Option        | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `schema`      | Schema filepath or a parsed `DatabaseSchema`             |
| `auth`        | Google authentication when no custom adapter is supplied |
| `adapter`     | A single custom `TableAdapter` (e.g. `MemoryAdapter`)    |
| `connections` | Per-connection `adapter` / `auth` / `headers` / `fetch`  |
| `env`         | Values used to resolve schema variables                  |
| `fetch`       | Fetch implementation for tests or controlled networking  |
| `governance`  | A `Governance` policy                                    |
| `context`     | The acting `{ actor, role }` for governance and audit    |

### `db.query(source, parameters?)` and `db.execute(source, parameters?)`

```ts
interface QueryResult {
  operation: "select" | "insert" | "update" | "delete" | "upsert";
  rows: Record<string, Scalar>[];
  affectedRows: number;
  columns: string[];
}
```

Dates are returned as `Date` instances and serialize to ISO strings in JSON. `query` parses a string; `execute` accepts a string or a pre-parsed `Query`.

### `db.preview(source, parameters?)`

Estimates the effect of a statement without writing. For mutations it returns the affected row count and warnings; for selects it runs the query.

### `db.explain(source)`

Returns a `QueryPlan` describing source reads, joins, filters, grouping, having, projection, sorting, skip/take, and cost warnings.

### Metadata and diagnostics

```ts
db.tables();
db.describe("customers");
await db.inspect(); // headers, row counts, inferred columns
await db.validate(); // compare physical layout with the schema
await db.initialize(); // write declared headers / create sheets where empty
await db.doctor(); // verify connectivity for every connection
```

## Platform operations

### Transform, materialize, and sync

```ts
import { materialize, sync, transform } from "@shql/core";

const report = await transform(db, reportQuery); // run and return rows
await materialize(db, reportQuery, "customer_revenue", { mode: "replace", dryRun: false });
await sync(db, "crm_customers", "sheet_customers", "email");
```

Materialization modes are `append`, `replace`, and key-based `merge`; every materialization supports a dry run.

### Jobs

```ts
import { JobRunner } from "@shql/core";

const jobs = new JobRunner();
jobs.register({
  name: "refresh-revenue",
  retries: 3,
  run: async () => materialize(db, revenueQuery, "revenue", { mode: "replace" }),
});
await jobs.run("refresh-revenue");
```

Job history is persisted and retries use backoff.

### HTTP server

```ts
import { createShqlServer, listen } from "@shql/core";

const server = createShqlServer(db, {
  token: process.env.SHQL_SERVER_TOKEN,
  allowMutations: false,
  allowedTables: ["customers", "orders"],
});
await listen(server, { port: 4545 });
```

Exposes health, schema, tables, query, and explain endpoints with bearer authentication, table allowlists, and mutation controls.

### Governance and audit

```ts
import { Governance, JsonlAuditSink, connect } from "@shql/core";

const governance = new Governance(
  { analyst: [{ table: "customers", operations: ["select"], maskedColumns: ["email"] }] },
  new JsonlAuditSink("./audit/shql.jsonl"),
);

const db = await connect({
  schema: "./database.shql",
  auth,
  governance,
  context: { actor: "analyst@example.com", role: "analyst" },
});
```

Authorization is checked before execution, masked fields are redacted from results, and successful or failed operations emit audit events. `MemoryAuditSink` is available for tests.

### Migrations, backups, and codegen

```ts
import { MigrationRunner, backupTable, restoreTable, generateTypes, writeTypes } from "@shql/core";

const migrations = new MigrationRunner(db, [
  { id: "001_init_customers", up: async (database) => database.initialize("customers") },
]);
await migrations.apply();

await backupTable(db, "customers", "./backups/customers.json");
await restoreTable(db, "customers", "./backups/customers.json");

await writeTypes(db.schema, "src/shql.generated.d.ts");
```

Migration state is durable and ordered; generated interfaces reflect table names, field types, and nullability.

## CLI

```bash
shql tables [--schema path]
shql describe <table> [--schema path]
shql validate [--schema path]          # exits 2 on an operational problem
shql inspect [table] [--schema path]
shql init [table] [--schema path]
shql doctor [--schema path]
shql explain <query>
shql materialize <query> --into <table> [--mode append|replace|merge] [--key field] [--dry-run]
shql generate types [--out path]
shql backup <table> --out <path>
shql restore <table> --file <path>
shql serve [--port number]
shql query <query> [--params JSON]
shql query --file <path> [--params JSON]
```

`--schema` defaults to `database.shql`. Add `--json` for compact output and `--dry-run` to preview a mutation. Google authentication is only required when the schema uses a Google Sheets connection. Errors print to stderr and set a non-zero exit code.

```bash
shql query 'FROM customers WHERE status = $status SELECT *' --params '{"status":"active"}'
SHQL_SERVER_TOKEN=secret shql serve --port 4545
```

## Errors

All expected runtime failures use `ShqlError` with a stable `code`:

| Code               | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| `SCHEMA_ERROR`     | Invalid schema or missing schema environment value |
| `QUERY_ERROR`      | Invalid query syntax                               |
| `VALIDATION_ERROR` | Invalid field, type, parameter, or unsafe mutation |
| `AUTH_ERROR`       | Authentication failure                             |
| `ADAPTER_ERROR`    | Source API, layout, or adapter failure             |
| `CONFLICT`         | Stale version, duplicate ID/key, or missing target |

```ts
import { ShqlError } from "@shql/core";

try {
  await db.query(query, parameters);
} catch (error) {
  if (error instanceof ShqlError) console.error(error.code, error.message, error.details);
}
```

## Mutation safety and concurrency

- Typed writes require the physical header row to match the schema exactly in name and order.
- Unknown columns and invalid values are rejected; `id` values are immutable and must be unique.
- `UPDATE` and `DELETE` require `WHERE`; compact tables are read-only.
- When `_shql_version: number` is declared, SHQL reads the current version before an update or delete, rejects a changed version with `CONFLICT`, and increments on success.

Sources like Google Sheets offer no atomic compare-and-swap, so version verification and writing are separate requests and a small race window remains. These checks catch ordinary concurrent edits but do not make a spreadsheet transactional. For critical or highly concurrent data, use a transactional database.

## Performance model

SHQL reads a whole table into memory, then filters, groups, sorts, and projects in Node. Recommendations:

- Keep tables modest — thousands to low tens of thousands of rows.
- Reuse a connected database so metadata and tokens stay cached.
- Avoid rapid polling; respect source API quotas. Transient Google `429`/`5xx` responses are retried with exponential backoff and jitter.
- Do not expose unrestricted query endpoints to untrusted callers.

## Development

```bash
npm install
npm run ci          # typecheck, lint, format check, test, build
```

Individual checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npm run check`.

Run the optional live Google integration test with credentials configured:

```bash
SHQL_SCHEMA=examples/database.shql npm run test:integration
```

Project layout:

```text
src/
  adapters/   google-sheets.ts  xlsx.ts  csv.ts  json.ts  http.ts  sql.ts  memory.ts
  cli.ts  database.ts  engine.ts  query.ts  schema.ts  planner.ts  pipeline.ts
  governance.ts  jobs.ts  migrations.ts  codegen.ts  server.ts  language-server.ts
  errors.ts  types.ts  index.ts
test/
  shql.test.ts  v1.test.ts  xlsx.test.ts  language.test.ts  google.integration.test.ts
examples/
  database.shql
```

The parser is handwritten so the grammar can evolve without a parser-generator runtime. Adapters isolate storage behavior from language semantics.

## Roadmap beyond v1

1. Pushdown planning and streaming for capable connectors.
2. Dedicated PostgreSQL, MySQL, and SQLite driver packages around `SqlAdapter`.
3. External coordination for atomic locking where required.
4. Richer column-level policy evaluation and durable lineage.

Language additions should preserve the core rule: a query should read top to bottom and be understandable without knowing any source's API details.
