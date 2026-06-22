export type Scalar = string | number | boolean | Date | null;
export type Row = Record<string, Scalar>;
export type ColumnType = "id" | "text" | "number" | "boolean" | "date" | "datetime";

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  nullable: boolean;
  unique?: boolean;
  allowed?: Scalar[];
  min?: number;
  max?: number;
  pattern?: string;
  defaultValue?: Scalar;
  defaultNow?: boolean;
}

export interface TableSchema {
  name: string;
  tabId: string;
  connection: string;
  columns: ColumnSchema[];
  view?: string;
}

export type ConnectionProvider =
  | "google-sheets"
  | "memory"
  | "json"
  | "csv"
  | "http"
  | "postgres"
  | "mysql"
  | "sqlite";

export interface ConnectionSchema {
  name: string;
  provider: ConnectionProvider;
  source: string;
}

export interface DatabaseSchema {
  spreadsheetId: string;
  defaultConnection: string;
  connections: Map<string, ConnectionSchema>;
  tables: Map<string, TableSchema>;
}

export interface StoredRow {
  rowNumber: number;
  values: Row;
  expectedVersion?: number;
}

export interface TableInspection {
  table: string;
  tabId: string;
  title?: string;
  headers: string[];
  rowCount: number;
  inferredColumns: ColumnSchema[];
}

export interface DoctorResult {
  ok: boolean;
  spreadsheetId?: string;
  message: string;
}

export interface TableAdapter {
  read(table: TableSchema): Promise<StoredRow[]>;
  append(table: TableSchema, rows: Row[]): Promise<StoredRow[]>;
  update(table: TableSchema, rows: StoredRow[]): Promise<void>;
  delete(table: TableSchema, rows: StoredRow[]): Promise<void>;
  inspect?(table: TableSchema): Promise<TableInspection>;
  initialize?(table: TableSchema): Promise<void>;
  doctor?(): Promise<DoctorResult>;
}

export interface QueryResult {
  operation: "select" | "insert" | "update" | "delete" | "upsert";
  rows: Row[];
  affectedRows: number;
  columns: string[];
}

export interface PreviewResult {
  operation: QueryResult["operation"];
  affectedRows: number;
  rows: Row[];
  warnings: string[];
}

export interface ConnectOptions {
  schema: string | DatabaseSchema;
  adapter?: TableAdapter;
  env?: Record<string, string | undefined>;
  auth?: GoogleSheetsAuth;
  fetch?: typeof globalThis.fetch;
  connections?: Record<
    string,
    {
      adapter?: TableAdapter;
      auth?: GoogleSheetsAuth;
      fetch?: typeof globalThis.fetch;
      headers?: Record<string, string>;
    }
  >;
  governance?: Governance;
  context?: GovernanceContext;
}

export type GoogleSheetsAuth =
  | { type: "access-token"; accessToken: string }
  | {
      type: "oauth";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      tokenUri?: string;
    }
  | {
      type: "service-account";
      clientEmail: string;
      privateKey: string;
      tokenUri?: string;
    };
import type { Governance, GovernanceContext } from "./governance.ts";
