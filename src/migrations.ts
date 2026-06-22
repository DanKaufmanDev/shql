import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ShqlDatabase } from "./database.ts";
import type { Row } from "./types.ts";

export interface Migration {
  id: string;
  up(db: ShqlDatabase): Promise<void>;
  down?(db: ShqlDatabase): Promise<void>;
}

interface MigrationState {
  applied: Array<{ id: string; appliedAt: string }>;
}

export class MigrationRunner {
  private readonly db: ShqlDatabase;
  private readonly migrations: Migration[];
  private readonly statePath: string;

  constructor(db: ShqlDatabase, migrations: Migration[], statePath = ".shql/migrations.json") {
    this.db = db;
    this.migrations = migrations;
    this.statePath = statePath;
  }

  private async state(): Promise<MigrationState> {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8")) as MigrationState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { applied: [] };
      throw error;
    }
  }

  private async save(state: MigrationState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async status(): Promise<Array<{ id: string; status: "applied" | "pending"; appliedAt?: string }>> {
    const state = await this.state();
    const applied = new Map(state.applied.map((entry) => [entry.id, entry.appliedAt]));
    return this.migrations.map((migration) => ({
      id: migration.id,
      status: applied.has(migration.id) ? "applied" : "pending",
      appliedAt: applied.get(migration.id),
    }));
  }

  async apply(): Promise<string[]> {
    const state = await this.state();
    const applied = new Set(state.applied.map((entry) => entry.id));
    const completed: string[] = [];
    for (const migration of this.migrations) {
      if (applied.has(migration.id)) continue;
      await migration.up(this.db);
      state.applied.push({ id: migration.id, appliedAt: new Date().toISOString() });
      await this.save(state);
      completed.push(migration.id);
    }
    return completed;
  }

  async rollback(): Promise<string | undefined> {
    const state = await this.state();
    const latest = state.applied.at(-1);
    if (!latest) return undefined;
    const migration = this.migrations.find((candidate) => candidate.id === latest.id);
    if (!migration?.down) throw new Error(`Migration ${latest.id} is not reversible.`);
    await migration.down(this.db);
    state.applied.pop();
    await this.save(state);
    return latest.id;
  }
}

export async function backupTable(db: ShqlDatabase, tableName: string, path: string): Promise<number> {
  const table = db.describe(tableName);
  const rows = (await db.adapter(tableName).read(table)).map((row) => row.values);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ table: tableName, createdAt: new Date().toISOString(), rows }, null, 2)}\n`,
    "utf8",
  );
  return rows.length;
}

export async function restoreTable(db: ShqlDatabase, tableName: string, path: string): Promise<number> {
  const document = JSON.parse(await readFile(path, "utf8")) as { rows: Row[] };
  const table = db.describe(tableName);
  const adapter = db.adapter(tableName);
  const existing = await adapter.read(table);
  await adapter.delete(table, existing);
  await adapter.append(table, document.rows);
  return document.rows.length;
}
