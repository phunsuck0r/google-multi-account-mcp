import { google } from "googleapis";
import { config, googleCallbackUrl, googleConfigured } from "./config.js";

export const MAILBOX_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

export function oauthClient() {
  if (!googleConfigured()) throw new Error(`Google OAuth is not configured yet. Open ${config.baseUrl}/setup.`);
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, googleCallbackUrl);
}

/** Google sign-in used only to prove the person authorising the connector is the owner. */
export function ownerLoginUrl(state: string) {
  return oauthClient().generateAuthUrl({
    scope: ["openid", "email"],
    state,
    prompt: "select_account",
  });
}

/** Google consent for a mailbox the connector will act on. */
export function mailboxConsentUrl(state: string, loginHint?: string) {
  return oauthClient().generateAuthUrl({
    scope: MAILBOX_SCOPES,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: true,
    state,
    login_hint: loginHint,
  });
}

/** Exchange a code and return verified email plus tokens. */
export async function exchangeCode(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("Google returned no id_token");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified) throw new Error("Google account email not verified");
  return { email: payload.email.toLowerCase(), tokens };
}
