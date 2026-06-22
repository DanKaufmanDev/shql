import { createSign } from "node:crypto";
import { ShqlError, invariant } from "../errors.ts";
import type {
  ColumnSchema,
  DoctorResult,
  GoogleSheetsAuth,
  Row,
  Scalar,
  StoredRow,
  TableAdapter,
  TableInspection,
  TableSchema,
} from "../types.ts";

interface TokenCache {
  value: string;
  expiresAt: number;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function cellValue(value: unknown, column: ColumnSchema): Scalar {
  if (value === undefined || value === null || value === "") return null;
  if (column.type === "number") {
    const number = Number(value);
    invariant(Number.isFinite(number), "ADAPTER_ERROR", `Cell in ${column.name} is not a number.`);
    return number;
  }
  if (column.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (String(value).toLowerCase() === "true") return true;
    if (String(value).toLowerCase() === "false") return false;
    throw new ShqlError("ADAPTER_ERROR", `Cell in ${column.name} is not a boolean.`);
  }
  if (column.type === "date" || column.type === "datetime") {
    const date = new Date(String(value));
    invariant(
      !Number.isNaN(date.getTime()),
      "ADAPTER_ERROR",
      `Cell in ${column.name} is not a valid ${column.type}.`,
    );
    return date;
  }
  return String(value);
}

function serialize(value: Scalar): string | number | boolean {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return value;
}

function columnLetter(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function inferColumn(name: string, values: unknown[]): ColumnSchema {
  const present = values.filter((value) => value !== undefined && value !== null && value !== "");
  let type: ColumnSchema["type"] = name === "_shql_id" ? "id" : "text";
  if (name !== "_shql_id" && present.length > 0) {
    if (
      present.every(
        (value) => typeof value === "boolean" || ["true", "false"].includes(String(value).toLowerCase()),
      )
    )
      type = "boolean";
    else if (present.every((value) => Number.isFinite(Number(value)))) type = "number";
    else if (
      present.every(
        (value) => /^\d{4}-\d{2}-\d{2}/.test(String(value)) && !Number.isNaN(Date.parse(String(value))),
      )
    ) {
      type = present.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value))) ? "date" : "datetime";
    }
  }
  return { name, type, nullable: present.length !== values.length };
}

export class GoogleSheetsAdapter implements TableAdapter {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly spreadsheetId: string;
  private readonly auth: GoogleSheetsAuth;
  private token?: TokenCache;
  private tabs?: Map<string, string>;
  private readonly writableLayouts = new Set<string>();

