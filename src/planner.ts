import { parseQuery, type Query } from "./query.ts";
import type { DatabaseSchema } from "./types.ts";

export interface PlanStep {
  operation: string;
  source?: string;
  detail: string;
  warning?: string;
}

export interface QueryPlan {
  operation: Query["operation"];
  tables: string[];
  steps: PlanStep[];
  warnings: string[];
}

export function explainQuery(source: string | Query, schema: DatabaseSchema): QueryPlan {
  const query = typeof source === "string" ? parseQuery(source) : source;
  const steps: PlanStep[] = [];
  const warnings: string[] = [];
  const base = schema.tables.get(query.table);
  steps.push({
    operation: "read",
    source: query.table,
    detail: `Read the complete ${query.table} table from ${base?.connection ?? "unknown"}.`,
  });
  const tables = [query.table];
  if ("joins" in query) {
    for (const join of query.joins) {
      tables.push(join.table);
      steps.push({
        operation: `${join.type}-join`,
        source: join.table,
        detail: `Read ${join.table} and evaluate the join condition in memory.`,
        warning: "Join cost grows with the product of input row counts.",
      });
      warnings.push(`JOIN ${join.table} is evaluated in memory.`);
    }
    if (query.lets.length)
      steps.push({ operation: "compute", detail: `Evaluate ${query.lets.length} LET binding(s).` });
    if (query.where) steps.push({ operation: "filter", detail: "Evaluate WHERE for each candidate row." });
  }
  if (query.operation === "select") {
    if (query.groupBy.length)
      steps.push({ operation: "group", detail: `Group by ${query.groupBy.length} expression(s).` });
    if (query.having) steps.push({ operation: "having", detail: "Filter groups by the HAVING condition." });
    steps.push({
      operation: "project",
      detail: `Produce ${query.distinct ? "distinct " : ""}${query.select.length} projection(s).`,
    });
    if (query.sort.length) {
      steps.push({ operation: "sort", detail: `Sort by ${query.sort.length} expression(s) in memory.` });
      warnings.push("SORT materializes all matching rows before TAKE is applied.");
    }
    if (query.skip !== undefined)
      steps.push({ operation: "skip", detail: `Skip the first ${query.skip} row(s).` });
    if (query.take !== undefined)
      steps.push({ operation: "take", detail: `Return at most ${query.take} row(s).` });
  } else {
    steps.push({
      operation: query.operation,
      detail: `Validate and execute ${query.operation.toUpperCase()}.`,
    });
  }
  warnings.unshift("SHQL currently reads complete source tables before filtering.");
  return { operation: query.operation, tables, steps, warnings };
}
