import { invariant } from "./errors.ts";
import type { Scalar } from "./types.ts";

export type Expression =
  | { kind: "literal"; value: Scalar }
  | { kind: "field"; name: string }
  | { kind: "parameter"; name: string }
  | { kind: "unary"; operator: string; operand: Expression }
  | { kind: "binary"; operator: string; left: Expression; right: Expression }
  | { kind: "in"; operand: Expression; values: Expression[]; negated: boolean }
  | { kind: "call"; name: string; args: Expression[] }
  | {
      kind: "case";
      branches: Array<{ when: Expression; then: Expression }>;
      otherwise: Expression;
    };

export interface Projection {
  expression: Expression | "*";
  alias?: string;
}

interface FromQuery {
  table: string;
  alias?: string;
  joins: Array<{
    type: "inner" | "left";
    table: string;
    alias?: string;
    on: Expression;
  }>;
  lets: Array<{ name: string; expression: Expression }>;
  where?: Expression;
}

export type Query =
  | (FromQuery & {
      operation: "select";
      distinct?: boolean;
      groupBy: Expression[];
      select: Projection[];
      having?: Expression;
      sort: Array<{ expression: Expression; direction: "asc" | "desc" }>;
      skip?: number;
      take?: number;
    })
  | (FromQuery & {
      operation: "update";
      values: Record<string, Expression>;
      returning: Projection[];
    })
  | (FromQuery & { operation: "delete"; returning: Projection[] })
  | {
      operation: "insert";
      table: string;
      rows: Array<Record<string, Expression>>;
      returning: Projection[];
    }
  | {
      operation: "upsert";
      table: string;
      key: string;
      values: Record<string, Expression>;
      returning: Projection[];
    };

