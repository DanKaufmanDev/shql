import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Governance,
  GoogleSheetsAdapter,
  HttpAdapter,
  JobRunner,
  MemoryAdapter,
  MemoryAuditSink,
  MigrationRunner,
  SqlAdapter,
  backupTable,
  connect,
  createShqlServer,
  generateTypes,
  listen,
  materialize,
  parseSchema,
  restoreTable,
} from "../src/index.ts";

function constrainedSchema() {
  return parseSchema(`
    SHEET test
    TABLE people FROM #people {
      _shql_id: id
      _shql_version: number
      email: text UNIQUE MATCHES EMAIL
      status: text IN ["active", "inactive"] DEFAULT "active"
      score: number? >= 0 <= 100
      created_at: datetime DEFAULT NOW()
    }

    VIEW active_people AS {
      FROM people
      WHERE status = "active"
      SELECT email, status
    }
  `);
}

test("enforces constraints, applies defaults and queries views", async () => {
  const schema = constrainedSchema();
  const db = await connect({ schema, adapter: new MemoryAdapter() });
  const inserted = await db.query(`INSERT INTO people { email: "ada@example.com", score: 90 } RETURNING *`);
  assert.equal(inserted.rows[0].status, "active");
  assert.equal(inserted.rows[0]._shql_version, 1);
  assert.ok(inserted.rows[0].created_at instanceof Date);
  assert.deepEqual((await db.query(`FROM active_people SELECT email`)).rows, [{ email: "ada@example.com" }]);
  await assert.rejects(db.query(`INSERT INTO people { email: "bad", score: 2 }`), /required pattern/);
  await assert.rejects(
    db.query(`INSERT INTO people { email: "ada@example.com", score: 101 }`),
    /must be <= 100/,
  );
  await assert.rejects(
    db.query(`INSERT INTO people { email: "ada@example.com", score: 2 }`),
    /Duplicate unique/,
  );
});

test("reads and writes JSON/CSV connections and materializes data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-v1-connectors-"));
  const jsonPath = join(directory, "data.json");
  await writeFile(
    jsonPath,
    JSON.stringify({ source: [{ _shql_id: "s1", name: "Ada", amount: 42 }], target: [] }),
  );
  await writeFile(join(directory, "people.csv"), "_shql_id,name,amount\nc1,Lin,12\n", "utf8");
  const schema = parseSchema(`
    CONNECTION files FROM JSON "${jsonPath}"
    CONNECTION csvfiles FROM CSV "${directory}"
    TABLE source FROM files.#source {
      _shql_id: id
      name: text
      amount: number
    }
    TABLE target FROM files.#target {
      _shql_id: id
      _shql_version: number
      name: text
      amount: number
    }
    TABLE csv_people FROM csvfiles.#people {
      _shql_id: id
      name: text
      amount: number
    }
  `);
  const db = await connect({ schema });
  assert.deepEqual((await db.query(`FROM csv_people WHERE amount > 10 SELECT name`)).rows, [{ name: "Lin" }]);
  const preview = await materialize(db, `FROM source SELECT name, amount`, "target", { dryRun: true });
  assert.equal(preview.writtenRows, 0);
  const result = await materialize(db, `FROM source SELECT name, amount`, "target", { mode: "append" });
  assert.equal(result.writtenRows, 1);
  assert.deepEqual((await db.query(`FROM target SELECT name, amount`)).rows, [{ name: "Ada", amount: 42 }]);
});

test("applies governance rules, masks columns and records audit events", async () => {
  const schema = constrainedSchema();
  const adapter = new MemoryAdapter({
    people: [
      {
        _shql_id: "p1",
        _shql_version: 1,
        email: "ada@example.com",
        status: "active",
        score: 1,
        created_at: new Date(),
      },
    ],
  });
  const audit = new MemoryAuditSink();
  const governance = new Governance(
    { analyst: [{ table: "people", operations: ["select"], maskedColumns: ["email"] }] },
    audit,
  );
  const db = await connect({
    schema,
    adapter,
    governance,
    context: { actor: "analyst@example.com", role: "analyst" },
  });
  assert.deepEqual((await db.query(`FROM people SELECT email`)).rows, [{ email: "***" }]);
  await assert.rejects(db.query(`FROM people WHERE _shql_id = "p1" DELETE`), /cannot delete/);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].actor, "analyst@example.com");
});

