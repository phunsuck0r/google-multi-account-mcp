import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildMime, htmlToText, summarise } = await import("../src/mime.js");
const { cleanDescription } = await import("../src/tools/calendar.js");
const { encrypt, decrypt } = await import("../src/crypto.js");

test("buildMime produces a multipart message with encoded subject and attachment", () => {
  const raw = buildMime({
    from: "me@example.com",
    to: ["a@example.com"],
    cc: ["b@example.com"],
    subject: "Quarterly résumé",
    text: "Hello",
    html: "<p>Hello</p>",
    attachments: [{ filename: "notes.txt", mimeType: "text/plain", data: Buffer.from("hi") }],
  });
  assert.match(raw, /^From: me@example.com\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /filename="notes.txt"/);
  assert.ok(raw.includes(Buffer.from("Hello").toString("base64")));
});

test("htmlToText strips markup and decodes entities", () => {
  assert.equal(htmlToText("<style>x{}</style><p>Fish &amp; chips</p><br>Done"), "Fish & chips\n\nDone");
});

test("summarise prefers the plain-text body and lists attachments", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const m = summarise(
    {
      id: "1",
      threadId: "t",
      payload: {
        headers: [{ name: "Subject", value: "Hi" }, { name: "From", value: "x@example.com" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64("plain body") } },
          { mimeType: "text/html", body: { data: b64("<b>html</b>") } },
          { filename: "a.pdf", mimeType: "application/pdf", body: { attachmentId: "att1", size: 10 } },
        ],
      },
    },
    true,
  ) as any;
  assert.equal(m.subject, "Hi");
  assert.equal(m.body, "plain body");
  assert.deepEqual(m.attachments, [{ filename: "a.pdf", mimeType: "application/pdf", size: 10, attachmentId: "att1" }]);
});

test("cleanDescription drops conferencing boilerplate but keeps real notes", () => {
  const zoom = "Agenda: review numbers\n\nJoin Zoom Meeting\nhttps://zoom.us/j/1?pwd=x\nMeeting ID: 1\nPasscode: 2";
  assert.equal(cleanDescription(zoom, 300), "Agenda: review numbers");
  const teams = "\n" + "_".repeat(40) + "\nMicrosoft Teams meeting\nJoin: https://teams.microsoft.com/meet/1\n";
  assert.equal(cleanDescription(teams, 300), undefined);
  assert.equal(cleanDescription("x".repeat(400), 10), "xxxxxxxxxx…");
});

test("token encryption round-trips and is non-deterministic", () => {
  const a = encrypt("refresh-token");
  const b = encrypt("refresh-token");
  assert.notEqual(a, b);
  assert.equal(decrypt(a), "refresh-token");
});

test("toUtc reads local times in the given zone, including across DST", async () => {
  const { toUtc } = await import("../src/time.js");
  assert.equal(toUtc("2026-07-01T09:00", "Europe/London"), "2026-07-01T08:00:00.000Z");
  assert.equal(toUtc("2026-12-01T09:00", "Europe/London"), "2026-12-01T09:00:00.000Z");
  assert.equal(toUtc("2026-11-03", "America/New_York"), "2026-11-03T05:00:00.000Z");
  assert.equal(toUtc("2026-11-03T09:00:00+02:00", "UTC"), "2026-11-03T07:00:00.000Z");
  assert.equal(toUtc("2026-11-03T09:00:00Z", "Asia/Tokyo"), "2026-11-03T09:00:00.000Z");
  assert.throws(() => toUtc("next tuesday", "UTC"), /Invalid date-time/);
});
