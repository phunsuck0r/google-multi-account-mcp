// A fresh deployment with no Google client or owners: the server must boot, serve /setup,
// and refuse authorisation rather than fail open.
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/test";
process.env.DATABASE_SSL ??= "false";
process.env.BASE_URL = "http://localhost:0";
process.env.ENCRYPTION_KEY = "test-encryption-key-that-is-long-enough-123";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.OWNER_EMAILS;

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { migrate, pool } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");

let server: Server;
let B: string;

before(async () => {
  await migrate();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  B = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test("setup page reports what is missing", async () => {
  const html = await (await fetch(`${B}/setup`)).text();
  assert.match(html, /incomplete/);
  assert.match(html, /Set GOOGLE_CLIENT_ID/);
  assert.match(html, /Set OWNER_EMAILS/);
});

test("authorisation is refused until setup is complete", async () => {
  const client = await (
    await fetch(`${B}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }),
    })
  ).json();
  const res = await fetch(
    `${B}/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&state=s`,
    { redirect: "manual" },
  );
  const back = new URL(res.headers.get("location")!);
  assert.equal(back.host, "claude.ai");
  assert.equal(back.searchParams.get("error"), "temporarily_unavailable");
  assert.equal(back.searchParams.get("state"), "s");
});