type TokenKind = "word" | "string" | "number" | "parameter" | "symbol" | "eof";
interface Token {
  kind: TokenKind;
  value: string;
  position: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index++;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          index++;
          const escaped = source[index++];
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        } else value += source[index++];
      }
      invariant(source[index] === quote, "QUERY_ERROR", `Unterminated string at character ${start}.`);
      index++;
      tokens.push({ kind: "string", value, position: start });
      continue;
    }
    if (char === "`") {
      const start = index++;
      let value = "";
      while (index < source.length && source[index] !== "`") value += source[index++];
      invariant(
        source[index] === "`",
        "QUERY_ERROR",
        `Unterminated quoted identifier at character ${start}.`,
      );
      index++;
      tokens.push({ kind: "word", value, position: start });
      continue;
    }
    if (char === "$" && /[A-Za-z_]/.test(source[index + 1] ?? "")) {
      const start = index++;
      let value = "";
      while (/[A-Za-z0-9_]/.test(source[index] ?? "")) value += source[index++];
      tokens.push({ kind: "parameter", value, position: start });
      continue;
    }
    if (/\d/.test(char) || (char === "." && /\d/.test(source[index + 1] ?? ""))) {
      const start = index;
      let value = "";
      while (/[\d.]/.test(source[index] ?? "")) value += source[index++];
      invariant(/^\d*\.?\d+$/.test(value), "QUERY_ERROR", `Invalid number ${value}.`);
      tokens.push({ kind: "number", value, position: start });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      let value = "";
      while (/[A-Za-z0-9_.]/.test(source[index] ?? "")) value += source[index++];
      tokens.push({ kind: "word", value, position: start });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (["!=", "<=", ">=", "<>", "||"].includes(pair)) {
      tokens.push({ kind: "symbol", value: pair, position: index });
      index += 2;
      continue;
    }
    invariant("{}[](),;:+-*/=<>".includes(char), "QUERY_ERROR", `Unexpected character ${char} at ${index}.`);
    tokens.push({ kind: "symbol", value: char, position: index++ });
  }
  tokens.push({ kind: "eof", value: "", position: source.length });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }
  private current(): Token {
    return this.tokens[this.index];
  }
  private peek(): Token {
    return this.tokens[this.index + 1] ?? this.tokens[this.index];
  }
  private integer(keyword: string): number {
    const token = this.current();
    invariant(
      token.kind === "number" && Number.isInteger(Number(token.value)) && Number(token.value) >= 0,
      "QUERY_ERROR",
      `${keyword} requires a non-negative integer.`,
    );
    return Number(this.consume().value);
  }
  private is(value: string): boolean {
    const token = this.current();
    // Only bare words (keywords) and symbols are operators/clauses; a string,
    // number, or parameter literal must never be read as one (e.g. "AND", "-").
    if (token.kind !== "word" && token.kind !== "symbol") return false;
    return token.value.toUpperCase() === value.toUpperCase();
  }
  private consume(): Token {
    return this.tokens[this.index++];
  }
  private match(value: string): boolean {
    if (!this.is(value)) return false;
    this.index++;
    return true;
  }
  private expect(value: string): Token {
    invariant(
      this.is(value),
      "QUERY_ERROR",
      `Expected ${value} at character ${this.current().position}, found ${this.current().value || "end of query"}.`,
    );
    return this.consume();
  }
  private identifier(context: string): string {
    const token = this.current();
    invariant(token.kind === "word", "QUERY_ERROR", `Expected ${context} at character ${token.position}.`);
    this.consume();
    return token.value;
  }
  private finish(): void {
    this.match(";");
    invariant(
      this.current().kind === "eof",
      "QUERY_ERROR",
      `Unexpected token ${this.current().value} at character ${this.current().position}.`,
    );
  }

  parse(): Query {
    if (this.match("INSERT")) return this.parseInsert();
    if (this.match("UPSERT")) return this.parseUpsert();
    this.expect("FROM");
    const table = this.identifier("table name");
    const alias = this.match("AS") ? this.identifier("table alias") : undefined;
    const base: FromQuery = { table, alias, joins: [], lets: [] };
    while (this.is("JOIN") || this.is("LEFT")) {
      const type = this.match("LEFT")
        ? (this.expect("JOIN"), "left" as const)
        : (this.expect("JOIN"), "inner" as const);
      const joinedTable = this.identifier("joined table name");
      const joinedAlias = this.match("AS") ? this.identifier("joined table alias") : undefined;
      this.expect("ON");
      base.joins.push({ type, table: joinedTable, alias: joinedAlias, on: this.expression() });
    }
    while (this.match("LET")) {
      const name = this.identifier("LET field name");
      this.expect("=");
      base.lets.push({ name, expression: this.expression() });
    }
    if (this.match("WHERE")) base.where = this.expression();

    if (this.match("UPDATE")) {
      invariant(base.where, "VALIDATION_ERROR", "UPDATE requires a WHERE clause.");
      const values = this.object();
      const returning = this.match("RETURNING") ? this.projections() : [];
      this.finish();
      return { ...base, operation: "update", values, returning };
    }
    if (this.match("DELETE")) {
      invariant(base.where, "VALIDATION_ERROR", "DELETE requires a WHERE clause.");
      const returning = this.match("RETURNING") ? this.projections() : [];
      this.finish();
      return { ...base, operation: "delete", returning };
    }

    const groupBy: Expression[] = [];
    if (this.match("GROUP")) {
      this.expect("BY");
      groupBy.push(...this.expressionList());
    }
    this.expect("SELECT");
    const distinct = this.match("DISTINCT");
    const select = this.projections();
    const having = this.match("HAVING") ? this.expression() : undefined;
    const sort: Array<{ expression: Expression; direction: "asc" | "desc" }> = [];
    if (this.match("SORT")) {
      do {
        const expression = this.expression();
        const direction = this.match("DESC") ? "desc" : (this.match("ASC"), "asc");
        sort.push({ expression, direction });
      } while (this.match(","));
    }
    let take: number | undefined;
    let skip: number | undefined;
    while (this.is("TAKE") || this.is("SKIP") || this.is("OFFSET")) {
      if (this.match("TAKE")) take = this.integer("TAKE");
      else {
        this.consume();
        skip = this.integer("SKIP");
      }
    }
    this.finish();
    return { ...base, operation: "select", distinct, groupBy, select, having, sort, skip, take };
  }

  private parseInsert(): Query {
    this.expect("INTO");
    const table = this.identifier("table name");
    const rows: Array<Record<string, Expression>> = [];
    if (this.match("[")) {
      if (!this.is("]")) {
        do rows.push(this.object());
        while (this.match(","));
      }
      this.expect("]");
      invariant(rows.length > 0, "QUERY_ERROR", "INSERT requires at least one row.");
    } else rows.push(this.object());
    const returning = this.match("RETURNING") ? this.projections() : [];
    this.finish();
    return { operation: "insert", table, rows, returning };
  }

  private parseUpsert(): Query {
    this.expect("INTO");
    const table = this.identifier("table name");
    this.expect("KEY");
    const key = this.identifier("upsert key");
    this.expect("VALUE");
    const values = this.object();
    invariant(key in values, "QUERY_ERROR", `UPSERT VALUE must include key field ${key}.`);
    const returning = this.match("RETURNING") ? this.projections() : [];
    this.finish();
    return { operation: "upsert", table, key, values, returning };
  }

  private object(): Record<string, Expression> {
    this.expect("{");
    const values: Record<string, Expression> = {};
    if (!this.is("}")) {
      do {
        const name = this.identifier("field name");
        this.expect(":");
        invariant(!(name in values), "QUERY_ERROR", `Field ${name} is assigned more than once.`);
        values[name] = this.expression();
      } while (this.match(","));
    }
    this.expect("}");
    return values;
  }

  private projections(): Projection[] {
    if (this.match("*")) return [{ expression: "*" }];
    const items: Projection[] = [];
    do {
      const expression = this.expression();
      const alias = this.match("AS") ? this.identifier("alias") : undefined;
      items.push({ expression, alias });
    } while (this.match(","));
    return items;
  }

  private expressionList(): Expression[] {
    const items = [this.expression()];
    while (this.match(",")) items.push(this.expression());
    return items;
  }

  private expression(minPrecedence = 0): Expression {
    let left = this.primary();
    const precedence: Record<string, number> = {
      OR: 1,
      AND: 2,
      "=": 3,
      "!=": 3,
      "<>": 3,
      "<": 3,
      "<=": 3,
      ">": 3,
      ">=": 3,
      "+": 4,
      "-": 4,
      "||": 4,
      "*": 5,
      "/": 5,
    };
    while (true) {
      // Comparison-level postfix operators whose right-hand side is not a plain expression.
      if (minPrecedence <= 3) {
        if (this.is("IS")) {
          this.consume();
          const operator = this.match("NOT") ? "IS NOT" : "IS";
          this.expect("NULL");
          left = { kind: "binary", operator, left, right: { kind: "literal", value: null } };
          continue;
        }
        const negated = this.is("NOT") && this.peek().value.toUpperCase() === "IN";
        if (negated || this.is("IN")) {
          if (negated) this.consume();
          this.expect("IN");
          this.expect("(");
          const values = this.is(")") ? [] : this.expressionList();
          this.expect(")");
          left = { kind: "in", operand: left, values, negated };
          continue;
        }
      }
      const operator = this.current().value.toUpperCase();
      const level = precedence[operator] ?? -1;
      if (level < minPrecedence) break;
      this.consume();
      const right = this.expression(level + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  }

  private primary(): Expression {
    if (this.match("NOT")) return { kind: "unary", operator: "NOT", operand: this.expression(6) };
    if (this.match("-")) return { kind: "unary", operator: "-", operand: this.expression(6) };
    if (this.match("(")) {
      const value = this.expression();
      this.expect(")");
      return value;
    }
    if (this.match("CASE")) {
      const branches: Array<{ when: Expression; then: Expression }> = [];
      while (this.match("WHEN")) {
        const when = this.expression();
        this.expect("THEN");
        branches.push({ when, then: this.expression() });
      }
      invariant(branches.length > 0, "QUERY_ERROR", "CASE requires at least one WHEN branch.");
      const otherwise = this.match("ELSE") ? this.expression() : ({ kind: "literal", value: null } as const);
      this.expect("END");
      return { kind: "case", branches, otherwise };
    }
    const token = this.consume();
    if (token.kind === "string") return { kind: "literal", value: token.value };
    if (token.kind === "number") return { kind: "literal", value: Number(token.value) };
    if (token.kind === "parameter") return { kind: "parameter", name: token.value };
    invariant(token.kind === "word", "QUERY_ERROR", `Expected expression at character ${token.position}.`);
    if (token.value.toUpperCase() === "NULL") return { kind: "literal", value: null };
    if (token.value.toUpperCase() === "TRUE") return { kind: "literal", value: true };
    if (token.value.toUpperCase() === "FALSE") return { kind: "literal", value: false };
    if (this.match("(")) {
      const args: Expression[] = [];
      if (!this.is(")")) {
        if (this.match("*")) args.push({ kind: "field", name: "*" });
        else args.push(...this.expressionList());
      }
      this.expect(")");
      return { kind: "call", name: token.value.toUpperCase(), args };
    }
    return { kind: "field", name: token.value };
  }
}

export function parseQuery(source: string): Query {
  return new Parser(source).parse();
}
