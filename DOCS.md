# SHQL documentation

SHQL means **Sheets Query Language**. It presents a Google spreadsheet as a small database:

- A spreadsheet is a database.
- Each tab is a table.
- Row 1 contains column names.
- Rows 2 onward contain records.
- A `.shql` schema binds stable SHQL names to Google spreadsheet and tab IDs.
- Queries execute as a top-to-bottom data pipeline.

This repository contains the production-oriented v1 candidate. It is a data operations language for Sheets, files, APIs, and databases. The published package has no runtime dependencies and targets Node.js 20.11 or newer. TypeScript is compiled to standard ESM JavaScript with declaration files and source maps.

## Status and scope

Implemented:

- Typed and compact schema declarations
- Environment-variable substitution
- `FROM`, `LET`, `WHERE`, `GROUP BY`, `SELECT`, `SORT`, and `TAKE`
- Object-style `INSERT` and `UPDATE`
- Guarded `DELETE`
- Named parameters
- Scalar functions and aggregate functions
- Google service-account and access-token authentication
- Google Sheets and in-memory adapters
- Node API and CLI
- Structured errors and mutation safety checks
- Batch inserts and key-based upserts
- Managed `_shql_version` values and stale-write detection
- `validate`, `inspect`, `init`, and `doctor` operations
- Retry handling for rate limits and transient Google failures
- Compiled Node distribution, linting, formatting, CI, and npm release automation

Not yet fully implemented:

- Transactions
- Formula-aware values
- Full schema migrations or automatic tab creation

SHQL is intended for internal tools, prototypes, operational workflows, lightweight content stores, and modest datasets. It is not a replacement for a transactional database.

## Requirements

- Node.js 20.11 or newer
- A Google Cloud project with the Google Sheets API enabled
- A Google service account or an OAuth access token
- A spreadsheet shared with the authenticated identity

## Installing from npm

Install SHQL in a Node project:

```bash
npm install shql
```

Or install the CLI globally:

```bash
npm install --global shql
shql --help
```

## Spreadsheet preparation

Create a tab with headers in its first row. For a typed table, the physical headers must have the same names and order as the schema:

| \_shql_id | \_shql_version | name | email           | status | created_at               |
| --------- | -------------: | ---- | --------------- | ------ | ------------------------ |
| 89cf...   |              1 | Ada  | ada@example.com | active | 2026-01-05T14:00:00.000Z |

Use a dedicated `id` column such as `_shql_id`. SHQL generates a UUID when inserting a record whose `id` value is omitted. Existing rows must be assigned unique IDs by the application or spreadsheet owner.

For tables that can be mutated, declare `_shql_version: number`. New records begin at version `1`, and each SHQL update increments the version. Applications cannot assign this field directly.

The spreadsheet ID is the value between `/d/` and `/edit` in a Google Sheets URL. The numeric tab ID is the `gid` query parameter:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=TAB_ID
```

IDs locate Google resources but are not authentication secrets.

## Schema files

The default schema filename used by the CLI is `database.shql`.

### Typed declarations

Typed declarations are required for writes:

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
```

`${GOOGLE_SHEETS_ID}` and `#{CUSTOMERS_TAB_ID}` resolve from environment variables. Literal IDs are also accepted:

```shql
SHEET 1AbCdEf

TABLE customers FROM #123456789 {
  _shql_id: id
  _shql_version: number
  name: text
}
```

The name after `TABLE` is the stable SHQL table name. Renaming the physical Google tab does not break the schema because the numeric tab ID remains stable.

### Compact declarations

Compact declarations infer all headers as nullable text and are read-only:

```shql
[${GOOGLE_SHEETS_ID}]
[#{CUSTOMERS_TAB_ID} AS customers]
[#{ORDERS_TAB_ID} AS orders]
```

This form is useful for exploration. Convert a compact table to a typed declaration before inserting, updating, or deleting data.

### Types

