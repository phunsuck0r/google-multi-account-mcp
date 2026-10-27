import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { q } from "./db.js";
import { sha256, token } from "./crypto.js";
import { config, mcpUrl, googleConfigured } from "./config.js";
import { ownerLoginUrl } from "./google.js";

const ACCESS_TTL = 60 * 60; // 1h
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30d, rotated on use
const CODE_TTL = 5 * 60;

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const rows = await q("select info from oauth_clients where client_id=$1", [clientId]);
    return rows[0]?.info as OAuthClientInformationFull | undefined;
  },
  async registerClient(client) {
    // Only Claude's own callback hosts may receive authorization codes.
    for (const uri of client.redirect_uris) {
      const url = new URL(uri);
      const host = url.hostname.toLowerCase();
      if (!config.allowedRedirectHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        throw new InvalidClientMetadataError(`redirect_uri host not allowed: ${host}`);
      }
      const loopback = host === "localhost" || host === "127.0.0.1";
      if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
        throw new InvalidClientMetadataError("redirect_uri must use https (http is allowed only for localhost)");
      }
    }
    const full = client as OAuthClientInformationFull;
    await q("insert into oauth_clients (client_id, info) values ($1,$2)", [full.client_id, full]);
    return full;
  },
};

async function issueTokens(clientId: string, subject: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
  const access = token();
  const refresh = token();
  await q(
    `insert into tokens (token_hash, kind, client_id, subject, resource, scopes, expires_at) values
     ($1,'access',$3,$4,$5,$6, now() + make_interval(secs => $7)),
     ($2,'refresh',$3,$4,$5,$6, now() + make_interval(secs => $8))`,
    [sha256(access), sha256(refresh), clientId, subject, resource ?? null, scopes, ACCESS_TTL, REFRESH_TTL],
  );
  return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
}

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (!googleConfigured() || !config.ownerEmails.length) {
      const back = new URL(params.redirectUri);
      back.searchParams.set("error", "temporarily_unavailable");
      back.searchParams.set("error_description", `Server setup incomplete. Open ${config.baseUrl}/setup`);
      if (params.state) back.searchParams.set("state", params.state);
      return res.redirect(back.href);
    }
    const id = token(24);
    await q("insert into pending (id, kind, data, expires_at) values ($1,'login',$2, now() + interval '10 minutes')", [
      id,
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        scopes: params.scopes ?? [],
        resource: params.resource?.href ?? null,
      },
    ]);
    res.redirect(ownerLoginUrl(`login:${id}`));
  },

  async challengeForAuthorizationCode(client, code) {
    const rows = await q("select code_challenge from auth_codes where code_hash=$1 and client_id=$2", [sha256(code), client.client_id]);
    if (!rows[0]) throw new InvalidGrantError("Unknown authorization code");
    return rows[0].code_challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const rows = await q(
      `update auth_codes set used=true where code_hash=$1 and client_id=$2 and not used and expires_at > now() returning *`,
      [sha256(code), client.client_id],
    );
    const row = rows[0];
    if (!row) throw new InvalidGrantError("Authorization code invalid, expired or already used");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    return issueTokens(client.client_id, row.subject, row.scopes, row.resource ?? undefined);
  },

  async exchangeRefreshToken(client, refreshToken) {
    const rows = await q(
      `update tokens set revoked=true where token_hash=$1 and kind='refresh' and client_id=$2 and not revoked and expires_at > now() returning *`,
      [sha256(refreshToken), client.client_id],
    );
    const row = rows[0];
    if (!row) throw new InvalidGrantError("Refresh token invalid or expired");
    if (!config.ownerEmails.includes(row.subject)) throw new InvalidGrantError("Subject no longer permitted");
    return issueTokens(client.client_id, row.subject, row.scopes, row.resource ?? undefined);
  },

  async verifyAccessToken(accessToken): Promise<AuthInfo> {
    const rows = await q(
      `select *, extract(epoch from expires_at)::bigint as exp from tokens
       where token_hash=$1 and kind='access' and not revoked and expires_at > now()`,
      [sha256(accessToken)],
    );
    const row = rows[0];
    if (!row || !config.ownerEmails.includes(row.subject)) throw new InvalidTokenError("Invalid or expired token");
    return {
      token: accessToken,
      clientId: row.client_id,
      scopes: row.scopes,
      expiresAt: Number(row.exp),
      resource: row.resource ? new URL(row.resource) : mcpUrl,
      extra: { subject: row.subject },
    };
  },

  async revokeToken(client, request) {
    await q("update tokens set revoked=true where token_hash=$1 and client_id=$2", [sha256(request.token), client.client_id]);
  },
};

/** Called from the Google callback once the owner has signed in. Returns the redirect URL back to Claude. */
export async function completeLogin(pendingId: string, email: string): Promise<string> {
  const rows = await q("delete from pending where id=$1 and kind='login' and expires_at > now() returning data", [pendingId]);
  const p = rows[0]?.data;
  if (!p) throw new Error("Sign-in request expired. Start the connection again from Claude.");
  const redirect = new URL(p.redirectUri);
  if (!config.ownerEmails.includes(email)) {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "This Google account is not permitted");
  } else {
    const code = token();
    await q(
      `insert into auth_codes (code_hash, client_id, code_challenge, redirect_uri, resource, scopes, subject, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
      [sha256(code), p.clientId, p.codeChallenge, p.redirectUri, p.resource, p.scopes, email, CODE_TTL],
    );
    redirect.searchParams.set("code", code);
  }
  if (p.state) redirect.searchParams.set("state", p.state);
  return redirect.href;
}
