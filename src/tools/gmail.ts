import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "googleapis";
import { fanOut, gmailFor, resolve, resolveOne, type Account } from "../accounts.js";
import { audit } from "../db.js";
import { config } from "../config.js";
import { attachments, bodies, buildMime, escapeHtml, header, htmlToText, summarise, type OutAttachment } from "../mime.js";
import { accountArg, accountOrAllArg, emailList, ok, safe } from "./util.js";

const RO = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const SENDS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

const MAX_FORWARD_BYTES = 24 * 1024 * 1024;

async function send(gmail: gmail_v1.Gmail, raw: string, threadId?: string) {
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: threadId ? { threadId } : {},
    media: { mimeType: "message/rfc822", body: raw },
  });
  return res.data;
}

async function createDraft(gmail: gmail_v1.Gmail, raw: string, threadId?: string) {
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: threadId ? { threadId } : {} },
    media: { mimeType: "message/rfc822", body: raw },
  });
  return res.data;
}

async function labelIds(gmail: gmail_v1.Gmail, names: string[] = []) {
  if (!names.length) return [];
  const labels = (await gmail.users.labels.list({ userId: "me" })).data.labels ?? [];
  return names.map((n) => {
    const l = labels.find((x) => x.id === n || x.name?.toLowerCase() === n.toLowerCase());
    if (!l?.id) throw new Error(`Label not found: ${n}`);
    return l.id;
  });
}