| Type       | Runtime value | Meaning                                                  |
| ---------- | ------------- | -------------------------------------------------------- |
| `id`       | `string`      | Stable record identity; generated on insert when omitted |
| `text`     | `string`      | Text value                                               |
| `number`   | `number`      | Finite JavaScript number                                 |
| `boolean`  | `boolean`     | `true` or `false`                                        |
| `date`     | `Date`        | Date value                                               |
| `datetime` | `Date`        | Date and time value                                      |

Append `?` to make a field nullable:

```shql
score: number?
```

Blank cells are represented as `null`. Non-nullable blank cells are accepted during reads so existing untidy sheets can be inspected, but inserts and updates validate declared nullability.

Schema validation rejects unknown types, duplicate tables, duplicate columns, missing environment variables, and tables with more than one `id` column.

## Authentication

### Service account

Create a Google service account, enable the Sheets API, download its JSON credentials, and share the spreadsheet with the service account's `client_email`.

The CLI accepts the full credentials document:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
```

It also accepts separate values:

```bash
export GOOGLE_CLIENT_EMAIL='service-account@example.iam.gserviceaccount.com'
export GOOGLE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n'
```

Never commit service-account credentials or `.env` files. The repository ignores `.env` by default.

### Access token

For short-lived sessions:

```bash
export GOOGLE_ACCESS_TOKEN='ya29...'
```

The caller is responsible for refreshing an access token. The service-account adapter obtains and caches tokens automatically.

### Node API authentication

```ts
import { connect } from "shql";

const db = await connect({
  schema: "./database.shql",
  auth: {
    type: "service-account",
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL!,
    privateKey: process.env.GOOGLE_PRIVATE_KEY!.replaceAll("\\n", "\n"),
  },
});
```

An existing token can be supplied instead:

```ts
const db = await connect({
  schema: "./database.shql",
  auth: { type: "access-token", accessToken },
});
```

## Query language

Clauses execute in written order. The canonical select pipeline is:

```text
FROM → LET → WHERE → GROUP BY → SELECT → SORT → TAKE
```

Keywords are case-insensitive. Identifiers are case-sensitive.

### Selecting rows

```shql
FROM customers
SELECT *
```

```shql
FROM customers
WHERE status = "active"
SELECT name, email
SORT name ASC
TAKE 20
```

`SORT` operates on projected output fields. Give computed projections an alias before sorting them.

### Computed values

`LET` adds a value for subsequent clauses without changing the sheet:

```shql
FROM orders
LET total = price * quantity
WHERE total >= 100
SELECT customer_id, total
SORT total DESC
```

### Parameters

Parameters begin with `$`:

```shql
FROM customers
WHERE status = $status
SELECT name, email
```

```ts
const result = await db.query(query, { status: "active" });
```

Missing parameters produce a `VALIDATION_ERROR`. Parameters are data and are never parsed as SHQL, preventing query injection through values.

### Expressions and operators

Supported operators, from lower to higher precedence:

| Category   | Operators                                                       |
| ---------- | --------------------------------------------------------------- |
| Logical    | `OR`, `AND`, unary `NOT`                                        |
| Comparison | `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `IS NULL`, `IS NOT NULL` |
| Arithmetic | `+`, `-`, `*`, `/`, unary `-`                                   |

Comparisons involving `null` are false except `IS NULL` and `IS NOT NULL`. Division by zero and non-numeric arithmetic produce validation errors.

Literals include quoted strings, finite numbers, `TRUE`, `FALSE`, and `NULL`.

### Scalar functions

| Function                    | Result                 |
| --------------------------- | ---------------------- |
| `NOW()`                     | Current datetime       |
| `UPPER(value)`              | Uppercase text         |
| `LOWER(value)`              | Lowercase text         |
| `LEN(value)`                | Text length            |
| `TEXT(value)`               | Text conversion        |
| `NUMBER(value)`             | Number conversion      |
| `DATE(value)`               | Date conversion        |
| `DATETIME(value)`           | Datetime conversion    |
| `COALESCE(a, b, ...)`       | First non-null value   |
| `CONTAINS(text, part)`      | Boolean substring test |
| `STARTS_WITH(text, prefix)` | Boolean prefix test    |
| `ENDS_WITH(text, suffix)`   | Boolean suffix test    |

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

