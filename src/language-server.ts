#!/usr/bin/env node
import { parseQuery } from "./query.ts";
import { parseSchema } from "./schema.ts";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}
const documents = new Map<string, string>();

function write(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function response(id: RpcMessage["id"], result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function environment(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const match of source.matchAll(/\$?\{([A-Z_][A-Z0-9_]*)\}/g)) values[match[1]] = match[1];
  return values;
}

function diagnostics(uri: string, source: string): void {
  const issues: unknown[] = [];
  try {
    if (/\b(SHEET|CONNECTION|TABLE|VIEW)\b/i.test(source)) parseSchema(source, environment(source));
    else parseQuery(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /character (\d+)/.exec(message);
    const offset = position ? Number(position[1]) : 0;
    const before = source.slice(0, offset).split("\n");
    const line = before.length - 1;
    const character = before.at(-1)?.length ?? 0;
    issues.push({
      range: { start: { line, character }, end: { line, character: character + 1 } },
      severity: 1,
      source: "shql",
      message,
    });
  }
  write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: issues } });
}

const completionWords = [
  "FROM",
  "LET",
  "WHERE",
  "GROUP BY",
  "SELECT",
  "SORT",
  "TAKE",
  "JOIN",
  "LEFT JOIN",
  "ON",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "INSERT INTO",
  "UPDATE",
  "DELETE",
  "UPSERT INTO",
  "RETURNING",
  "SHEET",
  "CONNECTION",
  "TABLE",
  "VIEW",
  "UNIQUE",
  "DEFAULT",
  "MATCHES",
  "id",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "NOW()",
  "COUNT(*)",
  "SUM()",
  "AVG()",
  "COALESCE()",
  "UPPER()",
  "LOWER()",
];

function handle(message: RpcMessage): void {
  const params = message.params ?? {};
  if (message.method === "initialize") {
    response(message.id, {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: [".", " "] },
        documentFormattingProvider: false,
      },
      serverInfo: { name: "shql-language-server", version: "1.0.0-rc.3" },
    });
  } else if (message.method === "shutdown") response(message.id, null);
  else if (message.method === "exit") process.exit(0);
  else if (message.method === "textDocument/completion") {
    response(
      message.id,
      completionWords.map((label) => ({ label, kind: label.includes("(") ? 3 : 14 })),
    );
  } else if (message.method === "textDocument/didOpen") {
    const document = params.textDocument as { uri: string; text: string };
    documents.set(document.uri, document.text);
    diagnostics(document.uri, document.text);
  } else if (message.method === "textDocument/didChange") {
    const document = params.textDocument as { uri: string };
    const changes = params.contentChanges as Array<{ text: string }>;
    const text = changes.at(-1)?.text ?? documents.get(document.uri) ?? "";
    documents.set(document.uri, text);
    diagnostics(document.uri, text);
  } else if (message.id !== undefined) response(message.id, null);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) break;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    try {
      handle(JSON.parse(body) as RpcMessage);
    } catch (error) {
      write({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 1, message: String(error) } });
    }
  }
});
