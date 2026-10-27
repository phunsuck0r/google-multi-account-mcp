# Changelog

## 1.1.1

### Fixed
- `calendar_create_event` and `calendar_update_event` accept times without seconds (`2026-11-03T09:00`) and read them in `time_zone` / `DEFAULT_TZ`. Previously Google rejected them with "Bad Request".

## 1.1.0

### Added
- `/setup` page: live configuration checklist (database, Google client credentials verified against Google, owners) with the exact URLs to paste into Google Cloud and Claude. Also served at `/`.
- The server now starts without Google credentials or owners, so a fresh deploy can be configured from `/setup`. Sign-in is refused until both are set.
- Draft attachments: upload files as base64 or re-use attachments from an existing message (`attach_from`) in `gmail_create_draft` and `gmail_update_draft`.
- `list_accounts` `check` option tests each mailbox's Google access and flags any that need reconnecting.
- Claude Code and other desktop clients: `localhost` and `127.0.0.1` are allowed redirect hosts by default.
- `docker-compose.yml` for single-host deployments.
- Troubleshooting guide, client setup for Claude Code, issue templates, Dependabot.

### Changed
- Calendar time windows without an offset are read in `DEFAULT_TZ` (previously treated as UTC). Bare dates mean midnight in that zone.
- `DEFAULT_TZ` is validated at start-up.
- Client registration rejects non-HTTPS redirect URIs except on loopback.
- `/healthz` checks the database and reports the version.
- MCP request size limit raised to 35 MB to allow attachments.

## 1.0.0

First public release.

- Remote MCP server (Streamable HTTP) with built-in OAuth 2.1 authorization server: dynamic client registration, PKCE, owner-only Google sign-in, rotating refresh tokens, redirect host allowlist.
- Multiple Google accounts per deployment, routed by label, address or domain, with `"all"` fan-out for read tools.
- Gmail: search, read, attachments, labels, archive/read/star, trash, drafts, replies, inline forwards with attachments, draft-then-send.
- Optional `forward_to_allowlist` for immediate forwarding to configured addresses only.
- Google Calendar: list, merged timelines, create/update/delete, invite responses, free/busy across accounts; compact list output.
- AES-256-GCM encryption of Google refresh tokens; audit log of writes.
- Render Blueprint, Dockerfile, CI with Postgres-backed tests.
