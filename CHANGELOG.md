# Changelog

## 1.0.0

First public release.

- Remote MCP server (Streamable HTTP) with built-in OAuth 2.1 authorization server: dynamic client registration, PKCE, owner-only Google sign-in, rotating refresh tokens, redirect host allowlist.
- Multiple Google accounts per deployment, routed by label, address or domain, with `"all"` fan-out for read tools.
- Gmail: search, read, attachments, labels, archive/read/star, trash, drafts, replies, inline forwards with attachments, draft-then-send.
- Optional `forward_to_allowlist` for immediate forwarding to configured addresses only.
- Google Calendar: list, merged timelines, create/update/delete, invite responses, free/busy across accounts; compact list output.
- AES-256-GCM encryption of Google refresh tokens; audit log of writes.
- Render Blueprint, Dockerfile, CI with Postgres-backed tests.