test("runs migrations, backups, restores, jobs and type generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shql-v1-ops-"));
  const schema = constrainedSchema();
  const adapter = new MemoryAdapter({
    people: [
      {
        _shql_id: "p1",
        _shql_version: 1,
        email: "ada@example.com",
        status: "active",
        score: 1,
        created_at: new Date(),
      },
    ],
  });
  const db = await connect({ schema, adapter });
  const migrationPath = join(directory, "migrations.json");
  let migrated = false;
  const migrations = new MigrationRunner(
    db,
    [
      {
        id: "001",
        up: async () => {
          migrated = true;
        },
        down: async () => {
          migrated = false;
        },
      },
    ],
    migrationPath,
  );
  assert.deepEqual(await migrations.apply(), ["001"]);
  assert.equal(migrated, true);
  assert.equal(await migrations.rollback(), "001");
  assert.equal(migrated, false);

  const backup = join(directory, "people.json");
  assert.equal(await backupTable(db, "people", backup), 1);
  await db.query(`FROM people WHERE _shql_id = "p1" DELETE`);
  assert.equal(await restoreTable(db, "people", backup), 1);

  const runner = new JobRunner(join(directory, "jobs.json"));
  runner.register({ name: "refresh", retries: 1, run: async () => db.query(`FROM people SELECT *`) });
  assert.equal((await runner.run("refresh")).status, "succeeded");
  assert.equal(runner.history("refresh").length, 1);
  assert.match(generateTypes(schema), /interface People/);
  assert.match(await readFile(migrationPath, "utf8"), /"applied": \[\]/);
});

test("serves authenticated query and explain endpoints", async (context) => {
  const schema = constrainedSchema();
  const db = await connect({
    schema,
    adapter: new MemoryAdapter({
      people: [
        {
          _shql_id: "p1",
          _shql_version: 1,
          email: "ada@example.com",
          status: "active",
          score: 1,
          created_at: new Date(),
        },
      ],
    }),
  });
  const server = createShqlServer(db, { token: "secret", allowedTables: ["people"] });
  let address: Awaited<ReturnType<typeof listen>>;
  try {
    address = await listen(server, { port: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("The execution sandbox does not permit local sockets.");
      return;
    }
    throw error;
  }
  try {
    const unauthorized = await fetch(`http://${address.hostname}:${address.port}/v1/tables`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`http://${address.hostname}:${address.port}/v1/query`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ query: "FROM people SELECT email" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { rows: unknown[] }).rows, [{ email: "ada@example.com" }]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("supports HTTP, SQL, OAuth refresh and mutation previews", async () => {
  const httpRequests: Array<{ url: string; method: string }> = [];
  const http = new HttpAdapter("https://example.test/api", async (input, init) => {
    httpRequests.push({ url: String(input), method: init?.method ?? "GET" });
    const body =
      init?.method === "POST"
        ? { rows: [{ _shql_id: "h2", name: "Lin" }] }
        : [{ _shql_id: "h1", name: "Ada" }];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const table = parseSchema(
    `SHEET test\nTABLE people FROM #people {\n_shql_id: id\nname: text\n}`,
  ).tables.get("people")!;
  assert.equal((await http.read(table))[0].values.name, "Ada");
  assert.equal((await http.append(table, [{ _shql_id: "h2", name: "Lin" }]))[0].values.name, "Lin");
  assert.deepEqual(
    httpRequests.map((request) => request.method),
    ["GET", "POST"],
  );

  const statements: string[] = [];
  const sql = new SqlAdapter({
    query: async (statement) => {
      statements.push(statement);
      return { rows: statement.startsWith("SELECT") ? [{ _shql_id: "s1", name: "SQL" }] : [], rowCount: 1 };
    },
  });
  assert.equal((await sql.read(table))[0].values.name, "SQL");
  await sql.append(table, [{ _shql_id: "s2", name: "Insert" }]);
  assert.match(statements[1], /^INSERT INTO/);

  let oauthCalls = 0;
  const oauth = new GoogleSheetsAdapter(
    "sheet",
    { type: "oauth", clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
    async (input) => {
      oauthCalls++;
      const token = String(input).includes("oauth2.googleapis.com");
      return new Response(
        JSON.stringify(
          token
            ? { access_token: "token", expires_in: 3600 }
            : { spreadsheetId: "sheet", properties: { title: "OAuth" } },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  assert.equal((await oauth.doctor()).ok, true);
  assert.equal(oauthCalls, 2);

  const schema = constrainedSchema();
  const db = await connect({
    schema,
    adapter: new MemoryAdapter({
      people: [
        {
          _shql_id: "p1",
          _shql_version: 1,
          email: "ada@example.com",
          status: "active",
          score: 1,
          created_at: new Date(),
        },
      ],
    }),
  });
  const preview = await db.preview(`FROM people WHERE status = "active" UPDATE { status: "inactive" }`);
  assert.equal(preview.affectedRows, 1);
  assert.equal((await db.query(`FROM people SELECT status`)).rows[0].status, "active");
});
