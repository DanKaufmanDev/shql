import { randomUUID } from "node:crypto";
import { ShqlError, invariant } from "./errors.ts";
import { parseQuery, type Expression, type Projection, type Query } from "./query.ts";
import type {
  DatabaseSchema,
  QueryResult,
  Row,
  Scalar,
  StoredRow,
  TableAdapter,
  TableSchema,
} from "./types.ts";

type Parameters = Record<string, Scalar | undefined>;
const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

function compare(a: Scalar, b: Scalar): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  return av < bv ? -1 : 1;
}

function numeric(value: Scalar, context: string): number {
  invariant(
    typeof value === "number" && Number.isFinite(value),
    "VALIDATION_ERROR",
    `${context} requires a finite number.`,
  );
  return value;
}

function stringify(value: Scalar): string {
  return value === null ? "" : value instanceof Date ? value.toISOString() : String(value);
}

function evaluate(expression: Expression, row: Row, parameters: Parameters, group?: Row[]): Scalar {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "field":
      invariant(
        expression.name === "*" || expression.name in row,
        "VALIDATION_ERROR",
        `Unknown field ${expression.name}.`,
      );
      return expression.name === "*" ? null : row[expression.name];
    case "parameter":
      invariant(
        expression.name in parameters,
        "VALIDATION_ERROR",
        `Missing query parameter $${expression.name}.`,
      );
      return parameters[expression.name] ?? null;
    case "unary": {
      const value = evaluate(expression.operand, row, parameters, group);
      if (expression.operator === "NOT") return !value;
      return -numeric(value, "Unary minus");
    }
    case "binary": {
      const left = evaluate(expression.left, row, parameters, group);
      const right = evaluate(expression.right, row, parameters, group);
      switch (expression.operator) {
        case "IS":
          return left === null;
        case "IS NOT":
          return left !== null;
        case "AND":
          return Boolean(left) && Boolean(right);
        case "OR":
          return Boolean(left) || Boolean(right);
        case "=":
          return left !== null && right !== null && compare(left, right) === 0;
        case "!=":
        case "<>":
          return left !== null && right !== null && compare(left, right) !== 0;
        case "<":
          return left !== null && right !== null && compare(left, right) < 0;
        case "<=":
          return left !== null && right !== null && compare(left, right) <= 0;
        case ">":
          return left !== null && right !== null && compare(left, right) > 0;
        case ">=":
          return left !== null && right !== null && compare(left, right) >= 0;
        case "+":
          return numeric(left, "Addition") + numeric(right, "Addition");
        case "-":
          return numeric(left, "Subtraction") - numeric(right, "Subtraction");
        case "*":
          return numeric(left, "Multiplication") * numeric(right, "Multiplication");
        case "/": {
          const divisor = numeric(right, "Division");
          invariant(divisor !== 0, "VALIDATION_ERROR", "Division by zero.");
          return numeric(left, "Division") / divisor;
        }
        case "||":
          return stringify(left) + stringify(right);
      }
      throw new ShqlError("VALIDATION_ERROR", `Unsupported operator ${expression.operator}.`);
    }
    case "in": {
      const target = evaluate(expression.operand, row, parameters, group);
      if (target === null) return false;
      const found = expression.values.some((value) => {
        const candidate = evaluate(value, row, parameters, group);
        return candidate !== null && compare(target, candidate) === 0;
      });
      return expression.negated ? !found : found;
    }
    case "case":
      for (const branch of expression.branches) {
        if (evaluate(branch.when, row, parameters, group)) {
          return evaluate(branch.then, row, parameters, group);
        }
      }
      return evaluate(expression.otherwise, row, parameters, group);
    case "call": {
      const name = expression.name;
      if (AGGREGATES.has(name)) {
        invariant(group, "VALIDATION_ERROR", `${name} can only be used in an aggregate query.`);
        if (name === "COUNT" && expression.args[0]?.kind === "field" && expression.args[0].name === "*")
          return group.length;
        invariant(expression.args.length === 1, "VALIDATION_ERROR", `${name} expects one argument.`);
        const values = group
          .map((item) => evaluate(expression.args[0], item, parameters))
          .filter((value) => value !== null);
        if (name === "COUNT") return values.length;
        if (values.length === 0) return null;
        if (name === "SUM") return values.reduce<number>((sum, value) => sum + numeric(value, "SUM"), 0);
        if (name === "AVG")
          return values.reduce<number>((sum, value) => sum + numeric(value, "AVG"), 0) / values.length;
        if (name === "MIN") return values.reduce((min, value) => (compare(value, min) < 0 ? value : min));
        return values.reduce((max, value) => (compare(value, max) > 0 ? value : max));
      }
      const args = expression.args.map((arg) => evaluate(arg, row, parameters, group));
      switch (name) {
        case "NOW":
          invariant(args.length === 0, "VALIDATION_ERROR", "NOW expects no arguments.");
          return new Date();
        case "UPPER":
          return String(args[0] ?? "").toUpperCase();
        case "LOWER":
          return String(args[0] ?? "").toLowerCase();
        case "LEN":
          return String(args[0] ?? "").length;
        case "TEXT":
          return args[0] === null ? null : String(args[0]);
        case "NUMBER": {
          if (args[0] === null) return null;
          const value = Number(args[0]);
          invariant(
            Number.isFinite(value),
            "VALIDATION_ERROR",
            `Cannot convert ${String(args[0])} to number.`,
          );
          return value;
        }
        case "DATE":
        case "DATETIME": {
          if (args[0] === null) return null;
          const value = args[0] instanceof Date ? args[0] : new Date(String(args[0]));
          invariant(
            !Number.isNaN(value.getTime()),
            "VALIDATION_ERROR",
            `Cannot convert ${String(args[0])} to ${name.toLowerCase()}.`,
          );
          return value;
        }
        case "COALESCE":
          return args.find((value) => value !== null) ?? null;
        case "CONCAT":
          return args.map(stringify).join("");
        case "TRIM":
          return String(args[0] ?? "").trim();
        case "REPLACE":
          return String(args[0] ?? "")
            .split(String(args[1] ?? ""))
            .join(String(args[2] ?? ""));
        case "ROUND": {
          if (args[0] === null) return null;
          const factor = 10 ** (args[1] === null || args[1] === undefined ? 0 : numeric(args[1], "ROUND"));
          return Math.round(numeric(args[0], "ROUND") * factor) / factor;
        }
        case "ABS":
          return args[0] === null ? null : Math.abs(numeric(args[0], "ABS"));
        case "CONTAINS":
          return String(args[0] ?? "").includes(String(args[1] ?? ""));
        case "STARTS_WITH":
          return String(args[0] ?? "").startsWith(String(args[1] ?? ""));
        case "ENDS_WITH":
          return String(args[0] ?? "").endsWith(String(args[1] ?? ""));
        default:
          throw new ShqlError("VALIDATION_ERROR", `Unknown function ${name}.`);
      }
    }
  }
}