/** Build a Gmail-style inline forward of a message, re-attaching its attachments. */
async function buildForward(gmail: gmail_v1.Gmail, account: Account, messageId: string, to: string[], note?: string) {
  const m = (await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" })).data;
  const { text, html } = bodies(m.payload);
  const fields = ["From", "Date", "Subject", "To", "Cc"]
    .map((h) => [h, header(m, h)] as const)
    .filter(([, v]) => v);
  const hdrText = `---------- Forwarded message ---------\n${fields.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n`;
  const hdrHtml = `<div>---------- Forwarded message ---------<br>${fields.map(([k, v]) => `${k}: ${escapeHtml(v)}`).join("<br>")}</div><br>`;
  const notePrefix = note ? `${note}\n\n` : "";

  const atts: OutAttachment[] = [];
  let total = 0;
  for (const a of attachments(m.payload)) {
    total += a.size;
    if (total > MAX_FORWARD_BYTES) throw new Error("Attachments exceed Gmail's size limit for forwarding");
    const data = (await gmail.users.messages.attachments.get({ userId: "me", messageId, id: a.attachmentId })).data.data ?? "";
    atts.push({ filename: a.filename, mimeType: a.mimeType, data: Buffer.from(data, "base64url") });
  }

  const subject = header(m, "Subject");
  const raw = buildMime({
    from: account.email,
    to,
    subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
    text: notePrefix + hdrText + (text || htmlToText(html)),
    html: html ? `${note ? `<div>${escapeHtml(note).replace(/\n/g, "<br>")}</div><br>` : ""}${hdrHtml}${html}` : undefined,
    attachments: atts,
  });
  return { raw, subject, attachmentCount: atts.length };
}

export function registerGmailTools(server: McpServer) {
  server.registerTool(
    "gmail_search",
    {
      title: "Search Gmail",
      description:
        'Search messages with Gmail query syntax (e.g. "is:unread newer_than:1d", "from:bob has:attachment"). Use account="all" to search every connected mailbox. Returns headers and snippets; use gmail_read_thread for full content.',
      inputSchema: {
        account: accountOrAllArg,
        query: z.string().describe("Gmail search query"),
        max_results: z.number().int().min(1).max(100).default(20).describe("Per account"),
        page_token: z.string().optional().describe("Only valid for a single account"),
      },
      annotations: RO,
    },
    safe(async ({ account, query, max_results, page_token }) => {
      const accounts = await resolve(account, true);
      const results = await fanOut(accounts, async (a) => {
        const gmail = await gmailFor(a.label);
        const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: max_results, pageToken: accounts.length === 1 ? page_token : undefined });
        const msgs = await Promise.all(
          (list.data.messages ?? []).map(async (m) =>
            summarise((await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] })).data, false),
          ),
        );
        return { messages: msgs, nextPageToken: list.data.nextPageToken ?? undefined };
      });
      return ok(accounts.length === 1 ? { account: results[0].account, ...(results[0].result ?? { error: results[0].error }) } : results);
    }),
  );

  server.registerTool(
    "gmail_read_thread",
    {
      title: "Read Gmail thread",
      description: "Read every message in a thread, with bodies and attachment metadata.",
      inputSchema: { account: accountArg, thread_id: z.string() },
      annotations: RO,
    },
    safe(async ({ account, thread_id }) => {
      const a = await resolveOne(account);
      const t = (await (await gmailFor(a.label)).users.threads.get({ userId: "me", id: thread_id, format: "full" })).data;
      return ok({ account: a.label, threadId: t.id, messages: (t.messages ?? []).map((m) => summarise(m, true)) });
    }),
  );

  server.registerTool(
    "gmail_read_message",
    {
      title: "Read Gmail message",
      description: "Read one message with body and attachment metadata.",
      inputSchema: { account: accountArg, message_id: z.string() },
      annotations: RO,
    },
    safe(async ({ account, message_id }) => {
      const a = await resolveOne(account);
      const m = (await (await gmailFor(a.label)).users.messages.get({ userId: "me", id: message_id, format: "full" })).data;
      return ok({ account: a.label, ...summarise(m, true) });
    }),
  );

  server.registerTool(
    "gmail_get_attachment",
    {
      title: "Get Gmail attachment",
      description: "Fetch an attachment. Text-like files are returned as text, images as images, other files as an embedded base64 resource.",
      inputSchema: {
        account: accountArg,
        message_id: z.string(),
        attachment_id: z.string(),
        filename: z.string().optional(),
        mime_type: z.string().optional(),
      },
      annotations: RO,
    },
    safe(async ({ account, message_id, attachment_id, filename, mime_type }) => {
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      if (!mime_type || !filename) {
        const m = (await gmail.users.messages.get({ userId: "me", id: message_id, format: "full" })).data;
        const meta = attachments(m.payload).find((x) => x.attachmentId === attachment_id);
        mime_type ??= meta?.mimeType;
        filename ??= meta?.filename;
      }
      const data = (await gmail.users.messages.attachments.get({ userId: "me", messageId: message_id, id: attachment_id })).data.data ?? "";
      const buf = Buffer.from(data, "base64url");
      const mt = mime_type ?? "application/octet-stream";
      if (/^text\/|json|xml|csv/.test(mt)) return ok(buf.toString("utf8"));
      if (/^image\//.test(mt)) return { content: [{ type: "image", data: buf.toString("base64"), mimeType: mt }] };
      return {
        content: [{ type: "resource", resource: { uri: `attachment://${a.label}/${message_id}/${encodeURIComponent(filename ?? attachment_id)}`, mimeType: mt, blob: buf.toString("base64") } }],
      };
    }),
  );

  server.registerTool(
    "gmail_list_labels",
    { title: "List Gmail labels", description: "List labels for an account.", inputSchema: { account: accountArg }, annotations: RO },
    safe(async ({ account }) => {
      const a = await resolveOne(account);
      const labels = (await (await gmailFor(a.label)).users.labels.list({ userId: "me" })).data.labels ?? [];
      return ok(labels.map((l) => ({ id: l.id, name: l.name, type: l.type })));
    }),
  );

  server.registerTool(
    "gmail_create_label",
    { title: "Create Gmail label", description: "Create a label (use / for nesting, e.g. Clients/Acme).", inputSchema: { account: accountArg, name: z.string() }, annotations: WRITE },
    safe(async ({ account, name }) => {
      const a = await resolveOne(account);
      const l = (await (await gmailFor(a.label)).users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } })).data;
      await audit("gmail_create_label", a.label, { name });
      return ok({ id: l.id, name: l.name });
    }),
  );

  server.registerTool(
    "gmail_modify",
    {
      title: "Label / archive / mark Gmail",
      description: "Add or remove labels on messages or threads, with shortcuts for archive, read/unread and star.",
      inputSchema: {
        account: accountArg,
        message_ids: z.array(z.string()).optional(),
        thread_ids: z.array(z.string()).optional(),
        add_labels: z.array(z.string()).optional().describe("Label names or IDs"),
        remove_labels: z.array(z.string()).optional().describe("Label names or IDs"),
        archive: z.boolean().optional(),
        mark_read: z.boolean().optional().describe("true = read, false = unread"),
        star: z.boolean().optional().describe("true = star, false = unstar"),
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const a = await resolveOne(args.account);
      const gmail = await gmailFor(a.label);
      const add = await labelIds(gmail, args.add_labels);
      const remove = await labelIds(gmail, args.remove_labels);
      if (args.archive) remove.push("INBOX");
      if (args.mark_read === true) remove.push("UNREAD");
      if (args.mark_read === false) add.push("UNREAD");
      if (args.star === true) add.push("STARRED");
      if (args.star === false) remove.push("STARRED");
      if (!add.length && !remove.length) throw new Error("Nothing to change");
      if (!args.message_ids?.length && !args.thread_ids?.length) throw new Error("Provide message_ids or thread_ids");
      if (args.message_ids?.length) {
        await gmail.users.messages.batchModify({ userId: "me", requestBody: { ids: args.message_ids, addLabelIds: add, removeLabelIds: remove } });
      }
      for (const id of args.thread_ids ?? []) {
        await gmail.users.threads.modify({ userId: "me", id, requestBody: { addLabelIds: add, removeLabelIds: remove } });
      }
      await audit("gmail_modify", a.label, { messages: args.message_ids, threads: args.thread_ids, add, remove });
      return ok({ account: a.label, added: add, removed: remove, messages: args.message_ids?.length ?? 0, threads: args.thread_ids?.length ?? 0 });
    }),
  );

  server.registerTool(
    "gmail_trash",
    {
      title: "Trash / untrash Gmail",
      description: "Move messages or threads to Trash (recoverable for 30 days), or restore them.",
      inputSchema: {
        account: accountArg,
        message_ids: z.array(z.string()).optional(),
        thread_ids: z.array(z.string()).optional(),
        restore: z.boolean().default(false).describe("true to untrash"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async ({ account, message_ids, thread_ids, restore }) => {
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      for (const id of message_ids ?? []) {
        if (restore) await gmail.users.messages.untrash({ userId: "me", id });
        else await gmail.users.messages.trash({ userId: "me", id });
      }
      for (const id of thread_ids ?? []) {
        if (restore) await gmail.users.threads.untrash({ userId: "me", id });
        else await gmail.users.threads.trash({ userId: "me", id });
      }
      await audit(restore ? "gmail_untrash" : "gmail_trash", a.label, { message_ids, thread_ids });
      return ok({ account: a.label, restored: restore, messages: message_ids?.length ?? 0, threads: thread_ids?.length ?? 0 });
    }),
  );

  // ---- Drafts and sending ----

  server.registerTool(
    "gmail_list_drafts",
    { title: "List Gmail drafts", description: "List drafts for an account.", inputSchema: { account: accountArg, max_results: z.number().int().min(1).max(50).default(20) }, annotations: RO },
    safe(async ({ account, max_results }) => {
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      const list = (await gmail.users.drafts.list({ userId: "me", maxResults: max_results })).data.drafts ?? [];
      const drafts = await Promise.all(
        list.map(async (d) => {
          const full = (await gmail.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" })).data;
          return { draftId: d.id, ...summarise(full.message!, false) };
        }),
      );
      return ok({ account: a.label, drafts });
    }),
  );

  const draftFields = {
    to: emailList,
    cc: emailList.optional(),
    bcc: emailList.optional(),
    subject: z.string(),
    body: z.string().describe("Plain text body"),
    html_body: z.string().optional().describe("Optional HTML version"),
  };

  server.registerTool(
    "gmail_create_draft",
    { title: "Create Gmail draft", description: "Create a new draft. Send it with gmail_send_draft.", inputSchema: { account: accountArg, ...draftFields }, annotations: WRITE },
    safe(async (args) => {
      const a = await resolveOne(args.account);
      const raw = buildMime({ from: a.email, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.body, html: args.html_body });
      const d = await createDraft(await gmailFor(a.label), raw);
      await audit("gmail_create_draft", a.label, { draftId: d.id, to: args.to, subject: args.subject });
      return ok({ account: a.label, draftId: d.id, messageId: d.message?.id });
    }),
  );

  server.registerTool(
    "gmail_update_draft",
    { title: "Update Gmail draft", description: "Replace a draft's content.", inputSchema: { account: accountArg, draft_id: z.string(), ...draftFields }, annotations: WRITE },
    safe(async (args) => {
      const a = await resolveOne(args.account);
      const gmail = await gmailFor(a.label);
      const existing = (await gmail.users.drafts.get({ userId: "me", id: args.draft_id, format: "metadata" })).data;
      const raw = buildMime({
        from: a.email, to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.body, html: args.html_body,
        inReplyTo: header(existing.message, "In-Reply-To") || undefined, references: header(existing.message, "References") || undefined,
      });
      const d = (await gmail.users.drafts.update({
        userId: "me", id: args.draft_id,
        requestBody: { id: args.draft_id, message: existing.message?.threadId ? { threadId: existing.message.threadId } : {} },
        media: { mimeType: "message/rfc822", body: raw },
      })).data;
      await audit("gmail_update_draft", a.label, { draftId: d.id });
      return ok({ account: a.label, draftId: d.id });
    }),
  );

  server.registerTool(
    "gmail_delete_draft",
    { title: "Delete Gmail draft", description: "Delete a draft.", inputSchema: { account: accountArg, draft_id: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
    safe(async ({ account, draft_id }) => {
      const a = await resolveOne(account);
      await (await gmailFor(a.label)).users.drafts.delete({ userId: "me", id: draft_id });
      await audit("gmail_delete_draft", a.label, { draft_id });
      return ok({ account: a.label, deleted: draft_id });
    }),
  );

  server.registerTool(
    "gmail_send_draft",
    {
      title: "Send Gmail draft",
      description: "Send an existing draft. This is the only way to send new mail, replies or forwards to arbitrary recipients.",
      inputSchema: { account: accountArg, draft_id: z.string() },
      annotations: SENDS,
    },
    safe(async ({ account, draft_id }) => {
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      const draft = (await gmail.users.drafts.get({ userId: "me", id: draft_id, format: "metadata" })).data;
      const m = (await gmail.users.drafts.send({ userId: "me", requestBody: { id: draft_id } })).data;
      await audit("gmail_send_draft", a.label, { draft_id, messageId: m.id, to: header(draft.message, "To"), subject: header(draft.message, "Subject") });
      return ok({ account: a.label, sent: true, messageId: m.id, threadId: m.threadId, to: header(draft.message, "To"), subject: header(draft.message, "Subject") });
    }),
  );

  server.registerTool(
    "gmail_reply",
    {
      title: "Draft Gmail reply",
      description: "Create a reply draft in the original thread (with quoted original). Send it with gmail_send_draft.",
      inputSchema: {
        account: accountArg,
        message_id: z.string().describe("Message being replied to"),
        body: z.string(),
        reply_all: z.boolean().default(false),
        cc: emailList.optional().describe("Extra Cc recipients"),
        include_quote: z.boolean().default(true),
      },
      annotations: WRITE,
    },
    safe(async ({ account, message_id, body, reply_all, cc, include_quote }) => {
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      const m = (await gmail.users.messages.get({ userId: "me", id: message_id, format: "full" })).data;
      const self = a.email.toLowerCase();
      const split = (s: string) => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean);
      const notSelf = (x: string) => !x.toLowerCase().includes(self);
      const fromSelf = header(m, "From").toLowerCase().includes(self);
      let to = fromSelf ? split(header(m, "To")) : [header(m, "Reply-To") || header(m, "From")];
      let ccList = cc ?? [];
      if (reply_all) {
        const extra = [...(fromSelf ? [] : split(header(m, "To"))), ...split(header(m, "Cc"))].filter(notSelf);
        ccList = [...new Set([...ccList, ...extra.filter((x) => !to.includes(x))])];
      }
      to = to.filter(Boolean);
      const subject = header(m, "Subject");
      const msgId = header(m, "Message-ID") || header(m, "Message-Id");
      const refs = [header(m, "References"), msgId].filter(Boolean).join(" ");
      let text = body;
      if (include_quote) {
        const { text: ot, html: oh } = bodies(m.payload);
        const orig = (ot || htmlToText(oh)).slice(0, 10000);
        text += `\n\nOn ${header(m, "Date")}, ${header(m, "From")} wrote:\n${orig.split("\n").map((l) => `> ${l}`).join("\n")}`;
      }
      const raw = buildMime({ from: a.email, to, cc: ccList, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text, inReplyTo: msgId, references: refs });
      const d = await createDraft(gmail, raw, m.threadId ?? undefined);
      await audit("gmail_reply", a.label, { draftId: d.id, inReplyTo: message_id, to, cc: ccList });
      return ok({ account: a.label, draftId: d.id, to, cc: ccList, note: "Draft created. Use gmail_send_draft to send." });
    }),
  );

  server.registerTool(
    "gmail_forward",
    {
      title: "Draft Gmail forward",
      description: "Create a forward draft (inline, attachments included) to any recipient. Send it with gmail_send_draft. If the destination is on the deployer allowlist, forward_to_allowlist sends immediately instead.",
      inputSchema: { account: accountArg, message_id: z.string(), to: emailList, note: z.string().optional() },
      annotations: WRITE,
    },
    safe(async ({ account, message_id, to, note }) => {
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      const f = await buildForward(gmail, a, message_id, to, note);
      const d = await createDraft(gmail, f.raw);
      await audit("gmail_forward_draft", a.label, { draftId: d.id, message_id, to });
      return ok({ account: a.label, draftId: d.id, subject: f.subject, attachments: f.attachmentCount, note: "Draft created. Use gmail_send_draft to send." });
    }),
  );

  // Optional: immediate forwarding to a fixed allowlist (e.g. an agent's inbox), so it can be auto-approved safely.
  if (!config.forwardAllowlist.length) return;
  server.registerTool(
    "forward_to_allowlist",
    {
      title: "Forward to allowlisted address",
      description: `Immediately forward one or more messages (inline, with attachments) to an allowlisted address. Allowed destinations: ${config.forwardAllowlist.join(", ")}. Cannot send anywhere else; use gmail_forward for other recipients.`,
      inputSchema: {
        account: accountArg,
        message_ids: z.array(z.string()).min(1).max(25),
        to: z.string().optional().describe(`Destination; defaults to ${config.forwardAllowlist[0]}`),
        note: z.string().optional().describe("Optional context added above the forwarded message"),
      },
      annotations: SENDS,
    },
    safe(async ({ account, message_ids, to, note }) => {
      const dest = (to ?? config.forwardAllowlist[0]).trim().toLowerCase();
      if (!config.forwardAllowlist.includes(dest)) {
        throw new Error(`Destination ${to} is not allowlisted. Allowed: ${config.forwardAllowlist.join(", ")}. Use gmail_forward for other recipients.`);
      }
      const a = await resolveOne(account);
      const gmail = await gmailFor(a.label);
      const results = [];
      for (const id of message_ids) {
        try {
          const f = await buildForward(gmail, a, id, [dest], note);
          const sent = await send(gmail, f.raw);
          results.push({ message_id: id, subject: f.subject, sent: true, sentMessageId: sent.id });
        } catch (e: any) {
          results.push({ message_id: id, sent: false, error: e?.message ?? String(e) });
        }
      }
      await audit("forward_to_allowlist", a.label, { to: dest, results });
      return ok({ account: a.label, to: dest, results });
    }),
  );
}
