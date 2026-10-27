import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return (await pool.query<T>(text, params)).rows;
}

export async function migrate() {
  await pool.query(`
    create table if not exists oauth_clients (
      client_id text primary key,
      info jsonb not null,
      created_at timestamptz not null default now()
    );
    -- Pending connector authorisations (between /authorize and Google sign-in) and
    -- pending mailbox connections (between add_account link and Google consent).
    create table if not exists pending (
      id text primary key,
      kind text not null,
      data jsonb not null,
      expires_at timestamptz not null
    );
    create table if not exists auth_codes (
      code_hash text primary key,
      client_id text not null,
      code_challenge text not null,
      redirect_uri text not null,
      resource text,
      scopes text[] not null default '{}',
      subject text not null,
      expires_at timestamptz not null,
      used boolean not null default false
    );
    create table if not exists tokens (
      token_hash text primary key,
      kind text not null, -- access | refresh
      client_id text not null,
      subject text not null,
      resource text,
      scopes text[] not null default '{}',
      expires_at timestamptz not null,
      revoked boolean not null default false
    );
    create table if not exists accounts (
      label text primary key,
      email text not null unique,
      refresh_token_enc text not null,
      scopes text not null,
      is_default boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists audit_log (
      id bigserial primary key,
      at timestamptz not null default now(),
      tool text not null,
      account text,
      details jsonb
    );
  `);
}

export async function audit(tool: string, account: string | null, details: unknown) {
  await q("insert into audit_log (tool, account, details) values ($1,$2,$3)", [tool, account, JSON.stringify(details)]);
}

export async function sweep() {
  await q("delete from pending where expires_at < now()");
  await q("delete from auth_codes where expires_at < now()");
  await q("delete from tokens where expires_at < now()");
}