function hasAggregate(expression: Expression): boolean {
  if (expression.kind === "call")
    return AGGREGATES.has(expression.name) || expression.args.some(hasAggregate);
  if (expression.kind === "binary") return hasAggregate(expression.left) || hasAggregate(expression.right);
  if (expression.kind === "in")
    return hasAggregate(expression.operand) || expression.values.some(hasAggregate);
  if (expression.kind === "unary") return hasAggregate(expression.operand);
  if (expression.kind === "case") {
    return (
      expression.branches.some((branch) => hasAggregate(branch.when) || hasAggregate(branch.then)) ||
      hasAggregate(expression.otherwise)
    );
  }
  return false;
}

function qualified(values: Row, table: string, alias?: string): Row {
  const result: Row = { ...values };
  for (const [name, value] of Object.entries(values)) {
    result[`${table}.${name}`] = value;
    if (alias) result[`${alias}.${name}`] = value;
  }
  return result;
}

function joinRows(left: Row, right: Row, table: string, alias?: string): Row {
  const result = { ...left };
  for (const [name, value] of Object.entries(right)) {
    if (!(name in result)) result[name] = value;
    result[`${table}.${name}`] = value;
    if (alias) result[`${alias}.${name}`] = value;
  }
  return result;
}

function projectionName(item: Projection, index: number): string {
  if (item.alias) return item.alias;
  if (item.expression === "*") return "*";
  if (item.expression.kind === "field") return item.expression.name.split(".").at(-1)!;
  if (item.expression.kind === "call") return item.expression.name.toLowerCase();
  return `expression_${index + 1}`;
}

