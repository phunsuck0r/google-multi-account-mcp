# google-multi-account-mcp

A self-hosted remote [MCP](https://modelcontextprotocol.io) connector that gives Claude (or any MCP client that supports OAuth) access to **several Gmail and Google Calendar accounts at once**: personal Gmail and any number of Google Workspace accounts, side by side, in one connector.

Built-in Google connectors typically hold one Google identity; connecting a second replaces the first. This server holds as many as you connect and routes each call by account label, address or domain, or fans out across all of them.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/phunsuck0r/google-multi-account-mcp)

## Features

- **Multi-account**: connect any number of Google accounts under short labels (`work`, `personal`, `client-a`) and pick one per call by label, address or domain. Read and search tools accept `account: "all"`.
- **Gmail**: search, read threads and messages, fetch attachments, labels, archive / read / star, trash, drafts, replies (with quoting) and inline forwards that keep attachments.
- **Calendar**: list calendars and events, merged timelines across accounts, create / update / delete events, respond to invites, free/busy across every account.
- **Safe sending by default**: mail to arbitrary recipients is always draft first, then `gmail_send_draft`, so each send is a separate, reviewable tool call.
- **Optional auto-forward allowlist**: `forward_to_allowlist` sends immediately, but only to addresses you configure (for example an AI agent's inbox), so it can be set to "always allow" in your MCP client without opening a general send path.
- **Audit log**: every write is recorded and queryable with the `audit_log` tool.

## Security model

| Layer | How it works |
|---|---|
| Who can use the connector | The server is its own OAuth 2.1 authorization server (dynamic client registration + PKCE). Signing in requires a Google account listed in `OWNER_EMAILS`; anyone else is refused. |
| Which clients can register | Redirect URIs are limited to `ALLOWED_REDIRECT_HOSTS` (default `claude.ai`, `claude.com`), so a third party cannot register a client that receives your authorization codes. |
| Connector tokens | Opaque, stored only as SHA-256 hashes. Access tokens last 1 hour; refresh tokens last 30 days and rotate on every use. |
| Mailbox tokens | Each mailbox is connected through its own Google consent, started from a single-use link that expires after 15 minutes. Google refresh tokens are encrypted at rest with AES-256-GCM. |
| Sending | Drafts first. The only immediate-send tool is restricted to `FORWARD_ALLOWLIST` and is not registered at all when that list is empty. |
| Prompt injection | The server tells clients to treat email content as data, never as instructions. Your MCP client's tool approval settings remain the final control. |

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Requirements

- A host with a public HTTPS URL (Render, Fly.io, a VPS, etc.)
- PostgreSQL
- Node 20+ (or Docker)
- Your own Google Cloud project (free). Every deployment uses its own OAuth client; there is no shared app.

## Setup

### 1. Deploy

**Render (easiest).** Click the button above. It creates a web service and a Postgres database, generates `ENCRYPTION_KEY`, and asks for the remaining variables. You can leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` blank for now and fill them in after step 2. `BASE_URL` is not needed on Render; the service's own URL is used automatically. Note the URL Render gives you (`https://<name>.onrender.com`).

**Docker / anywhere else.**

```bash
docker build -t google-multi-account-mcp .
docker run -p 3000:3000 --env-file .env google-multi-account-mcp
```

Put it behind HTTPS and copy `.env.example` to `.env`. The server creates its tables on start-up.

### 2. Google Cloud project

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. **Enable APIs**: Gmail API and Google Calendar API.
3. **Google Auth Platform > Branding**: app name, support email, and:
   - Home page `https://<your-host>`, privacy `https://<your-host>/privacy`, terms `https://<your-host>/terms` (the server serves these pages).
   - **Authorised domain**: your host. On `*.onrender.com` (a public suffix) this is the full host, e.g. `my-mcp.onrender.com`.
4. **Audience**: user type **External**, then **Publish app** (In production).
   - Apps left in *Testing* get refresh tokens that expire after 7 days, which would force you to reconnect every mailbox weekly.
   - The app will be *unverified*. That is fine for your own use: Google shows a warning on consent (**Advanced > Go to …**) and caps unverified apps at 100 users.
5. **Clients > Create client**: type **Web application**, authorised redirect URI `https://<your-host>/oauth/google/callback`.
6. Put the client ID and secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and redeploy.

**Google Workspace accounts**: if a Workspace admin policy blocks unconfigured third-party apps, mark the client ID as **Trusted** in that domain's Admin console (Security > Access and data control > API controls > Manage Third-Party App Access > Configure new app).

### 3. Add it to Claude

1. claude.ai > Settings > Connectors > **Add custom connector**.
2. URL: `https://<your-host>/mcp`. Claude detects OAuth and registers itself automatically.
3. Click **Connect** and sign in with a Google account listed in `OWNER_EMAILS`.

### 4. Connect mailboxes

In a chat: *"Add my work Google account as `work` and make it the default."* Claude calls `add_account` and gives you a one-time link. Open it, choose the account, and grant **both** Gmail and Calendar access. Repeat per account.

If you used to rely on a built-in Gmail or Calendar connector, consider turning it off so the assistant does not choose between two sets of similar tools.

## Configuration

| Variable | Required | Description |
|---|---|---|
| `BASE_URL` | yes, except on Render | Public HTTPS URL, no trailing slash. Falls back to `RENDER_EXTERNAL_URL`. |
| `DATABASE_URL` | yes | Postgres connection string. |
| `DATABASE_SSL` | no | `false` to connect without TLS (local Postgres). Default on. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | Your Google OAuth web client. |
| `OWNER_EMAILS` | yes | Comma-separated Google accounts allowed to authorise the connector. |
| `ENCRYPTION_KEY` | yes | Random string, 32+ characters. Changing or losing it means reconnecting every mailbox. |
| `FORWARD_ALLOWLIST` | no | Comma-separated addresses `forward_to_allowlist` may send to. Empty disables the tool. |
| `ALLOWED_REDIRECT_HOSTS` | no | OAuth redirect hosts clients may register. Default `claude.ai,claude.com`. Add `localhost` for local MCP clients. |
| `DEFAULT_TZ` | no | IANA zone for events created without one. Default `UTC`. |

## Tools

Every tool takes an optional `account`: a label, full address or domain. Omit it to use the default account.

| Area | Tools |
|---|---|
| Accounts | `list_accounts`, `add_account`, `remove_account`, `set_default_account`, `audit_log` |
| Gmail read | `gmail_search`*, `gmail_read_thread`, `gmail_read_message`, `gmail_get_attachment`, `gmail_list_labels`, `gmail_list_drafts` |
| Gmail write | `gmail_create_draft`, `gmail_update_draft`, `gmail_delete_draft`, `gmail_reply`, `gmail_forward`, `gmail_send_draft`, `gmail_modify`, `gmail_create_label`, `gmail_trash` |
| Auto-forward | `forward_to_allowlist` (only when `FORWARD_ALLOWLIST` is set) |
| Calendar | `calendar_list_calendars`*, `calendar_list_events`*, `calendar_get_event`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_respond`, `calendar_free_busy`* |

\* accepts `account: "all"`.

Calendar edits never email attendees unless `send_updates` is set.

## Development

```bash
npm install
cp .env.example .env    # fill in values
npm run dev             # tsx, reloads on restart
npm test                # needs a Postgres: DATABASE_URL=... DATABASE_SSL=false npm test
```

Tests cover the OAuth flow (discovery, client registration limits, owner-only sign-in, PKCE, single-use codes, refresh rotation), the MCP surface, the forward allowlist, and MIME/formatting helpers. Google API calls are not exercised in CI.

### Layout

```
src/
  index.ts           start-up: migrations, listen
  app.ts             Express app: OAuth endpoints, Google callback, /mcp
  oauthProvider.ts   OAuth 2.1 authorization server for MCP clients
  google.ts          Google OAuth helpers
  accounts.ts        account registry, routing, encrypted token storage
  mime.ts            message parsing and MIME building
  tools/             MCP tools (admin, gmail, calendar)
```

## Limitations

- One owner per deployment by design (`OWNER_EMAILS` can list several identities, but they all see every connected mailbox).
- Personal-use only as an unverified Google app. Offering it to others would need Google's OAuth verification, including a security assessment for the Gmail scope.
- Calendar time windows should be given with an explicit offset (e.g. `2026-11-03T00:00:00Z`).

## Licence

[MIT](LICENSE)
