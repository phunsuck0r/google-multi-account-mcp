import { q } from "./db.js";
import { token } from "./crypto.js";
import { config } from "./config.js";

// Attachment uploads: the client PUTs raw bytes to a one-time link, so file content never
// has to pass through the model as base64 text. The unguessable id is the credential.

export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const TTL_MINUTES = 30;

export async function createUpload(filename: string, mimeType: string) {
  await q("delete from uploads where expires_at < now()");
  const id = token(24);
  await q("insert into uploads (id, filename, mime_type, expires_at) values ($1,$2,$3, now() + make_interval(mins => $4))", [id, filename, mimeType, TTL_MINUTES]);
  return { upload_id: id, upload_url: `${config.baseUrl}/uploads/${id}`, expires_in_minutes: TTL_MINUTES };
}

/** True while the link exists and has not been written to yet. */
export async function uploadPending(id: string): Promise<boolean> {
  return (await q("select 1 from uploads where id=$1 and data is null and expires_at > now()", [id])).length > 0;
}

/** Store the bytes. Each link accepts exactly one upload. */
export async function storeUpload(id: string, data: Buffer): Promise<boolean> {
  return (await q("update uploads set data=$2 where id=$1 and data is null and expires_at > now() returning id", [id, data])).length > 0;
}

/** Read an uploaded file. It stays usable until it expires, so a failed or repeated draft call can retry. */
export async function getUpload(id: string) {
  const row = (await q<{ filename: string; mime_type: string; data: Buffer | null }>("select filename, mime_type, data from uploads where id=$1 and expires_at > now()", [id]))[0];
  if (!row) throw new Error(`Upload ${id} not found or expired. Create a new one with gmail_create_upload.`);
  if (!row.data) throw new Error(`Nothing has been uploaded to ${id} yet. PUT the file to its upload_url first.`);
  return { filename: row.filename, mimeType: row.mime_type, data: row.data };
}
