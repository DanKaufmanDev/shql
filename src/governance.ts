import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ShqlError } from "./errors.ts";
import type { Query } from "./query.ts";
import type { QueryResult, Row } from "./types.ts";

export type Operation = Query["operation"];

export interface AccessRule {
  table: string;
  operations: Operation[];
  maskedColumns?: string[];
}

export interface GovernanceContext {
  actor: string;
  role: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  role: string;
  operation: Operation;
  table: string;
  affectedRows: number;
  success: boolean;
  error?: string;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export class JsonlAuditSink implements AuditSink {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async write(event: AuditEvent): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class Governance {
  private readonly rules: Record<string, AccessRule[]>;
  private readonly sink?: AuditSink;
  constructor(rules: Record<string, AccessRule[]>, sink?: AuditSink) {
    this.rules = rules;
    this.sink = sink;
  }

  authorize(query: Query, context: GovernanceContext): void {
    const rules = this.rules[context.role] ?? [];
    const allowed = rules.some(
      (rule) =>
        (rule.table === "*" || rule.table === query.table) && rule.operations.includes(query.operation),
    );
    if (!allowed)
      throw new ShqlError("AUTH_ERROR", `${context.role} cannot ${query.operation} ${query.table}.`);
  }

  mask(result: QueryResult, query: Query, context: GovernanceContext): QueryResult {
    const columns = new Set(
      (this.rules[context.role] ?? [])
        .filter((rule) => rule.table === "*" || rule.table === query.table)
        .flatMap((rule) => rule.maskedColumns ?? []),
    );
    if (!columns.size) return result;
    const rows = result.rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([name, value]) => [name, columns.has(name) ? "***" : value]),
        ) as Row,
    );
    return { ...result, rows };
  }

  async audit(
    query: Query,
    context: GovernanceContext,
    result?: QueryResult,
    error?: unknown,
  ): Promise<void> {
    if (!this.sink) return;
    await this.sink.write({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: context.actor,
      role: context.role,
      operation: query.operation,
      table: query.table,
      affectedRows: result?.affectedRows ?? 0,
      success: !error,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
    });
  }
}