Supported aggregate functions are `COUNT`, `SUM`, `AVG`, `MIN`, and `MAX`. `COUNT(*)` counts all rows; `COUNT(field)` ignores nulls. Other aggregates also ignore null values.

An aggregate query without `GROUP BY` creates one group:

```shql
FROM orders
SELECT COUNT(*) AS orders, SUM(total) AS revenue
```

### Inserting records

```shql
INSERT INTO customers {
  name: $name,
  email: $email,
  status: "active",
  created_at: NOW()
}
RETURNING _shql_id, name, created_at
```

The adapter appends a row. Omitted `id` fields receive a UUID. Other non-nullable columns are required. Unknown columns are rejected.

Insert several records in one Google request:

```shql
INSERT INTO customers [
  { name: "Ada", email: "ada@example.com", status: "active", created_at: NOW() },
  { name: "Lin", email: "lin@example.com", status: "active", created_at: NOW() }
]
RETURNING _shql_id, name
```

### Upserting records

`UPSERT` updates the unique matching record or appends a new record:

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

The value object must include the key. More than one existing match produces `CONFLICT`. On the insertion path, all non-nullable fields are required.

### Updating records

```shql
FROM customers
WHERE _shql_id = $id
UPDATE {
  status: "inactive"
}
RETURNING _shql_id, status
```

`UPDATE` requires `WHERE`. The `id` column is immutable. SHQL rejects an update without a filter rather than risking an accidental whole-tab write.

### Deleting records

```shql
FROM customers
WHERE _shql_id = $id
DELETE
RETURNING _shql_id
```

`DELETE` requires `WHERE`. Google row deletion is executed from the highest row number downward so earlier deletions do not shift later targets.

## Node API

### `connect(options)`

```ts
const db = await connect({
  schema: "./database.shql",
  auth,
  env: process.env,
});
```

Options:

- `schema`: schema filepath or a parsed `DatabaseSchema`
- `auth`: Google authentication when no custom adapter is supplied
- `adapter`: custom implementation of `TableAdapter`
- `env`: values used to resolve schema variables
- `fetch`: optional Fetch API implementation, useful for tests or controlled networking

### `db.query(source, parameters?)`

Returns:

```ts
interface QueryResult {
  operation: "select" | "insert" | "update" | "delete" | "upsert";
  rows: Record<string, Scalar>[];
  affectedRows: number;
  columns: string[];
}
```

Dates are returned as JavaScript `Date` instances. JSON serialization turns them into ISO timestamps.

### Metadata

```ts
db.tables();
db.describe("customers");
await db.inspect();
await db.validate();
await db.initialize("customers");
await db.doctor();
```

### In-memory adapter

Use the in-memory adapter for tests and local logic without Google credentials:

```ts
import { connect, MemoryAdapter, parseSchema } from "shql";

const schema = parseSchema(schemaText, {
  GOOGLE_SHEETS_ID: "test",
  CUSTOMERS_TAB_ID: "1",
});

const adapter = new MemoryAdapter({
  customers: [
    {
      _shql_id: "customer-1",
      _shql_version: 1,
      name: "Ada",
      email: "ada@example.com",
      status: "active",
      created_at: new Date(),
    },
  ],
});

const db = await connect({ schema, adapter });
const result = await db.query("FROM customers SELECT *");
```

Custom adapters implement `read`, `append`, `update`, and `delete` from `TableAdapter`.

## CLI

```bash
shql tables --schema database.shql
shql describe customers --schema database.shql
shql doctor --schema database.shql
shql inspect customers --schema database.shql
shql validate --schema database.shql
shql init customers --schema database.shql
shql query 'FROM customers SELECT * TAKE 10'
shql query 'FROM customers WHERE status = $status SELECT *' \
  --params '{"status":"active"}'
shql query --file ./queries/active-customers.shql
```

`init` writes a typed header row only when a tab is empty; it never overwrites a different existing header. `validate` exits with code `2` when it finds an operational problem. Add `--json` for compact JSON. Errors are printed to stderr and set a non-zero process exit code.

## Errors

All expected runtime failures use `ShqlError`:

| Code               | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| `SCHEMA_ERROR`     | Invalid schema or missing schema environment value |
| `QUERY_ERROR`      | Invalid query syntax                               |
| `VALIDATION_ERROR` | Invalid field, type, parameter, or unsafe mutation |
| `AUTH_ERROR`       | Google authentication failure                      |
| `ADAPTER_ERROR`    | Google API, sheet layout, or adapter failure       |
| `CONFLICT`         | Stale version, duplicate ID/key, or missing target |

```ts
try {
  await db.query(query, parameters);
} catch (error) {
  if (error instanceof ShqlError) {
    console.error(error.code, error.message, error.details);
  }
}
```

## Mutation safety

Before writing, the Google adapter verifies that the tab's complete header row exactly matches the typed schema in both name and order. This prevents an `UPDATE` from writing values into the wrong columns after a user rearranges a tab.

`UPDATE` and `DELETE` require `WHERE`, and `id` values cannot be changed. Compact inferred tables are read-only.

When `_shql_version: number` is declared, SHQL reads the current version before an update or delete, rejects a changed version with `CONFLICT`, and increments successful updates. Duplicate or missing stable IDs are rejected.

Google Sheets does not offer an atomic compare-and-swap values operation. Version verification and writing are separate API requests, so there remains a small race window. These checks detect ordinary concurrent edits but do not make Sheets transactional. For critical or highly concurrent data, use a transactional database.

## Performance model

SHQL 0.1 reads a whole tab into memory, then filters, groups, sorts, and projects in Node. Google Sheets does not expose a general server-side query engine.

Operational recommendations:

- Keep tables modest; thousands to low tens of thousands of rows are the natural range.
- Select only required output fields, though the adapter still fetches the tab.
- Reuse a connected database so metadata and service-account tokens remain cached.
- Avoid rapid polling and respect Google API quotas.
- Transient `429`, `500`, `502`, `503`, and `504` responses are retried with exponential backoff and jitter.
- Batch application operations where possible.
- Do not expose unrestricted query endpoints to untrusted callers.

The engine has no arbitrary code execution or dynamic function loading. Still, applications should control which schemas, credentials, and mutations a caller may access.

## Google Sheets behavior

- Reads request unformatted values and formatted dates.
- Writes use `USER_ENTERED`, allowing Google to recognize dates and primitive values.
- Datetimes are written as ISO 8601 strings.
- Formulas are observed through their computed values; formula preservation is not part of 0.1.
- Empty rows are omitted from query results.
- Missing declared headers prevent reads. Extra or reordered headers may be read, but typed writes fail until the header row exactly matches the schema.
- Deleting a record deletes its physical spreadsheet row.

## Development

Run the tests:

```bash
npm test
```

Run the complete local CI suite:

```bash
npm run ci
```

Individual checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run check
```

The test suite covers schema forms, parameters, pipeline evaluation, grouping, inserts, batch inserts, upserts, updates, deletes, generated IDs, version handling, duplicate IDs, operational inspection, and mutation guards. Network-free tests use `MemoryAdapter` or mocked HTTP responses.

Run the optional live Google integration test with credentials and schema variables configured:

```bash
SHQL_SCHEMA=examples/database.shql npm run test:integration
```

Project layout:

```text
src/
  adapters/
    google-sheets.ts
    memory.ts
  cli.ts
  database.ts
  engine.ts
  errors.ts
  index.ts
  query.ts
  schema.ts
  types.ts
test/
  shql.test.ts
  google.integration.test.ts
examples/
  database.shql
```

The parser is handwritten so the grammar can evolve without a parser-generator runtime. Adapters isolate storage behavior from language semantics.

## Roadmap beyond the v1 candidate

Likely next steps:

1. Add an Apps Script or external coordinator for atomic locking where required.
2. Publish dedicated PostgreSQL, MySQL, and SQLite driver packages around `SqlAdapter`.
3. Add a complete language server on top of the bundled TextMate grammar.
4. Add durable lineage graphs and richer column-level policy evaluation.
5. Add pushdown planning and streaming for capable connectors.

Language additions should preserve the core rule: a query should be readable from top to bottom and understandable without knowing Google API details.
