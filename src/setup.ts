import { config, mcpUrl, googleCallbackUrl, googleConfigured } from "./config.js";
import { q } from "./db.js";
import { escapeHtml } from "./mime.js";

type Check = { label: string; ok: boolean | null; detail: string };

let googleCheckCache: { at: number; result: Check } | undefined;

/**
 * Validates the Google client ID and secret without user interaction: exchanging a
 * deliberately invalid code returns invalid_grant when the credentials are right and
 * invalid_client when they are wrong.
 */
async function checkGoogleClient(): Promise<Check> {
  const label = "Google OAuth client ID and secret";
  if (!googleConfigured()) {
    return { label, ok: false, detail: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (step 2 below), then redeploy." };
  }
  if (googleCheckCache && Date.now() - googleCheckCache.at < 60_000) return googleCheckCache.result;
  let result: Check;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "setup-check",
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: googleCallbackUrl,
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant") result = { label, ok: true, detail: "Google accepted the client credentials." };
    else if (body.error === "redirect_uri_mismatch")
      result = { label, ok: false, detail: `Add ${googleCallbackUrl} as an authorised redirect URI on the client.` };
    else result = { label, ok: false, detail: `Google rejected the credentials (${body.error ?? res.status}). Check both values.` };
  } catch (e: any) {
    result = { label, ok: null, detail: `Could not reach Google to check (${e?.message ?? e}).` };
  }
  googleCheckCache = { at: Date.now(), result };
  return result;
}

export async function setupChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const https = config.baseUrl.startsWith("https://");
  checks.push({
    label: "Public HTTPS URL",
    ok: https || /^http:\/\/(localhost|127\.0\.0\.1)/.test(config.baseUrl) ? (https ? true : null) : false,
    detail: https ? config.baseUrl : `${config.baseUrl} (claude.ai needs a public HTTPS URL; fine for local testing only)`,
  });
  try {
    await q("select 1");
    checks.push({ label: "Database", ok: true, detail: "Connected and migrated." });
  } catch (e: any) {
    checks.push({ label: "Database", ok: false, detail: e?.message ?? String(e) });
  }
  checks.push(await checkGoogleClient());
  checks.push({
    label: "Owner accounts (OWNER_EMAILS)",
    ok: config.ownerEmails.length > 0,
    detail: config.ownerEmails.length
      ? `${config.ownerEmails.length} Google account(s) may authorise the connector.`
      : "Set OWNER_EMAILS to the Google account(s) allowed to connect Claude to this server.",
  });
  checks.push({
    label: "Auto-forward allowlist (optional)",
    ok: null,
    detail: config.forwardAllowlist.length
      ? `forward_to_allowlist enabled for ${config.forwardAllowlist.length} address(es).`
      : "Not set; forward_to_allowlist is disabled.",
  });
  return checks;
}

const icon = (ok: boolean | null) => (ok === true ? "✅" : ok === false ? "❌" : "➖");
const code = (s: string) => `<code>${escapeHtml(s)}</code>`;

export async function setupPage(): Promise<string> {
  const checks = await setupChecks();
  const ready = checks.every((c) => c.ok !== false);
  const host = new URL(config.baseUrl).host;
  const rows = checks.map((c) => `<tr><td>${icon(c.ok)}</td><td><b>${escapeHtml(c.label)}</b><br><span>${escapeHtml(c.detail)}</span></td></tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup</title>
<style>
:root{--fg:#1d1d1f;--muted:#6e6e73;--bg:#fff;--card:#f5f5f7;--accent:#0b57d0}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--bg:#141414;--card:#1f1f1f;--accent:#8ab4f8}}
body{font:15px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:720px;margin:6vh auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p.sub{color:var(--muted);margin:0 0 20px}
table{border-collapse:collapse;width:100%;background:var(--card);border-radius:10px;overflow:hidden}
td{padding:10px 12px;vertical-align:top;border-top:1px solid rgba(127,127,127,.15)}td:first-child{width:28px}
td span{color:var(--muted)}code{background:var(--card);padding:2px 6px;border-radius:5px;word-break:break-all}
ol li{margin:6px 0}.status{font-weight:600;color:${ready ? "#1e8e3e" : "#d93025"}}a{color:var(--accent)}
</style></head><body>
<h1>google-multi-account-mcp</h1>
<p class="sub">Setup status: <span class="status">${ready ? "ready" : "incomplete"}</span></p>
<table>${rows}</table>

<h2>1. Google Cloud project</h2>
<ol>
<li>Enable the <b>Gmail API</b> and <b>Google Calendar API</b>.</li>
<li>Google Auth Platform &gt; <b>Branding</b>: home page ${code(config.baseUrl)}, privacy ${code(`${config.baseUrl}/privacy`)}, terms ${code(`${config.baseUrl}/terms`)}, authorised domain ${code(host)}.</li>
<li><b>Audience</b>: External, then <b>Publish app</b> (Testing mode expires tokens after 7 days).</li>
<li><b>Clients</b> &gt; Create client &gt; Web application, authorised redirect URI ${code(googleCallbackUrl)}.</li>
</ol>

<h2>2. Server environment</h2>
<p>Set ${code("GOOGLE_CLIENT_ID")}, ${code("GOOGLE_CLIENT_SECRET")} and ${code("OWNER_EMAILS")}, redeploy, and reload this page.</p>

<h2>3. Connect your MCP client</h2>
<p>Server URL: ${code(mcpUrl.href)}</p>
<ul>
<li><b>Claude (web, desktop, mobile)</b>: Settings &gt; Connectors &gt; Add custom connector, paste the URL, then Connect and sign in with an owner account.</li>
<li><b>Claude Code</b>: ${code(`claude mcp add --transport http google-multi-account ${mcpUrl.href}`)}, then run ${code("/mcp")} to sign in.</li>
</ul>

<h2>4. Connect mailboxes</h2>
<p>Ask your assistant: <i>"Add my work Google account as work and make it the default."</i> It returns a one-time link; open it and grant Gmail and Calendar access. Repeat per account.</p>
<p class="sub">Docs: <a href="https://github.com/phunsuck0r/google-multi-account-mcp#readme">README</a></p>
</body></html>`;
}