function project(items: Projection[], row: Row, parameters: Parameters, group?: Row[]): Row {
  if (items.length === 1 && items[0].expression === "*") return { ...row };
  const output: Row = {};
  items.forEach((item, index) => {
    invariant(
      item.expression !== "*",
      "VALIDATION_ERROR",
      "SELECT * cannot be mixed with other projections.",
    );
    const name = projectionName(item, index);
    invariant(
      !(name in output),
      "VALIDATION_ERROR",
      `Duplicate output field ${name}; use AS to give it a unique name.`,
    );
    output[name] = evaluate(item.expression, row, parameters, group);
  });
  return output;
}

function coerce(value: Scalar | undefined, column: TableSchema["columns"][number]): Scalar {
  if (value === undefined || value === null || value === "") {
    invariant(column.nullable, "VALIDATION_ERROR", `Column ${column.name} cannot be null.`);
    return null;
  }
  switch (column.type) {
    case "id":
    case "text": {
      const result = String(value);
      if (column.pattern)
        invariant(
          new RegExp(column.pattern).test(result),
          "VALIDATION_ERROR",
          `Column ${column.name} does not match its required pattern.`,
        );
      if (column.allowed)
        invariant(
          column.allowed.includes(result),
          "VALIDATION_ERROR",
          `Column ${column.name} must be one of its allowed values.`,
        );
      return result;
    }
    case "number": {
      const result = typeof value === "number" ? value : Number(value);
      invariant(Number.isFinite(result), "VALIDATION_ERROR", `Column ${column.name} requires a number.`);
      if (column.min !== undefined)
        invariant(
          result >= column.min,
          "VALIDATION_ERROR",
          `Column ${column.name} must be >= ${column.min}.`,
        );
      if (column.max !== undefined)
        invariant(
          result <= column.max,
          "VALIDATION_ERROR",
          `Column ${column.name} must be <= ${column.max}.`,
        );
      if (column.allowed)
        invariant(
          column.allowed.includes(result),
          "VALIDATION_ERROR",
          `Column ${column.name} must be one of its allowed values.`,
        );
      return result;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (String(value).toLowerCase() === "true") return true;
      if (String(value).toLowerCase() === "false") return false;
      throw new ShqlError("VALIDATION_ERROR", `Column ${column.name} requires a boolean.`);
    }
    case "date":
    case "datetime": {
      const result = value instanceof Date ? value : new Date(String(value));
      invariant(
        !Number.isNaN(result.getTime()),
        "VALIDATION_ERROR",
        `Column ${column.name} requires a valid ${column.type}.`,
      );
      return result;
    }
  }
}

function validateRow(table: TableSchema, input: Row, partial = false): Row {
  const known = new Set(table.columns.map((column) => column.name));
  for (const name of Object.keys(input))
    invariant(known.has(name), "VALIDATION_ERROR", `Unknown column ${table.name}.${name}.`);
  const output: Row = partial ? {} : { ...input };
  for (const column of table.columns) {
    if (partial && !(column.name in input)) continue;
    let value = input[column.name];
    if (!partial && value === undefined && column.defaultNow) value = new Date();
    if (!partial && value === undefined && column.defaultValue !== undefined) value = column.defaultValue;
    if (!partial && column.type === "id" && (value === undefined || value === null || value === ""))
      value = randomUUID();
    output[column.name] = coerce(value, column);
  }
  return output;
}

function validateUnique(table: TableSchema, rows: Row[]): void {
  for (const column of table.columns.filter((candidate) => candidate.unique)) {
    const values = new Set<string>();
    for (const row of rows) {
      const value = row[column.name];
      if (value === null || value === undefined) continue;
      const key = value instanceof Date ? value.toISOString() : JSON.stringify(value);
      invariant(!values.has(key), "CONFLICT", `Duplicate unique value in ${table.name}.${column.name}.`);
      values.add(key);
    }
  }
}

function applyLets(
  row: Row,
  query: { lets: Array<{ name: string; expression: Expression }> },
  parameters: Parameters,
): Row {
  const result = { ...row };
  for (const binding of query.lets) result[binding.name] = evaluate(binding.expression, result, parameters);
  return result;
}

export class Engine {
  private readonly schema: DatabaseSchema;
  private readonly resolveAdapter: (table: TableSchema) => TableAdapter;

