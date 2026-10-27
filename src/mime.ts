import type { gmail_v1 } from "googleapis";
import { randomBytes } from "node:crypto";

type Part = gmail_v1.Schema$MessagePart;

export const header = (msg: gmail_v1.Schema$Message | Part | undefined, name: string) =>
  ((msg as gmail_v1.Schema$Message)?.payload ?? (msg as Part))?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

const b64u = (s: string) => Buffer.from(s, "base64url");

function walk(p: Part | undefined, fn: (p: Part) => void) {
  if (!p) return;
  fn(p);
  p.parts?.forEach((c) => walk(c, fn));
}

export function bodies(payload: Part | undefined) {
  let text = "";
  let html = "";
  walk(payload, (p) => {
    if (p.filename) return;
    if (p.mimeType === "text/plain" && p.body?.data && !text) text = b64u(p.body.data).toString("utf8");
    if (p.mimeType === "text/html" && p.body?.data && !html) html = b64u(p.body.data).toString("utf8");
  });
  return { text, html };
}

export function htmlToText(html: string) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function attachments(payload: Part | undefined) {
  const out: { filename: string; mimeType: string; size: number; attachmentId: string }[] = [];
  walk(payload, (p) => {
    if (p.filename && p.body?.attachmentId) {
      out.push({ filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body.size ?? 0, attachmentId: p.body.attachmentId });
    }
  });
  return out;
}

const MAX_BODY = 20000;

export function summarise(m: gmail_v1.Schema$Message, includeBody: boolean) {
  const base = {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    cc: header(m, "Cc") || undefined,
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    labels: m.labelIds ?? [],
    snippet: m.snippet ?? "",
  };
  if (!includeBody) return base;
  const { text, html } = bodies(m.payload);
  let body = text || htmlToText(html);
  const truncated = body.length > MAX_BODY;
  if (truncated) body = body.slice(0, MAX_BODY);
  return { ...base, body, bodyTruncated: truncated || undefined, attachments: attachments(m.payload) };
}

// ---- Building outgoing MIME ----

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
/** Header values that are written verbatim must not contain line breaks, or they could smuggle extra headers (e.g. a hidden Bcc). */
const headerValue = (name: string, s: string) => {
  if (/[\r\n]/.test(s)) throw new Error(`${name} must not contain line breaks`);
  return s;
};
/** Quoted MIME parameter: encoded if non-ASCII, with quotes and backslashes escaped. */
const quotedParam = (s: string) => encWord(s).replace(/["\\]/g, "\\$&");
const wrap76 = (b64: string) => b64.replace(/.{76}/g, "$&\r\n");
const boundary = () => `b_${randomBytes(12).toString("hex")}`;

export type OutAttachment = { filename: string; mimeType: string; data: Buffer };

export function buildMime(o: {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutAttachment[];
}): string {
  const h: string[] = [];
  if (o.from) h.push(`From: ${headerValue("From", o.from)}`);
  h.push(`To: ${headerValue("To", o.to.join(", "))}`);
  if (o.cc?.length) h.push(`Cc: ${headerValue("Cc", o.cc.join(", "))}`);
  if (o.bcc?.length) h.push(`Bcc: ${headerValue("Bcc", o.bcc.join(", "))}`);
  h.push(`Subject: ${encWord(o.subject)}`);
  if (o.inReplyTo) h.push(`In-Reply-To: ${headerValue("In-Reply-To", o.inReplyTo)}`);
  if (o.references) h.push(`References: ${headerValue("References", o.references)}`);
  h.push("MIME-Version: 1.0");

  const textPart = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(o.text).toString("base64"))}`;
  let body: string;
  if (o.html) {
    const b = boundary();
    const htmlPart = `Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(o.html).toString("base64"))}`;
    body = `Content-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${textPart}\r\n--${b}\r\n${htmlPart}\r\n--${b}--`;
  } else {
    body = textPart;
  }

  if (o.attachments?.length) {
    const b = boundary();
    const parts = [body, ...o.attachments.map((a) =>
      `Content-Type: ${headerValue("Attachment MIME type", a.mimeType)}; name="${quotedParam(a.filename)}"\r\nContent-Disposition: attachment; filename="${quotedParam(a.filename)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(a.data.toString("base64"))}`)];
    body = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.map((p) => `--${b}\r\n${p}`).join("\r\n")}\r\n--${b}--`;
  }
  return `${h.join("\r\n")}\r\n${body}\r\n`;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
