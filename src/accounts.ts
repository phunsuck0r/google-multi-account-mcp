import { google, type gmail_v1, type calendar_v3 } from "googleapis";
import { q } from "./db.js";
import { decrypt, encrypt, token } from "./crypto.js";
import { config } from "./config.js";
import { oauthClient } from "./google.js";

export type Account = { label: string; email: string; is_default: boolean };

export async function listAccounts(): Promise<Account[]> {
  return q("select label, email, is_default from accounts order by label");
}

/**
 * Resolve an account selector to one or more accounts.
 * Accepts a label, a full address, a domain ("company.com"), "all", or nothing (default account).
 */
export async function resolve(selector: string | undefined, allowAll = false): Promise<Account[]> {
  const accounts = await listAccounts();
  if (!accounts.length) throw new Error("No mailboxes connected yet. Use add_account to connect one.");
  const s = selector?.trim().toLowerCase();
  if (!s) {
    const def = accounts.find((a) => a.is_default) ?? (accounts.length === 1 ? accounts[0] : undefined);
    if (!def) throw new Error(`No default account set. Specify account. Connected: ${accounts.map((a) => `${a.label} <${a.email}>`).join(", ")}`);
    return [def];
  }
  if (s === "all") {
    if (!allowAll) throw new Error('"all" is only valid for read/search tools. Pick a single account.');
    return accounts;
  }
  const exact = accounts.filter((a) => a.label.toLowerCase() === s || a.email === s);
  if (exact.length) return exact;
  const domain = accounts.filter((a) => a.email.endsWith(`@${s.replace(/^@/, "")}`));
  if (domain.length === 1 || (allowAll && domain.length)) return domain;
  if (domain.length > 1) throw new Error(`"${selector}" matches several accounts: ${domain.map((a) => a.label).join(", ")}. Be specific.`);
  throw new Error(`Unknown account "${selector}". Connected: ${accounts.map((a) => `${a.label} <${a.email}>`).join(", ")}`);
}

export async function resolveOne(selector: string | undefined): Promise<Account> {
  return (await resolve(selector, false))[0];
}

const clientCache = new Map<string, ReturnType<typeof oauthClient>>();

async function authFor(label: string) {
  const cached = clientCache.get(label);
  if (cached) return cached;
  const rows = await q("select refresh_token_enc from accounts where label=$1", [label]);
  if (!rows[0]) throw new Error(`Unknown account ${label}`);
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(rows[0].refresh_token_enc) });
  client.on("tokens", async (t) => {
    if (t.refresh_token) {
      await q("update accounts set refresh_token_enc=$2, updated_at=now() where label=$1", [label, encrypt(t.refresh_token)]);
    }
  });
  clientCache.set(label, client);
  return client;
}

export async function gmailFor(label: string): Promise<gmail_v1.Gmail> {
  return google.gmail({ version: "v1", auth: await authFor(label) });
}

export async function calendarFor(label: string): Promise<calendar_v3.Calendar> {
  return google.calendar({ version: "v3", auth: await authFor(label) });
}

/** Run fn for each account with limited concurrency; failures are reported per account rather than failing the whole call. */
export async function fanOut<T>(accounts: Account[], fn: (a: Account) => Promise<T>) {
  const out: { account: string; email: string; result?: T; error?: string }[] = [];
  const queue = [...accounts];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        out.push({ account: a.label, email: a.email, result: await fn(a) });
      } catch (e: any) {
        out.push({ account: a.label, email: a.email, error: friendlyError(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, worker));
  return out.sort((x, y) => x.account.localeCompare(y.account));
}

export function friendlyError(e: any): string {
  const msg = e?.response?.data?.error_description ?? e?.response?.data?.error?.message ?? e?.message ?? String(e);
  if (/invalid_grant/i.test(msg) || /invalid_grant/i.test(JSON.stringify(e?.response?.data ?? ""))) {
    return "Google access for this account has expired or been revoked. Reconnect it with add_account using the same label.";
  }
  return msg;
}

// ---- Connecting mailboxes ----

export async function createConnectLink(label: string, setDefault: boolean): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-_]{0,39}$/i.test(label)) throw new Error("Label must be 1-40 chars: letters, numbers, - or _");
  const id = token(24);
  await q("insert into pending (id, kind, data, expires_at) values ($1,'mailbox',$2, now() + interval '15 minutes')", [
    id,
    { label: label.toLowerCase(), setDefault },
  ]);
  return `${config.baseUrl}/accounts/connect?t=${id}`;
}

export async function takeConnectRequest(id: string, consume: boolean) {
  const sql = consume
    ? "delete from pending where id=$1 and kind='mailbox' and expires_at > now() returning data"
    : "select data from pending where id=$1 and kind='mailbox' and expires_at > now()";
  const rows = await q(sql, [id]);
  return rows[0]?.data as { label: string; setDefault: boolean } | undefined;
}

export async function saveAccount(label: string, email: string, refreshToken: string, scopes: string, setDefault: boolean) {
  const existing = await q("select label from accounts where email=$1", [email]);
  if (existing[0] && existing[0].label !== label) {
    throw new Error(`${email} is already connected as "${existing[0].label}". Remove it first or reconnect with that label.`);
  }
  const count = (await q("select count(*)::int as n from accounts"))[0].n;
  await q(
    `insert into accounts (label, email, refresh_token_enc, scopes, is_default) values ($1,$2,$3,$4,$5)
     on conflict (label) do update set email=excluded.email, refresh_token_enc=excluded.refresh_token_enc,
       scopes=excluded.scopes, updated_at=now()`,
    [label, email, encrypt(refreshToken), scopes, setDefault || count === 0],
  );
  if (setDefault) await q("update accounts set is_default = (label=$1)", [label]);
  clientCache.delete(label);
}

export async function removeAccount(label: string) {
  const rows = await q("delete from accounts where label=$1 returning refresh_token_enc", [label]);
  if (!rows[0]) throw new Error(`Unknown account ${label}`);
  clientCache.delete(label);
  try {
    await oauthClient().revokeToken(decrypt(rows[0].refresh_token_enc));
  } catch {
    /* already revoked */
  }
}

export async function setDefault(label: string) {
  const rows = await q("update accounts set is_default = (label=$1) returning label, is_default", [label]);
  if (!rows.some((r) => r.is_default)) throw new Error(`Unknown account ${label}`);
}