  constructor(schema: DatabaseSchema, adapter: TableAdapter | ((table: TableSchema) => TableAdapter)) {
    this.schema = schema;
    this.resolveAdapter = typeof adapter === "function" ? adapter : () => adapter;
  }

  private async readTable(table: TableSchema, parameters: Parameters): Promise<StoredRow[]> {
    if (!table.view) return this.resolveAdapter(table).read(table);
    const result = await this.execute(table.view, parameters);
    invariant(
      result.operation === "select",
      "VALIDATION_ERROR",
      `View ${table.name} must contain a SELECT query.`,
    );
    return result.rows.map((values, index) => ({ rowNumber: index + 1, values }));
  }

  async execute(source: string | Query, parameters: Parameters = {}): Promise<QueryResult> {
    const query = typeof source === "string" ? parseQuery(source) : source;
    const table = this.schema.tables.get(query.table);
    invariant(table, "VALIDATION_ERROR", `Unknown table ${query.table}.`);
    const adapter = this.resolveAdapter(table);
    if (table.view)
      invariant(query.operation === "select", "VALIDATION_ERROR", `View ${table.name} is read-only.`);
    if (query.operation === "insert") return this.insert(adapter, table, query, parameters);
    if (query.operation === "upsert") return this.upsert(adapter, table, query, parameters);
    invariant(
      query.operation === "select" || query.joins.length === 0,
      "VALIDATION_ERROR",
      "JOIN is only supported for SELECT queries.",
    );

    const stored = await this.readTable(table, parameters);
    if (table.columns.length && !table.view) {
      for (const item of stored) item.values = validateRow(table, item.values);
    }
    const idColumn = table.columns.find((column) => column.type === "id")?.name;
    if (idColumn) {
      const ids = new Set<string>();
      for (const item of stored) {
        const id = item.values[idColumn];
        invariant(
          typeof id === "string" && id.length > 0,
          "VALIDATION_ERROR",
          `Row ${item.rowNumber} in ${table.name} is missing ${idColumn}.`,
        );
        invariant(!ids.has(id), "CONFLICT", `Duplicate id ${id} in ${table.name}.`);
        ids.add(id);
      }
    }
    validateUnique(
      table,
      stored.map((item) => item.values),
    );
    let prepared = stored.map((item) => ({
      stored: item,
      values:
        query.operation === "select" && (query.alias || query.joins.length)
          ? qualified(item.values, table.name, query.alias)
          : { ...item.values },
    }));
    if (query.operation === "select") {
      for (const join of query.joins) {
        const joinedTable = this.schema.tables.get(join.table);
        invariant(joinedTable, "VALIDATION_ERROR", `Unknown joined table ${join.table}.`);
        const joinedRows = await this.readTable(joinedTable, parameters);
        const next: typeof prepared = [];
        for (const left of prepared) {
          let matches = 0;
          for (const right of joinedRows) {
            const values = joinRows(left.values, right.values, joinedTable.name, join.alias);
            if (evaluate(join.on, values, parameters)) {
              next.push({ stored: left.stored, values });
              matches++;
            }
          }
          if (join.type === "left" && matches === 0) {
            const empty = Object.fromEntries(joinedTable.columns.map((column) => [column.name, null])) as Row;
            next.push({
              stored: left.stored,
              values: joinRows(left.values, empty, joinedTable.name, join.alias),
            });
          }
        }
        prepared = next;
      }
    }
    prepared = prepared.map((item) => ({
      ...item,
      values: applyLets(item.values, query, parameters),
    }));
    const matched = query.where
      ? prepared.filter((item) => Boolean(evaluate(query.where!, item.values, parameters)))
      : prepared;

    if (query.operation === "update") {
      invariant(
        table.columns.length > 0,
        "VALIDATION_ERROR",
        `Compact table ${table.name} is read-only; declare a typed TABLE schema to mutate it.`,
      );
      const versionColumn = table.columns.find((column) => column.name === "_shql_version");
      if (versionColumn)
        invariant(
          versionColumn.type === "number",
          "SCHEMA_ERROR",
          `${table.name}._shql_version must have type number.`,
        );
      const updates = matched.map(({ stored: original, values }) => {
        const patch: Row = {};
        for (const [name, expression] of Object.entries(query.values))
          patch[name] = evaluate(expression, values, parameters);
        invariant(
          !idColumn || !(idColumn in patch),
          "VALIDATION_ERROR",
          `The id column ${idColumn} is immutable.`,
        );
        invariant(
          !versionColumn || !(versionColumn.name in patch),
          "VALIDATION_ERROR",
          `${versionColumn?.name} is managed by SHQL and cannot be assigned.`,
        );
        const coerced = validateRow(table, patch, true);
        const expectedVersion = versionColumn
          ? numeric(original.values[versionColumn.name], "_shql_version")
          : undefined;
        const nextValues = { ...original.values, ...coerced };
        if (versionColumn) nextValues[versionColumn.name] = expectedVersion! + 1;
        return { rowNumber: original.rowNumber, values: nextValues, expectedVersion };
      });
      await adapter.update(table, updates);
      const rows = query.returning.length
        ? updates.map((item) => project(query.returning, item.values, parameters))
        : [];
      return this.result("update", rows, updates.length);
    }

    if (query.operation === "delete") {
      invariant(
        table.columns.length > 0,
        "VALIDATION_ERROR",
        `Compact table ${table.name} is read-only; declare a typed TABLE schema to mutate it.`,
      );
      const rows = query.returning.length
        ? matched.map((item) => project(query.returning, item.values, parameters))
        : [];
      const versionColumn = table.columns.find((column) => column.name === "_shql_version");
      if (versionColumn)
        invariant(
          versionColumn.type === "number",
          "SCHEMA_ERROR",
          `${table.name}._shql_version must have type number.`,
        );
      await adapter.delete(
        table,
        matched.map((item) => ({
          ...item.stored,
          expectedVersion: versionColumn
            ? numeric(item.stored.values[versionColumn.name], "_shql_version")
            : undefined,
        })),
      );
      return this.result("delete", rows, matched.length);
    }

    const aggregate =
      query.groupBy.length > 0 ||
      query.select.some((item) => item.expression !== "*" && hasAggregate(item.expression));
    invariant(
      !query.having || aggregate,
      "VALIDATION_ERROR",
      "HAVING requires GROUP BY or an aggregate SELECT.",
    );
    let rows: Row[];
    if (aggregate) {
      for (const item of query.select) {
        invariant(
          item.expression !== "*",
          "VALIDATION_ERROR",
          "SELECT * is not valid in an aggregate query.",
        );
        if (!hasAggregate(item.expression)) {
          invariant(
            query.groupBy.some(
              (groupExpression) => JSON.stringify(groupExpression) === JSON.stringify(item.expression),
            ),
            "VALIDATION_ERROR",
            `Non-aggregate projection ${projectionName(item, 0)} must appear in GROUP BY.`,
          );
        }
      }
      const groups = new Map<string, Row[]>();
      for (const item of matched) {
        const keyValues = query.groupBy.map((expression) => evaluate(expression, item.values, parameters));
        const key = JSON.stringify(keyValues, (_key, value) =>
          value instanceof Date ? value.toISOString() : value,
        );
        const group = groups.get(key) ?? [];
        group.push(item.values);
        groups.set(key, group);
      }
      if (query.groupBy.length === 0 && groups.size === 0) groups.set("[]", []);
      const selected = query.having
        ? [...groups.values()].filter((group) =>
            Boolean(evaluate(query.having!, group[0] ?? {}, parameters, group)),
          )
        : [...groups.values()];
      rows = selected.map((group) => project(query.select, group[0] ?? {}, parameters, group));
    } else rows = matched.map((item) => project(query.select, item.values, parameters));

    if (query.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const key = JSON.stringify(row, (_key, value) =>
          value instanceof Date ? value.toISOString() : value,
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    for (let index = query.sort.length - 1; index >= 0; index--) {
      const sort = query.sort[index];
      rows.sort(
        (a, b) =>
          compare(evaluate(sort.expression, a, parameters), evaluate(sort.expression, b, parameters)) *
          (sort.direction === "desc" ? -1 : 1),
      );
    }
    if (query.skip !== undefined) rows = rows.slice(query.skip);
    if (query.take !== undefined) rows = rows.slice(0, query.take);
    return this.result("select", rows, rows.length);
  }

  private async insert(
    adapter: TableAdapter,
    table: TableSchema,
    query: Extract<Query, { operation: "insert" }>,
    parameters: Parameters,
  ): Promise<QueryResult> {
    invariant(
      table.columns.length > 0,
      "VALIDATION_ERROR",
      `Compact table ${table.name} is read-only; declare a typed TABLE schema to mutate it.`,
    );
    const rows = query.rows.map((values) => {
      const evaluated: Row = {};
      for (const [name, expression] of Object.entries(values))
        evaluated[name] = evaluate(expression, {}, parameters);
      const versionColumn = table.columns.find((column) => column.name === "_shql_version");
      if (versionColumn) {
        invariant(
          versionColumn.type === "number",
          "SCHEMA_ERROR",
          `${table.name}._shql_version must have type number.`,
        );
        invariant(
          !(versionColumn.name in evaluated),
          "VALIDATION_ERROR",
          `${versionColumn.name} is managed by SHQL and cannot be assigned.`,
        );
        evaluated[versionColumn.name] = 1;
      }
      return validateRow(table, evaluated);
    });
    if (table.columns.some((column) => column.unique)) {
      validateUnique(table, [...(await adapter.read(table)).map((item) => item.values), ...rows]);
    }
    const appended = await adapter.append(table, rows);
    const returned = query.returning.length
      ? appended.map((item) => project(query.returning, item.values, parameters))
      : [];
    return this.result("insert", returned, appended.length);
  }

  private async upsert(
    adapter: TableAdapter,
    table: TableSchema,
    query: Extract<Query, { operation: "upsert" }>,
    parameters: Parameters,
  ): Promise<QueryResult> {
    invariant(
      table.columns.length > 0,
      "VALIDATION_ERROR",
      `Compact table ${table.name} is read-only; declare a typed TABLE schema to mutate it.`,
    );
    const keyColumn = table.columns.find((column) => column.name === query.key);
    invariant(keyColumn, "VALIDATION_ERROR", `Unknown upsert key ${table.name}.${query.key}.`);
    const evaluated: Row = {};
    for (const [name, expression] of Object.entries(query.values))
      evaluated[name] = evaluate(expression, {}, parameters);
    const keyValue = coerce(evaluated[query.key], keyColumn);
    invariant(keyValue !== null, "VALIDATION_ERROR", `Upsert key ${query.key} cannot be null.`);
    const existing = (await adapter.read(table)).filter(
      (row) => compare(row.values[query.key], keyValue) === 0,
    );
    invariant(existing.length <= 1, "CONFLICT", `Upsert key ${query.key} is not unique in ${table.name}.`);
    const versionColumn = table.columns.find((column) => column.name === "_shql_version");
    if (versionColumn)
      invariant(
        versionColumn.type === "number",
        "SCHEMA_ERROR",
        `${table.name}._shql_version must have type number.`,
      );

    let stored: StoredRow;
    if (existing.length === 1) {
      const current = existing[0];
      const idColumn = table.columns.find((column) => column.type === "id")?.name;
      invariant(
        !idColumn || !(idColumn in evaluated),
        "VALIDATION_ERROR",
        `The id column ${idColumn} is immutable during an upsert update.`,
      );
      invariant(
        !versionColumn || !(versionColumn.name in evaluated),
        "VALIDATION_ERROR",
        `${versionColumn?.name} is managed by SHQL and cannot be assigned.`,
      );
      const patch = validateRow(table, evaluated, true);
      const expectedVersion = versionColumn
        ? numeric(current.values[versionColumn.name], "_shql_version")
        : undefined;
      const values = { ...current.values, ...patch };
      if (versionColumn) values[versionColumn.name] = expectedVersion! + 1;
      stored = { rowNumber: current.rowNumber, values, expectedVersion };
      await adapter.update(table, [stored]);
    } else {
      if (versionColumn) {
        invariant(
          !(versionColumn.name in evaluated),
          "VALIDATION_ERROR",
          `${versionColumn.name} is managed by SHQL and cannot be assigned.`,
        );
        evaluated[versionColumn.name] = 1;
      }
      [stored] = await adapter.append(table, [validateRow(table, evaluated)]);
    }
    const rows = query.returning.length ? [project(query.returning, stored.values, parameters)] : [];
    return this.result("upsert", rows, 1);
  }

  private result(operation: QueryResult["operation"], rows: Row[], affectedRows: number): QueryResult {
    return { operation, rows, affectedRows, columns: rows.length ? Object.keys(rows[0]) : [] };
  }
}
