# google-multi-account-mcp

A self-hosted remote [MCP](https://modelcontextprotocol.io) connector that gives Claude (or any MCP client that supports OAuth) access to **several Gmail and Google Calendar accounts at once**: personal Gmail and any number of Google Workspace accounts, side by side, in one connector.

Built-in Google connectors typically hold one Google identity; connecting a second replaces the first. This server holds as many as you connect and routes each call by account label, address or domain, or fans out across all of them.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/phunsuck0r/google-multi-account-mcp)
[![CI](https://github.com/phunsuck0r/google-multi-account-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/phunsuck0r/google-multi-account-mcp/actions/workflows/ci.yml)

## What you can ask for

- *"What's unread across all my inboxes since yesterday?"*
- *"Find the Acme contract thread in my work account and draft a reply confirming Thursday."*
- *"Forward the last three invoices from billing@supplier to my bookkeeping agent."*
- *"When am I free for an hour next week across all my calendars?"*
- *"Accept the board meeting invite on my work calendar."*

## Features

- **Multi-account**: connect any number of Google accounts under short labels (`work`, `personal`, `client-a`) and pick one per call by label, address or domain. Read and search tools accept `account: "all"`.
- **Gmail**: search, read threads and messages, fetch attachments, labels, archive / read / star, trash, drafts with attachments (uploaded or re-used from another email), replies with quoting, and inline forwards that keep attachments.
- **Calendar**: list calendars and events, merged timelines across accounts, create / update / delete events, respond to invites, free/busy across every account. Times without an offset are read in your configured time zone.
- **Safe sending by default**: mail to arbitrary recipients is always draft first, then `gmail_send_draft`, so each send is a separate, reviewable tool call.
- **Optional auto-forward allowlist**: `forward_to_allowlist` sends immediately, but only to addresses you configure (for example an AI agent's inbox), so it can be set to "always allow" in your MCP client without opening a general send path.
- **Account health**: `list_accounts` with `check: true` tests every mailbox and flags any that need reconnecting.
- **Audit log**: every write is recorded and queryable with the `audit_log` tool.
- **Guided setup**: a `/setup` page on your server shows exactly what to paste into Google Cloud and Claude, and checks your configuration live.

## Security model

| Layer | How it works |
|---|---|
| Who can use the connector | The server is its own OAuth 2.1 authorization server (dynamic client registration + PKCE). Signing in requires a Google account listed in `OWNER_EMAILS`; anyone else is refused, and nobody can sign in until it is set. |
| Which clients can register | Redirect URIs are limited to `ALLOWED_REDIRECT_HOSTS` (default `claude.ai`, `claude.com`, and `localhost` for desktop clients such as Claude Code). Non-loopback redirects must use HTTPS. |
| Connector tokens | Opaque, stored only as SHA-256 hashes. Access tokens last 1 hour; refresh tokens last 30 days and rotate on every use. |
| Mailbox tokens | Each mailbox is connected through its own Google consent, started from a single-use link that expires after 15 minutes. Google refresh tokens are encrypted at rest with AES-256-GCM. |
| Sending | Drafts first. The only immediate-send tool is restricted to `FORWARD_ALLOWLIST` and is not registered at all when that list is empty. |
| Prompt injection | The server tells clients to treat email content as data, never as instructions. Your MCP client's tool approval settings remain the final control. |
| Public pages | `/setup`, `/privacy`, `/terms` and `/healthz` show no secrets, addresses or mailbox details. |

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Requirements

- A host with a public HTTPS URL (Render, Fly.io, a VPS behind a reverse proxy, etc.)
- PostgreSQL
- Node 20+ (or Docker)
- Your own Google Cloud project (free). Every deployment uses its own OAuth client; there is no shared app.

## Setup

Allow about 15 minutes. Most of it is the Google Cloud console.

### 1. Deploy

**Render (easiest).** Click **Deploy to Render** above. It creates a web service and a Postgres database and generates `ENCRYPTION_KEY`. Leave the Google variables blank for now; enter your Google address in `OWNER_EMAILS`. The service starts without Google credentials so you can use the setup page.

> The Blueprint uses paid Render plans (Starter web service, Basic Postgres). The free web plan sleeps when idle, which makes MCP clients time out, and free Render Postgres is deleted after 30 days.

**Docker Compose (any host).**

```bash
cp .env.example .env      # set BASE_URL, OWNER_EMAILS, ENCRYPTION_KEY
docker compose up -d
```

Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel) and set `BASE_URL` to the public URL. The server creates its tables on start-up.

**Node directly.** `npm ci && npm run build && npm start` with the variables from `.env.example` in the environment.

### 2. Open the setup page

Visit `https://<your-host>/setup`. It lists what is configured, what is missing, and the exact values for the next steps.

### 3. Google Cloud project

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. **APIs & Services > Library**: enable **Gmail API** and **Google Calendar API**.
3. **Google Auth Platform > Branding**: app name, support email, then:
   - Home page `https://<your-host>`, privacy `https://<your-host>/privacy`, terms `https://<your-host>/terms` (the server serves these pages).
   - **Authorised domain**: your host. On `*.onrender.com` (a public suffix) this is the full host, e.g. `my-mcp.onrender.com`.
4. **Audience**: user type **External**, then **Publish app** (In production).
   - Apps left in *Testing* get refresh tokens that expire after 7 days, which forces you to reconnect every mailbox weekly.
   - The app will be *unverified*. That is fine for your own use: Google shows a warning on consent (**Advanced > Go to …**) and caps unverified apps at 100 users.
5. **Clients > Create client**: type **Web application**, authorised redirect URI `https://<your-host>/oauth/google/callback`.
6. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, redeploy, and reload `/setup`. It confirms Google accepts the credentials.

**Google Workspace accounts**: if a Workspace admin policy blocks unconfigured third-party apps, mark the client ID as **Trusted** in that domain's Admin console (Security > Access and data control > API controls > Manage Third-Party App Access > Configure new app).

### 4. Connect your MCP client

**Claude (web, desktop and mobile)**

1. Settings > Connectors > **Add custom connector**.
2. URL `https://<your-host>/mcp`. Claude detects OAuth and registers itself.
3. Click **Connect** and sign in with an account listed in `OWNER_EMAILS`.

On Team and Enterprise plans an owner may need to add the custom connector for the organisation first.

**Claude Code**

```bash
claude mcp add --transport http google-multi-account https://<your-host>/mcp
```

Then run `/mcp` inside Claude Code and choose the server to sign in.

**Other MCP clients**: any client that supports Streamable HTTP with OAuth 2.1 and dynamic client registration. If its OAuth callback is not on an allowed host, add the host to `ALLOWED_REDIRECT_HOSTS`.

### 5. Connect mailboxes

Ask your assistant: *"Add my work Google account as `work` and make it the default."* It calls `add_account` and returns a one-time link. Open it, choose the account, and grant **both** Gmail and Calendar access. Repeat per account.

If you used a built-in Gmail or Calendar connector before, consider turning it off so the assistant does not choose between two sets of similar tools.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | yes, except on Render | Public HTTPS URL, no trailing slash. Falls back to `RENDER_EXTERNAL_URL`. |
| `DATABASE_URL` | yes | Postgres connection string. |
| `DATABASE_SSL` | no | `false` to connect without TLS (local Postgres). Default on. |
| `ENCRYPTION_KEY` | yes | Random string, 32+ characters. Changing or losing it means reconnecting every mailbox. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | to use | Your Google OAuth web client. The server boots without them, but nobody can sign in. |
| `OWNER_EMAILS` | to use | Comma-separated Google accounts allowed to authorise the connector. |
| `FORWARD_ALLOWLIST` | no | Comma-separated addresses `forward_to_allowlist` may send to. Empty disables the tool. |
| `ALLOWED_REDIRECT_HOSTS` | no | OAuth redirect hosts clients may register. Default `claude.ai,claude.com,localhost,127.0.0.1`. |
| `DEFAULT_TZ` | no | IANA zone for calendar times given without an offset. Default `UTC`. |

## Tools

Every tool takes an optional `account`: a label, full address or domain. Omit it to use the default account.

| Area | Tools |
|---|---|
| Accounts | `list_accounts` (with optional health check), `add_account`, `remove_account`, `set_default_account`, `audit_log` |
| Gmail read | `gmail_search`*, `gmail_read_thread`, `gmail_read_message`, `gmail_get_attachment`, `gmail_list_labels`, `gmail_list_drafts` |
| Gmail write | `gmail_create_draft`, `gmail_update_draft`, `gmail_delete_draft`, `gmail_reply`, `gmail_forward`, `gmail_send_draft`, `gmail_modify`, `gmail_create_label`, `gmail_trash` |
| Auto-forward | `forward_to_allowlist` (only when `FORWARD_ALLOWLIST` is set) |
| Calendar | `calendar_list_calendars`*, `calendar_list_events`*, `calendar_get_event`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_respond`, `calendar_free_busy`* |

\* accepts `account: "all"`.

Notes:

- Calendar edits never email attendees unless `send_updates` is set.
- Drafts can carry attachments uploaded as base64 or re-used from an existing message (`attach_from`). `gmail_update_draft` replaces the whole draft, so pass attachments again to keep them.
- Messages are limited to Gmail's 25 MB.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Claude says the connector failed to connect | Open `/setup` and fix anything marked ❌. Sign-in is refused until Google credentials and `OWNER_EMAILS` are set. |
| "This Google account is not permitted" | Sign in with an address in `OWNER_EMAILS`. |
| Google: "Access blocked: app has not completed verification" | The app is still in *Testing* with you not listed as a test user. Publish it (Audience > Publish app). |
| Google: "Error 400: redirect_uri_mismatch" | The client's redirect URI must be exactly `https://<your-host>/oauth/google/callback`. |
| Google: "This app is blocked" on a Workspace account | Mark the client ID as Trusted in that domain's Admin console. |
| "Google did not return a refresh token" | Remove the app at myaccount.google.com/connections, then request a new link with `add_account`. |
| "Not all permissions were granted" | Repeat the link and tick both Gmail and Calendar on the consent screen. |
| A mailbox stops working after a week | The app is in Testing mode. Publish it, then reconnect with `add_account` using the same label. |
| A mailbox says "needs reconnect" | Its Google access was revoked or expired. Run `add_account` with the same label. |
| Calendar results are off by an hour | Set `DEFAULT_TZ` to your zone, or give times with an offset. |

## Development

```bash
npm install
cp .env.example .env    # fill in values
npm run dev             # runs src/index.ts with tsx
DATABASE_URL=postgres://... DATABASE_SSL=false npm test
```

Tests cover the OAuth flow (discovery, client registration limits, owner-only sign-in, PKCE, single-use codes, refresh rotation), first-run behaviour without Google credentials, the MCP surface, the forward allowlist, time zone handling and the MIME helpers. Google API calls are not exercised in CI.

### Layout

```
src/
  index.ts           start-up: migrations, listen
  app.ts             Express app: OAuth endpoints, Google callback, /mcp, /setup
  setup.ts           setup checklist and configuration checks
  oauthProvider.ts   OAuth 2.1 authorization server for MCP clients
  google.ts          Google OAuth helpers
  accounts.ts        account registry, routing, encrypted token storage
  mime.ts            message parsing and MIME building
  time.ts            time zone conversion
  tools/             MCP tools (admin, gmail, calendar)
```

Contributions are welcome. Please open an issue first for anything larger than a small fix.

## Limitations

- One owner per deployment by design. `OWNER_EMAILS` can list several identities, but they all see every connected mailbox.
- Personal use only as an unverified Google app. Offering it to other people would need Google's OAuth verification, including a security assessment for the Gmail scope.
- Gmail and Calendar only; no Drive, Contacts or Tasks.

## Licence

[MIT](LICENSE)
