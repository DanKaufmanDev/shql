# SHQL

[![npm version](https://img.shields.io/npm/v/@shql/core.svg)](https://www.npmjs.com/package/@shql/core/v/next)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Sheets Query Language** is a data operations language for querying, validating, transforming, syncing, materializing, and governing company data. Google Sheets is its first-class human interface, not its only data source.

A spreadsheet becomes a database, each tab becomes a table, the first row defines its columns, and SHQL provides a small language for reading and safely mutating the records beneath it.

```shql
FROM customers
WHERE status = "active"
SELECT name, email
SORT name ASC
TAKE 20
```

SHQL is designed for internal tools, operational workflows, lightweight data pipelines, company reporting, and applications whose data is spread across Sheets, files, APIs, and databases. It is deliberately smaller than SQL and reads from top to bottom like a data pipeline.

## Contents

- [Why SHQL?](#why-shql)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Schema language](#schema-language)
- [Query language](#query-language)
- [Writing data](#writing-data)
- [Company data operations](#company-data-operations)
- [Node API](#node-api)
- [CLI](#cli)
- [Safety and concurrency](#safety-and-concurrency)
- [Errors](#errors)
- [Development](#development)

## Why SHQL?

Google Sheets is approachable, collaborative, and already used as a database by a heroic number of spreadsheets pretending not to be databases. SHQL adds the missing structure:

- Typed schemas
- Stable table and record identities
- Named query parameters
- Filtering, computed values, grouping, aggregation, sorting, and limits
- Inserts, batch inserts, updates, deletes, and upserts
- Mutation guards and version-based conflict detection
- A Node API and command-line interface
- Service-account and access-token authentication
- An in-memory adapter for tests
- No runtime npm dependencies

The mental model is intentionally small:

```text
Google spreadsheet → SHQL database
Spreadsheet tab    → SHQL table
First row          → column names
Remaining rows     → records
```

SHQL evaluates transformations in Node and delegates persistence to connector adapters. It does not turn Sheets or flat files into transactional databases, and it does not pretend otherwise.

## Installation

SHQL requires Node.js 20.11 or newer.

Install it in a project:

```bash
npm install @shql/core
```

Or install the CLI globally:

```bash
npm install --global @shql/core
shql --help
```

SHQL is an ESM package and includes TypeScript declarations:

```ts
import { connect } from "@shql/core";
```

## Quick start

### 1. Prepare a spreadsheet

Create a Google spreadsheet with a `customers` tab. The first row must contain the schema headers in the same order:

| \_shql_id  | \_shql_version | name | email           | status | created_at               |
| ---------- | -------------: | ---- | --------------- | ------ | ------------------------ |
| customer_1 |              1 | Ada  | ada@example.com | active | 2026-01-05T14:00:00.000Z |

The spreadsheet ID is between `/d/` and `/edit` in its URL. The numeric tab ID is its `gid`:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=TAB_ID
```

### 2. Create `database.shql`

```shql
SHEET ${GOOGLE_SHEETS_ID}

TABLE customers FROM #{CUSTOMERS_TAB_ID} {
  _shql_id: id
  _shql_version: number
  name: text
  email: text
  status: text
  created_at: datetime
}
```

### 3. Configure authentication

For a backend application, create a Google service account, enable the Google Sheets API, and share the spreadsheet with the service account's email address.

```bash
export GOOGLE_SHEETS_ID="your-spreadsheet-id"
export CUSTOMERS_TAB_ID="0"
export GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
```

Never commit Google credentials or `.env` files.

### 4. Connect and query

```ts
import { connect } from "@shql/core";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);

const db = await connect({
  schema: "./database.shql",
  auth: {
    type: "service-account",
    clientEmail: credentials.client_email,
    privateKey: credentials.private_key,
  },
});

const result = await db.query(
  `
    FROM customers
    WHERE status = $status
    SELECT _shql_id, name, email
    SORT name ASC
    TAKE 20
  `,
  { status: "active" },
);

console.log(result.rows);
```

## Schema language

The schema maps friendly SHQL table names to stable Google resource IDs and defines how cells are converted into runtime values.

### Named connections

Connections make storage explicit and allow cross-source queries:

```shql
CONNECTION operations FROM GOOGLE-SHEETS ${OPERATIONS_SHEET_ID}
CONNECTION exports FROM JSON "./data/exports.json"
CONNECTION imports FROM CSV "./data/imports"
CONNECTION catalog FROM EXCEL "./data/catalog.xlsx"
CONNECTION crm FROM HTTP ${CRM_API_URL}

TABLE orders FROM operations.#{ORDERS_TAB_ID} { ... }
TABLE customers FROM crm.#customers { ... }
TABLE daily_export FROM exports.#daily { ... }
TABLE titles FROM catalog.#Sheet1 { ... }
```

Built-in adapters cover Google Sheets, Excel (`.xlsx`), JSON, CSV, HTTP, and memory. `SqlAdapter` provides a portable client contract for PostgreSQL, MySQL, and SQLite drivers without forcing a database driver on every SHQL installation. Like Google Sheets, an Excel workbook is one connection and each worksheet is a table, addressed by its sheet name (`catalog.#Sheet1`); the adapter reads and writes `.xlsx` files directly with no third-party dependency. SHQL refuses to rewrite worksheets containing formulas, styles, charts, or other presentation features unless `allowDestructiveXlsxWrites` is explicitly enabled after creating a backup.

### Typed tables

Typed tables support reads and mutations:

```shql
SHEET ${GOOGLE_SHEETS_ID}

TABLE customers FROM #{CUSTOMERS_TAB_ID} {
  _shql_id: id
  _shql_version: number
  name: text
  email: text
  status: text
  score: number?
  created_at: datetime
}

TABLE orders FROM #{ORDERS_TAB_ID} {
  _shql_id: id
  _shql_version: number
  customer_id: text
  total: number
  paid: boolean
  ordered_on: date
}
```

Environment references are resolved when the schema is loaded:

```shql
SHEET ${GOOGLE_SHEETS_ID}
TABLE customers FROM #{CUSTOMERS_TAB_ID} { ... }
```

Literal IDs also work:

```shql
SHEET 1AbCdEfGhIjKlMn
TABLE customers FROM #123456789 { ... }
```

The SHQL table name remains stable if somebody renames the visible Google tab.

### Compact tables

For read-only exploration, SHQL can infer headers without a typed schema:

```shql
[${GOOGLE_SHEETS_ID}]
[#{CUSTOMERS_TAB_ID} AS customers]
[#{ORDERS_TAB_ID} AS orders]
```

Compact fields are treated as nullable text. Declare a typed table before inserting, updating, upserting, or deleting records.

### Column types

| SHQL type  | Node value | Meaning                                                  |
| ---------- | ---------- | -------------------------------------------------------- |
| `id`       | `string`   | Stable record identity; generated on insert when omitted |
| `text`     | `string`   | Text value                                               |
| `number`   | `number`   | Finite number                                            |
| `boolean`  | `boolean`  | `true` or `false`                                        |
| `date`     | `Date`     | Date value                                               |
| `datetime` | `Date`     | Date and time value                                      |

Append `?` to permit `null`:

```shql
score: number?
```

Blank cells become `null`. Inserts and updates reject `null` for non-nullable columns.

### Constraints and defaults

```shql
TABLE customers FROM operations.#{CUSTOMERS_TAB_ID} {
  _shql_id: id
  _shql_version: number
  email: text UNIQUE MATCHES EMAIL
  status: text IN ["active", "inactive", "pending"] DEFAULT "active"
  spend: number >= 0
  score: number? >= 0 <= 100
  created_at: datetime DEFAULT NOW()
}
```

SHQL validates allowed values, uniqueness, numeric bounds, regular-expression or email patterns, nullability, and defaults before writing.

### Reserved columns

Two conventional columns provide safe identity and concurrency behavior:

```shql
_shql_id: id
_shql_version: number
```

- `_shql_id` receives a UUID when omitted during an insert.
- `_shql_id` is immutable after creation.
- `_shql_version` begins at `1` and increments after each SHQL update.
- `_shql_version` cannot be assigned manually.
- Missing and duplicate IDs are rejected when typed data is queried.

## Query language

A select query follows one canonical pipeline:

```text
FROM → LET → WHERE → GROUP BY → SELECT → SORT → TAKE
```

Keywords are case-insensitive. Field and table names are case-sensitive.

### Selecting fields

```shql
FROM customers
SELECT *
```

```shql
FROM customers
SELECT name, email, created_at
```

Computed projections use `AS`:

```shql
FROM orders
SELECT _shql_id, total * 1.13 AS total_with_tax
```

### Filtering

```shql
FROM customers
WHERE status = "active" AND created_at >= $since
SELECT name, email
```

Blank values use explicit null checks:

```shql
FROM customers
WHERE score IS NULL
SELECT name
```

```shql
FROM customers
WHERE email IS NOT NULL
SELECT name, email
```

### Computed fields with `LET`

`LET` creates a value available to every later clause:

```shql
FROM orders
LET total = price * quantity
WHERE total >= 100
SELECT customer_id, total
SORT total DESC
```

Multiple bindings execute from top to bottom:

```shql
FROM orders
LET subtotal = price * quantity
LET total = subtotal * 1.13
SELECT _shql_id, subtotal, total
```

### Parameters

Parameters begin with `$` and are supplied separately from the query:

```shql
FROM customers
WHERE status = $status
SELECT name, email
```

```ts
await db.query(query, { status: "active" });
```

Parameters are values, not executable source. Missing parameters produce a validation error.

### Sorting and limiting

```shql
FROM customers
SELECT name, created_at
SORT created_at DESC, name ASC
TAKE 50 SKIP 100
```

`SORT` operates on the projected result. Give computed projections an alias before sorting them. `TAKE` limits the row count and `SKIP` (alias `OFFSET`) discards leading rows; they apply after sorting and may appear in either order. Use `SELECT DISTINCT` to remove duplicate output rows.

### Literals

```text
"text"
'text'
42
3.14
TRUE
FALSE
NULL
```

Strings accept single or double quotes. A trailing semicolon is optional.

### Operators

| Category   | Operators                     |
| ---------- | ----------------------------- |
| Logical    | `OR`, `AND`, unary `NOT`      |
| Equality   | `=`, `!=`, `<>`               |
| Ordering   | `<`, `<=`, `>`, `>=`          |
| Membership | `IN (...)`, `NOT IN (...)`    |
| Null       | `IS NULL`, `IS NOT NULL`      |
| Arithmetic | `+`, `-`, `*`, `/`, unary `-` |
| Text       | `\|\|` (concatenation)        |

Comparisons involving `null` are false except for `IS NULL` and `IS NOT NULL`. `IN` with a `null` left side is false, and an empty list matches nothing. Arithmetic requires finite numbers, and division by zero is rejected. `||` (and `CONCAT`) treat `null` as an empty string.

### Scalar functions

| Function                                | Result                                 |
| --------------------------------------- | -------------------------------------- |
| `NOW()`                                 | Current datetime                       |
| `UPPER(value)` / `LOWER(value)`         | Case conversion                        |
| `LEN(value)`                            | Text length                            |
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
SELECT UPPER(name) AS name, email
```

### Grouping and aggregation

```shql
FROM orders
WHERE status = "paid"
GROUP BY customer_id
SELECT
  customer_id,
  COUNT(*) AS orders,
  SUM(total) AS revenue,
  AVG(total) AS average_order
SORT revenue DESC
```

Supported aggregates:

- `COUNT(*)`
- `COUNT(field)`
- `SUM(field)`
- `AVG(field)`
- `MIN(field)`
- `MAX(field)`

Nulls are ignored by field aggregates. A non-aggregate projected field must appear in `GROUP BY`.

Aggregate the entire filtered table by omitting `GROUP BY`:

```shql
FROM orders
WHERE status = "paid"
SELECT COUNT(*) AS orders, SUM(total) AS revenue
```

### Joins

Joins can cross connections:

```shql
FROM orders AS o
JOIN customers AS c ON o.customer_id = c._shql_id
SELECT o._shql_id AS order_id, c.name, o.total
```

`LEFT JOIN` retains unmatched left rows. Join work currently happens in memory, so inspect the plan for large sources:

```bash
shql explain 'FROM orders AS o JOIN customers AS c ON o.customer_id = c._shql_id SELECT *'
```

### Conditional expressions

```shql
FROM customers
SELECT name, CASE
  WHEN spend >= 1000 THEN "enterprise"
  WHEN spend >= 250 THEN "growth"
  ELSE "standard"
END AS segment
```

### Views

Views provide reusable, read-only queries in a schema:

```shql
VIEW active_customers AS {
  FROM customers
  WHERE status = "active"
  SELECT _shql_id, name, email
}
```

```shql
FROM active_customers
SELECT name, email
```

## Writing data

Mutations require a typed table. Google writes are applied using the declared schema column order.

### Insert

```shql
INSERT INTO customers {
  name: $name,
  email: $email,
  status: "active",
  created_at: NOW()
}
RETURNING _shql_id, _shql_version, name
```

SHQL generates `_shql_id`, initializes `_shql_version`, validates every field, and appends the record.

### Batch insert

```shql
INSERT INTO customers [
  {
    name: "Ada",
    email: "ada@example.com",
    status: "active",
    created_at: NOW()
  },
  {
    name: "Lin",
    email: "lin@example.com",
    status: "active",
    created_at: NOW()
  }
]
RETURNING _shql_id, name
```

The Google adapter sends the rows together rather than making one request per record.

### Update

```shql
FROM customers
WHERE _shql_id = $id
UPDATE {
  status: "inactive"
}
RETURNING _shql_id, _shql_version, status
```

`UPDATE` always requires `WHERE`. An update without a filter is rejected.

### Delete

```shql
FROM customers
WHERE _shql_id = $id
DELETE
RETURNING _shql_id
```

`DELETE` always requires `WHERE`. Deleting a record deletes its physical spreadsheet row.

### Upsert

```shql
UPSERT INTO customers
KEY email
VALUE {
  email: $email,
  name: $name,
  status: $status,
  created_at: NOW()
}
RETURNING _shql_id, email
```

SHQL updates the unique matching record or inserts a new one. The value object must include the key. Multiple existing matches produce `CONFLICT`.

## Language outline

The following is an informal grammar for the public v1 syntax:

```text
select  := FROM table [AS alias]
           [JOIN | LEFT JOIN table [AS alias] ON expression]...
           [LET name = expression]...
           [WHERE expression]
           [GROUP BY expression [, expression]...]
           SELECT [DISTINCT] projection [, projection]...
           [HAVING expression]
           [SORT expression [ASC | DESC] [, ...]]
           [TAKE integer] [SKIP integer]

insert  := INSERT INTO table object-or-array [RETURNING projection-list]

update  := FROM table [LET ...] WHERE expression
           UPDATE object [RETURNING projection-list]

delete  := FROM table [LET ...] WHERE expression
           DELETE [RETURNING projection-list]

upsert  := UPSERT INTO table KEY field VALUE object
           [RETURNING projection-list]
```

Nested queries and multi-system transactions are intentionally outside the current language.

## Company data operations

SHQL's platform APIs turn queries into repeatable company workflows.

### Transform, materialize, and sync

```ts
import { materialize, sync, transform } from "@shql/core";

const report = await transform(
  db,
  `
  FROM orders
  WHERE status = "paid"
  GROUP BY customer_id
  SELECT customer_id, SUM(total) AS revenue
`,
);

await materialize(db, reportQuery, "customer_revenue", {
  mode: "replace",
  dryRun: false,
});

await sync(db, "crm_customers", "sheet_customers", "email");
```

Materialization modes are `append`, `replace`, and key-based `merge`. Every materialization supports a dry run with a ten-row preview.

### Query plans

```ts
const plan = db.explain(query);
```

Plans expose source reads, joins, filters, grouping, sorting, limits, and cost warnings. The CLI equivalent is `shql explain`.

### Jobs and scheduling

```ts
import { JobRunner } from "@shql/core";

const jobs = new JobRunner();

jobs.register({
  name: "refresh-revenue",
  every: "1h",
  retries: 3,
  timeoutMs: 60_000,
  run: async ({ signal }) => {
    if (signal.aborted) return;
    await materialize(db, revenueQuery, "revenue", { mode: "replace" });
  },
});

jobs.start();
```

Job history is persisted, retries use backoff, timeouts use abort signals, and manual runs receive stable run IDs.

### HTTP server

```ts
import { createShqlServer, listen } from "@shql/core";

const server = createShqlServer(db, {
  token: process.env.SHQL_SERVER_TOKEN,
  allowMutations: false,
  allowedTables: ["customers", "orders"],
  rateLimitPerMinute: 120,
});

await listen(server, { port: 4545 });
```

The service exposes health, schema, tables, query, explain, and job-run endpoints. It includes bearer authentication, table allowlists, mutation controls, body limits, and per-address rate limiting.

### Governance and audit logs

```ts
import { Governance, JsonlAuditSink, connect } from "@shql/core";

const governance = new Governance(
  {
    analyst: [
      {
        table: "customers",
        operations: ["select"],
        maskedColumns: ["email"],
      },
    ],
  },
  new JsonlAuditSink("./audit/shql.jsonl"),
);

const db = await connect({
  schema: "./database.shql",
  auth,
  governance,
  context: { actor: "analyst@example.com", role: "analyst" },
});
```

Authorization is checked before execution. Masked fields are redacted from results, and successful or failed operations generate audit events.

### Migrations, backups, and restoration

```ts
import { MigrationRunner, backupTable, restoreTable } from "@shql/core";

const migrations = new MigrationRunner(db, [
  {
    id: "001_initialize_customers",
    up: async (database) => database.initialize("customers"),
  },
]);

await migrations.apply();
await backupTable(db, "customers", "./backups/customers.json");
await restoreTable(db, "customers", "./backups/customers.json");
```

Migration state is durable, ordered, and optionally reversible.

### Generated TypeScript types

```bash
shql generate types --out src/shql.generated.d.ts
```

```ts
import { generateTypes, writeTypes } from "@shql/core";
```

The generated interfaces reflect table names, field types, and nullability.

## Node API

### `connect(options)`

```ts
const db = await connect({
  schema: "./database.shql",
  auth: {
    type: "access-token",
    accessToken,
  },
});
```

Options:

| Option    | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| `schema`  | Schema filepath or parsed `DatabaseSchema`               |
| `auth`    | Google service-account or access-token authentication    |
| `adapter` | Custom `TableAdapter`, commonly `MemoryAdapter` in tests |
| `env`     | Environment values used to resolve schema variables      |
| `fetch`   | Optional Fetch API implementation                        |

### `db.query(source, parameters?)`

```ts
const result = await db.query(`FROM customers WHERE status = $status SELECT name, email`, {
  status: "active",
});
```

```ts
interface QueryResult {
  operation: "select" | "insert" | "update" | "delete" | "upsert";
  rows: Record<string, Scalar>[];
  affectedRows: number;
  columns: string[];
}
```

Dates are returned as JavaScript `Date` instances and serialize to ISO strings in JSON.

### Metadata and diagnostics

```ts
db.tables();
db.describe("customers");

await db.inspect();
await db.validate();
await db.initialize("customers");
await db.doctor();
```

- `inspect` reads headers, row counts, and inferred column types.
- `validate` compares physical tabs with the schema.
- `initialize` writes the declared headers to an empty tab.
- `doctor` verifies authentication and spreadsheet access.

### In-memory testing

```ts
import { connect, MemoryAdapter, parseSchema } from "@shql/core";

const schema = parseSchema(
  `
    SHEET test
    TABLE customers FROM #1 {
      _shql_id: id
      _shql_version: number
      name: text
    }
  `,
);

const adapter = new MemoryAdapter({
  customers: [
    {
      _shql_id: "customer_1",
      _shql_version: 1,
      name: "Ada",
    },
  ],
});

const db = await connect({ schema, adapter });
const result = await db.query("FROM customers SELECT *");
```

## CLI

```bash
shql tables --schema database.shql
shql describe customers --schema database.shql
shql doctor --schema database.shql
shql inspect customers --schema database.shql
shql validate --schema database.shql
shql init customers --schema database.shql
shql explain 'FROM customers SELECT *'
shql materialize 'FROM orders SELECT *' --into order_export --mode replace --dry-run
shql generate types --out src/shql.generated.d.ts
shql backup customers --out backups/customers.json
shql restore customers --file backups/customers.json
SHQL_SERVER_TOKEN=secret shql serve --port 4545
```

Execute a query directly:

```bash
shql query 'FROM customers SELECT * TAKE 10' \
  --schema database.shql
```

Supply parameters as JSON:

```bash
shql query 'FROM customers WHERE status = $status SELECT *' \
  --params '{"status":"active"}'
```

Or read the query from a file:

```bash
shql query --file ./queries/active-customers.shql
```

Use `--json` for compact output. `validate` exits with status `2` when it discovers an operational issue.

## Safety and concurrency

SHQL adds guardrails around a storage system that was not designed as a database:

- Typed writes require the physical header row to exactly match the schema.
- Unknown columns and invalid values are rejected.
- `UPDATE` and `DELETE` require `WHERE`.
- IDs are immutable and must be unique.
- Compact inferred tables are read-only.
- `_shql_version` detects ordinary stale updates and deletes.
- Transient Google `429`, `500`, `502`, `503`, and `504` responses are retried with backoff and jitter.

Google Sheets does not expose an atomic compare-and-swap operation. Version verification and writing are separate requests, leaving a small race window. SHQL is not suitable for financial records, high-contention workloads, or anything requiring database transactions.

SHQL currently fetches a whole tab before filtering. Thousands to low tens of thousands of rows are its natural operating range; exact limits depend on row width, query complexity, Google quotas, and workload frequency.

## Errors

Expected failures use `ShqlError`:

```ts
import { ShqlError } from "@shql/core";

try {
  await db.query(query, parameters);
} catch (error) {
  if (error instanceof ShqlError) {
    console.error(error.code, error.message, error.details);
  }
}
```

| Code               | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| `SCHEMA_ERROR`     | Invalid schema or missing environment value        |
| `QUERY_ERROR`      | Invalid SHQL syntax                                |
| `VALIDATION_ERROR` | Invalid field, type, parameter, or unsafe mutation |
| `AUTH_ERROR`       | Google authentication failure                      |
| `ADAPTER_ERROR`    | Google API, tab layout, or adapter failure         |
| `CONFLICT`         | Stale version, duplicate ID/key, or missing target |

## Development

```bash
npm install
npm run ci
```

The complete CI command runs static type checking, ESLint, formatting verification, tests, and the production build.

Useful commands:

```bash
npm test
npm run typecheck
npm run lint
npm run format
npm run build
npm run check
```

Run the optional live Google integration test after configuring credentials:

```bash
SHQL_SCHEMA=examples/database.shql npm run test:integration
```

The GitHub workflows test Node 20, 22, and 24, provide a manually triggered Google integration run, and publish tagged releases to npm with provenance.

## Documentation and roadmap

This README is the language and usage guide. [DOCS.md](./DOCS.md) contains additional operational details, Google behavior, packaging instructions, and the release roadmap.

The v1 candidate includes named connections, cross-source joins, OAuth refresh tokens, TextMate editor grammar, HTTP serving, jobs, governance, migrations, and data pipelines. Remaining hardening work is centered on atomic coordination for Google writes, dedicated database-driver packages, richer lineage storage, and a full language server.

## License

MIT
