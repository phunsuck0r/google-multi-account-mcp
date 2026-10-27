import { createHash } from "node:crypto";

function req(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const encryptionSecret = req("ENCRYPTION_KEY");
if (encryptionSecret.length < 32) throw new Error("ENCRYPTION_KEY must be at least 32 characters");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Render sets RENDER_EXTERNAL_URL automatically; elsewhere set BASE_URL.
  baseUrl: req("BASE_URL", process.env.RENDER_EXTERNAL_URL).replace(/\/$/, ""),
  databaseUrl: req("DATABASE_URL"),
  googleClientId: req("GOOGLE_CLIENT_ID"),
  googleClientSecret: req("GOOGLE_CLIENT_SECRET"),
  // Only these Google identities may authorise the connector itself.
  ownerEmails: list(req("OWNER_EMAILS")),
  // Any long random secret; hashed to a 32-byte AES key. Encrypts mailbox refresh tokens at rest.
  encryptionKey: createHash("sha256").update(encryptionSecret).digest(),
  // Addresses forward_to_allowlist may send to without a draft step. Empty disables the tool.
  forwardAllowlist: list(process.env.FORWARD_ALLOWLIST),
  // Hosts allowed as OAuth redirect targets for dynamically registered clients.
  allowedRedirectHosts: list(process.env.ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com"),
  defaultTimeZone: process.env.DEFAULT_TZ || "UTC",
  // Database TLS: on unless DATABASE_SSL=false (e.g. a local Postgres).
  databaseSsl: process.env.DATABASE_SSL !== "false",
};

export const mcpUrl = new URL(`${config.baseUrl}/mcp`);
export const googleCallbackUrl = `${config.baseUrl}/oauth/google/callback`;
