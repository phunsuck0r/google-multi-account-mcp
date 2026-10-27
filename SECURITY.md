# Security policy

This project gives an AI assistant read and send access to email and calendars, so security reports are taken seriously.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab > Report a vulnerability) rather than opening a public issue. Include steps to reproduce and the impact you expect.

You should get an acknowledgement within a few days. Fixes are released as a new tagged version with a note in the changelog.

## Scope

In scope: the OAuth authorization server, token handling and storage, account routing, the forward allowlist, and anything that could let someone other than a configured owner read or send mail.

Out of scope: misconfigured deployments (for example a leaked `ENCRYPTION_KEY` or an over-broad `ALLOWED_REDIRECT_HOSTS`), and the behaviour of MCP clients.

## Deployer checklist

- Keep `OWNER_EMAILS` to accounts you control.
- Treat `ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET` and the database as secrets.
- Only add addresses you control to `FORWARD_ALLOWLIST`.
- Review the `audit_log` tool periodically.
- To cut off access quickly: remove the account with `remove_account`, or revoke the app at myaccount.google.com/connections.
