import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createConnectLink, fanOut, gmailFor, listAccounts, removeAccount, setDefault } from "../accounts.js";
import { audit, q } from "../db.js";
import { config } from "../config.js";
import { ok, safe } from "./util.js";

export function registerAdminTools(server: McpServer) {
  server.registerTool(
    "list_accounts",
    {
      title: "List connected mailboxes",
      description:
        "List connected Google accounts with their labels. Call this first when unsure which account to use. Set check=true to verify each account's Google access still works (use when calls fail or periodically).",
      inputSchema: { check: z.boolean().default(false).describe("Test each account's Google access") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ check }) => {
      const accounts = await listAccounts();
      if (!check) return ok({ accounts, forwardAllowlist: config.forwardAllowlist });
      const health = await fanOut(accounts, async (a) => (await (await gmailFor(a.label)).users.getProfile({ userId: "me" })).data.emailAddress);
      return ok({
        accounts: accounts.map((a) => {
          const h = health.find((x) => x.account === a.label);
          return { ...a, status: h?.error ? "needs reconnect" : "ok", error: h?.error };
        }),
        forwardAllowlist: config.forwardAllowlist,
      });
    }),
  );

  server.registerTool(
    "add_account",
    {
      title: "Connect a mailbox",
      description:
        "Get a one-time link (valid 15 minutes) that the user opens to connect a Google account under a short label (e.g. work, personal, client-a). Reusing an existing label reconnects that account. Show the link to the user; you cannot open it yourself.",
      inputSchema: {
        label: z.string().describe("Short name, e.g. work"),
        make_default: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ label, make_default }) => ok({ link: await createConnectLink(label, make_default), expiresInMinutes: 15 })),
  );

  server.registerTool(
    "remove_account",
    {
      title: "Disconnect a mailbox",
      description: "Disconnect an account and revoke its Google access.",
      inputSchema: { label: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async ({ label }) => {
      await removeAccount(label.toLowerCase());
      await audit("remove_account", label, {});
      return ok({ removed: label });
    }),
  );

  server.registerTool(
    "set_default_account",
    {
      title: "Set default mailbox",
      description: "Choose which account is used when none is specified.",
      inputSchema: { label: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ label }) => {
      await setDefault(label.toLowerCase());
      return ok({ default: label });
    }),
  );

  server.registerTool(
    "audit_log",
    {
      title: "Recent actions",
      description: "Show recent write actions taken through this connector (sends, forwards, label changes, calendar edits).",
      inputSchema: { limit: z.number().int().min(1).max(200).default(50), account: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ limit, account }) =>
      ok(
        await q(
          "select at, tool, account, details from audit_log where ($2::text is null or account=$2) order by id desc limit $1",
          [limit, account?.toLowerCase() ?? null],
        ),
      ),
    ),
  );
}
