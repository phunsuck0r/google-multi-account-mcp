import "./env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { migrate, pool, q } = await import("../src/db.js");
const { createApp } = await import("../src/app.js");
const { completeLogin } = await import("../src/oauthProvider.js");

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let server: Server;
let B: string;

before(async () => {
  await migrate();
  await q("truncate oauth_clients, pending, auth_codes, tokens, accounts, audit_log");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  B = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body),
});

async function register(redirect = CALLBACK) {
  return fetch(`${B}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

/** Run /authorize and return the pending sign-in id the server put in the Google state param. */
async function startAuthorize(clientId: string, challenge: string, state: string) {
  const res = await fetch(
    `${B}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CALLBACK)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`,
    { redirect: "manual" },
  );
  assert.equal(res.status, 302);
  const google = new URL(res.headers.get("location")!);
  assert.equal(google.host, "accounts.google.com");
  return google.searchParams.get("state")!.split(":")[1];
}

async function fullLogin() {
  const client = await (await register()).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const pending = await startAuthorize(client.client_id, challenge, "s1");
  const back = new URL(await completeLogin(pending, "owner@example.com"));
  const code = back.searchParams.get("code")!;
  const tok = await (await fetch(`${B}/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK }))).json();
  return { client, code, verifier, tok };
}

async function mcp(token: string, body: unknown) {
  const res = await fetch(`${B}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
}

test("publishes OAuth discovery metadata", async () => {
  const prm = await (await fetch(`${B}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.ok(prm.resource.endsWith("/mcp"));
  const as = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json();
  assert.ok(as.registration_endpoint);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("rejects unauthenticated MCP calls with a resource metadata pointer", async () => {
  const res = await fetch(`${B}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("only allowlisted redirect hosts can register", async () => {
  assert.equal((await register()).status, 201);
  const bad = await register("https://evil.example.com/cb");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "invalid_client_metadata");
});

test("non-owner Google identities are denied", async () => {
  const client = await (await register()).json();
  const pending = await startAuthorize(client.client_id, "x".repeat(43), "s0");
  const back = new URL(await completeLogin(pending, "someone-else@example.com"));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
});

test("owner completes PKCE flow; codes are single use; refresh tokens rotate", async () => {
  const { client, code, verifier, tok } = await fullLogin();
  assert.ok(tok.access_token && tok.refresh_token);

  const reuse = await fetch(`${B}/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }));
  assert.equal(reuse.status, 400);

  const r1 = await fetch(`${B}/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }));
  assert.equal(r1.status, 200);
  const r2 = await fetch(`${B}/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }));
  assert.equal(r2.status, 400, "old refresh token must not be reusable");
});

test("authorised client can list tools and use admin tools", async () => {
  const { tok } = await fullLogin();
  const init = await mcp(tok.access_token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(init.result.serverInfo.name, "google-multi-account");

  const tools = (await mcp(tok.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.map((t: any) => t.name);
  for (const name of ["list_accounts", "add_account", "gmail_search", "gmail_send_draft", "calendar_list_events", "forward_to_allowlist"]) {
    assert.ok(tools.includes(name), `missing tool ${name}`);
  }

  const add = await mcp(tok.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_account", arguments: { label: "work" } } });
  const link = JSON.parse(add.result.content[0].text).link as string;
  const connect = await fetch(link.replace("http://localhost:0", B), { redirect: "manual" });
  const consent = new URL(connect.headers.get("location")!);
  assert.equal(consent.searchParams.get("access_type"), "offline");
  assert.match(consent.searchParams.get("scope")!, /gmail\.modify/);
  assert.match(consent.searchParams.get("scope")!, /auth\/calendar/);

  const search = await mcp(tok.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gmail_search", arguments: { query: "x" } } });
  assert.equal(search.result.isError, true);
  assert.match(search.result.content[0].text, /No mailboxes connected/);
});

test("forward_to_allowlist refuses destinations off the allowlist", async () => {
  const { tok } = await fullLogin();
  const res = await mcp(tok.access_token, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "forward_to_allowlist", arguments: { message_ids: ["1"], to: "someone@elsewhere.example" } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not allowlisted/);
});
