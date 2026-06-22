import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "../src/index.ts";

const enabled = Boolean(process.env.SHQL_SCHEMA && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

test("connects to and inspects the configured Google spreadsheet", { skip: !enabled }, async () => {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };
  const db = await connect({
    schema: process.env.SHQL_SCHEMA!,
    auth: {
      type: "service-account",
      clientEmail: credentials.client_email,
      privateKey: credentials.private_key,
      tokenUri: credentials.token_uri,
    },
  });
  assert.equal((await db.doctor()).ok, true);
  const inspections = await db.inspect();
  assert.equal(inspections.length, db.tables().length);
  assert.ok(inspections.every((inspection) => inspection.headers.length > 0));
});