  constructor(
    spreadsheetId: string,
    auth: GoogleSheetsAuth,
    fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {
    invariant(typeof fetcher === "function", "ADAPTER_ERROR", "A Fetch API implementation is required.");
    this.spreadsheetId = spreadsheetId;
    this.auth = auth;
    this.fetcher = fetcher;
  }

  async read(table: TableSchema): Promise<StoredRow[]> {
    const title = await this.tabTitle(table.tabId);
    const response = (await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(`'${title.replaceAll("'", "''")}'`)}` +
        "?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING",
    )) as { values?: unknown[][] };
    const values = response.values ?? [];
    invariant(values.length > 0, "ADAPTER_ERROR", `Tab ${title} has no header row.`);
    const headers = values[0].map(String);
    const indexes = new Map(headers.map((header, index) => [header, index]));
    if (table.columns.length === 0) {
      return values
        .slice(1)
        .map((cells, index) => ({
          rowNumber: index + 2,
          values: Object.fromEntries(
            headers.map((header, cellIndex) => [
              header,
              cells[cellIndex] == null || cells[cellIndex] === "" ? null : String(cells[cellIndex]),
            ]),
          ),
        }))
        .filter((row) => Object.values(row.values).some((value) => value !== null));
    }
    for (const column of table.columns) {
      invariant(
        indexes.has(column.name),
        "ADAPTER_ERROR",
        `Tab ${title} is missing declared column ${column.name}.`,
      );
    }
    if (
      headers.length === table.columns.length &&
      table.columns.every((column, index) => headers[index] === column.name)
    ) {
      this.writableLayouts.add(table.tabId);
    }
    return values
      .slice(1)
      .map((cells, index) => {
        const row: Row = {};
        for (const column of table.columns)
          row[column.name] = cellValue(cells[indexes.get(column.name)!], column);
        return { rowNumber: index + 2, values: row };
      })
      .filter((row) => Object.values(row.values).some((value) => value !== null));
  }

  async append(table: TableSchema, rows: Row[]): Promise<StoredRow[]> {
    if (rows.length === 0) return [];
    await this.assertWritableLayout(table);
    const title = await this.tabTitle(table.tabId);
    const response = (await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(`'${title.replaceAll("'", "''")}'`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=false`,
      {
        method: "POST",
        body: JSON.stringify({
          majorDimension: "ROWS",
          values: rows.map((row) => table.columns.map((column) => serialize(row[column.name]))),
        }),
      },
    )) as { updates?: { updatedRange?: string } };
    const updatedRange = response.updates?.updatedRange ?? "";
    const rowMatch = /![A-Z]+(\d+):/.exec(updatedRange);
    const firstRow = rowMatch ? Number(rowMatch[1]) : 0;
    return rows.map((values, index) => ({ rowNumber: firstRow + index, values: { ...values } }));
  }

  async update(table: TableSchema, rows: StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.assertWritableLayout(table);
    await this.verifyVersions(table, rows);
    const title = await this.tabTitle(table.tabId);
    await this.request(`/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: rows.map((row) => ({
          range: `'${title.replaceAll("'", "''")}'!A${row.rowNumber}`,
          majorDimension: "ROWS",
          values: [table.columns.map((column) => serialize(row.values[column.name]))],
        })),
      }),
    });
  }

  async delete(table: TableSchema, rows: StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.verifyVersions(table, rows);
    const sheetId = Number(table.tabId);
    invariant(
      Number.isInteger(sheetId),
      "ADAPTER_ERROR",
      `Google tab id ${table.tabId} must be numeric for DELETE.`,
    );
    const sorted = [...rows].sort((a, b) => b.rowNumber - a.rowNumber);
    await this.request(`/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: sorted.map((row) => ({
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: row.rowNumber - 1, endIndex: row.rowNumber },
          },
        })),
      }),
    });
  }

  async inspect(table: TableSchema): Promise<TableInspection> {
    const title = await this.tabTitle(table.tabId);
    const response = (await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(`'${title.replaceAll("'", "''")}'`)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    )) as { values?: unknown[][] };
    const values = response.values ?? [];
    const headers = (values[0] ?? []).map(String);
    const samples = values.slice(1, 51);
    return {
      table: table.name,
      tabId: table.tabId,
      title,
      headers,
      rowCount: Math.max(0, values.length - 1),
      inferredColumns: headers.map((header, index) =>
        inferColumn(
          header,
          samples.map((row) => row[index]),
        ),
      ),
    };
  }

  async initialize(table: TableSchema): Promise<void> {
    invariant(
      table.columns.length > 0,
      "VALIDATION_ERROR",
      `Compact table ${table.name} cannot be initialized without a typed schema.`,
    );
    const title = await this.tabTitle(table.tabId);
    const inspection = await this.inspect(table);
    const expected = table.columns.map((column) => column.name);
    if (inspection.headers.length > 0) {
      invariant(
        inspection.headers.length === expected.length &&
          expected.every((name, index) => inspection.headers[index] === name),
        "ADAPTER_ERROR",
        `Cannot initialize ${table.name}: the tab already has a different header row.`,
        { expected, actual: inspection.headers },
      );
      this.writableLayouts.add(table.tabId);
      return;
    }
    await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(`'${title.replaceAll("'", "''")}'!A1`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ majorDimension: "ROWS", values: [expected] }) },
    );
    this.writableLayouts.add(table.tabId);
  }

  async doctor(): Promise<DoctorResult> {
    const metadata = (await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}?fields=spreadsheetId,properties.title`,
    )) as { spreadsheetId?: string; properties?: { title?: string } };
    return {
      ok: metadata.spreadsheetId === this.spreadsheetId,
      spreadsheetId: metadata.spreadsheetId,
      message: `Authenticated and connected to ${metadata.properties?.title ?? this.spreadsheetId}.`,
    };
  }

  private async verifyVersions(table: TableSchema, rows: StoredRow[]): Promise<void> {
    const guarded = rows.filter((row) => row.expectedVersion !== undefined);
    if (guarded.length === 0) return;
    const versionIndex = table.columns.findIndex((column) => column.name === "_shql_version");
    invariant(versionIndex >= 0, "SCHEMA_ERROR", `${table.name} does not declare _shql_version.`);
    const title = await this.tabTitle(table.tabId);
    const column = columnLetter(versionIndex);
    const parameters = new URLSearchParams({
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    for (const row of guarded)
      parameters.append("ranges", `'${title.replaceAll("'", "''")}'!${column}${row.rowNumber}`);
    const response = (await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values:batchGet?${parameters.toString()}`,
    )) as { valueRanges?: Array<{ values?: unknown[][] }> };
    invariant(
      response.valueRanges?.length === guarded.length,
      "CONFLICT",
      `Unable to verify current versions in ${table.name}.`,
    );
    guarded.forEach((row, index) => {
      const current = Number(response.valueRanges![index]?.values?.[0]?.[0]);
      invariant(
        Number.isFinite(current) && current === row.expectedVersion,
        "CONFLICT",
        `Row ${row.rowNumber} in ${table.name} changed after it was read.`,
        { expectedVersion: row.expectedVersion, currentVersion: Number.isFinite(current) ? current : null },
      );
    });
  }

  private async assertWritableLayout(table: TableSchema): Promise<void> {
    invariant(table.columns.length > 0, "ADAPTER_ERROR", `Compact table ${table.name} is read-only.`);
    if (this.writableLayouts.has(table.tabId)) return;
    const title = await this.tabTitle(table.tabId);
    const response = (await this.request(
      `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(`'${title.replaceAll("'", "''")}'!1:1`)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    )) as { values?: unknown[][] };
    const headers = (response.values?.[0] ?? []).map(String);
    const expected = table.columns.map((column) => column.name);
    invariant(
      headers.length === expected.length && expected.every((name, index) => headers[index] === name),
      "ADAPTER_ERROR",
      `Cannot write ${table.name}: tab headers must exactly match schema order. Expected ${expected.join(", ")}.`,
      { actual: headers },
    );
    this.writableLayouts.add(table.tabId);
  }

  private async tabTitle(tabId: string): Promise<string> {
    if (!this.tabs) {
      const metadata = (await this.request(
        `/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}?fields=sheets.properties(sheetId,title)`,
      )) as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };
      this.tabs = new Map();
      for (const sheet of metadata.sheets ?? []) {
        const id = sheet.properties?.sheetId;
        const title = sheet.properties?.title;
        if (id !== undefined && title) this.tabs.set(String(id), title);
      }
    }
    const title = this.tabs.get(String(tabId));
    invariant(title, "ADAPTER_ERROR", `Spreadsheet does not contain tab id ${tabId}.`);
    return title;
  }

  private async accessToken(): Promise<string> {
    if (this.auth.type === "access-token") return this.auth.accessToken;
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (this.auth.type === "oauth") {
      const response = await this.fetcher(this.auth.tokenUri ?? "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.auth.clientId,
          client_secret: this.auth.clientSecret,
          refresh_token: this.auth.refreshToken,
        }),
      });
      const body = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
      };
      invariant(
        response.ok && body.access_token,
        "AUTH_ERROR",
        body.error_description ?? "Google OAuth token refresh failed.",
      );
      this.token = {
        value: body.access_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
      return this.token.value;
    }
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = this.auth.tokenUri ?? "https://oauth2.googleapis.com/token";
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64Url(
      JSON.stringify({
        iss: this.auth.clientEmail,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    );
    const unsigned = `${header}.${claim}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(this.auth.privateKey, "base64url")}`;
    const response = await this.fetcher(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    invariant(
      response.ok && body.access_token,
      "AUTH_ERROR",
      body.error_description ?? "Google service-account authentication failed.",
    );
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const retryable = new Set([429, 500, 502, 503, 504]);
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.fetcher(`https://sheets.googleapis.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; status?: string };
      };
      if (response.ok) return body;
      if (retryable.has(response.status) && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 250 * 2 ** attempt + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new ShqlError(
        "ADAPTER_ERROR",
        body.error?.message ?? `Google Sheets API returned HTTP ${response.status}.`,
        {
          status: response.status,
          googleStatus: body.error?.status,
          attempts: attempt + 1,
        },
      );
    }
    throw new ShqlError("ADAPTER_ERROR", "Google Sheets request exhausted retries.");
  }
}
