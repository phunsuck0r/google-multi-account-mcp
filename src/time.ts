/** Offset of an IANA zone from UTC at a given instant, in minutes (e.g. 60 for BST). */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Convert a timestamp to RFC 3339 UTC. Values with an explicit offset are kept as given;
 * a bare date or local date-time is read as wall-clock time in `timeZone`.
 */
export function toUtc(value: string, timeZone: string): string {
  const v = value.trim();
  if (HAS_OFFSET.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date-time: ${value}`);
    return d.toISOString();
  }
  const m = v.match(LOCAL);
  if (!m) throw new Error(`Invalid date-time: ${value}. Use e.g. 2026-11-03T09:00 or 2026-11-03.`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  // Two passes handle instants near a DST change.
  let utc = wall - offsetMinutes(wall, timeZone) * 60_000;
  utc = wall - offsetMinutes(utc, timeZone) * 60_000;
  return new Date(utc).toISOString();
}

