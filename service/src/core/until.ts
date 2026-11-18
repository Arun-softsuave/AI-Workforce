/**
 * "until Monday", "till tomorrow", "for 2 hours", "until 14:30", "until 2026-11-24", "next week" → an ISO time.
 * Days start at the start of your working hours (default 09:00, local time). undefined = not understood.
 */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseUntil(text: string | undefined, now = new Date(), dayStart = "09:00"): string | undefined {
  const t = String(text ?? "").trim().toLowerCase().replace(/^(until|till|til|to|up to)\s+/, "").replace(/[.!]$/, "");
  if (!t) return undefined;
  const [h0, m0] = (/^(\d{1,2}):(\d{2})/.exec(dayStart) ?? [, "9", "0"]).slice(1).map(Number);
  const at = (d: Date, h = h0, m = m0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const iso = (d: Date) => d.toISOString();
  if (/^(indefinitely|forever|further notice)$/.test(t)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}.*)?$/.test(t)) { const d = new Date(t.length === 10 ? `${t}T00:00:00` : t); if (!Number.isNaN(d.getTime())) return iso(t.length === 10 ? at(d) : d); }
  const hm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (hm && (hm[2] || hm[3])) {
    let h = Number(hm[1]) % 12 + (hm[3] === "pm" ? 12 : 0);
    if (!hm[3]) h = Number(hm[1]);
    const d = at(now, h, Number(hm[2] ?? 0));
    if (d <= now) d.setDate(d.getDate() + 1);
    return iso(d);
  }
  const rel = /^(?:for\s+|in\s+)?(\d+|an?|one|two|three)\s*(minute|min|hour|hr|day|week)s?$/.exec(t.replace(/^for\s+/, ""));
  if (rel) {
    const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : rel[1] === "two" ? 2 : rel[1] === "three" ? 3 : 1;
    const ms = { minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }[rel[2] as "minute"];
    return iso(new Date(now.getTime() + n * ms));
  }
  if (t === "tomorrow" || t === "tomorrow morning") { const d = at(now); d.setDate(d.getDate() + 1); return iso(d); }
  if (t === "tonight" || t === "this evening") return iso(at(now, 18, 0) > now ? at(now, 18, 0) : new Date(now.getTime() + 3_600_000));
  if (t === "next week") { const d = at(now); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return iso(d); }
  const day = DAYS.findIndex((x) => t === x || t === `next ${x}` || t === `this ${x}` || t === x.slice(0, 3));
  if (day >= 0) { const d = at(now); let add = (day - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); return iso(d); }
  return undefined;
}

/** "Monday 09:00" style label for an ISO time (local). */
export function untilLabel(isoTime: string, now = new Date()): string {
  const d = new Date(isoTime);
  const hm = d.toTimeString().slice(0, 5);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${hm}`;
  if (days === 1) return `tomorrow ${hm}`;
  if (days < 7) return `${DAYS[d.getDay()][0].toUpperCase()}${DAYS[d.getDay()].slice(1)} ${hm}`;
  return `${d.toISOString().slice(0, 10)} ${hm}`;
}
