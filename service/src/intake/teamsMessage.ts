import { db, getMeta, setMeta } from "../core/db.js";
import { nowIso, truncate } from "../core/util.js";
import { redactSecrets, refsIn } from "../notify/chatLog.js";
import { wrapUntrusted } from "../policy/untrusted.js";

/**
 * The whole Teams message (W1a, module 5.16a): text, the quoted message and the attachments.
 *  - normalize():     a vendored client message (formatted or raw chat-service JSON) -> InboundMessage
 *  - recordSent():    remember the Teams id of every message we send, with its item and question key
 *  - resolveQuoted(): a quote of one of our messages -> that item and question (and whether it was already answered)
 *  - routeTarget():   which item a message is for: quoted bot message > focus item > key in text > ask
 */

export interface QuoteRef {
  messageId: string | null;
  from: string | null;
  preview: string;
  /** Present when the quote carries it (some clients quote by client id). */
  clientMessageId?: string | null;
  fromId?: string | null;
}

export interface AttachmentRef {
  /** The index readAttachment takes (files first, then pictures). */
  index: number;
  kind: "image" | "file";
  name: string;
  ext?: string;
  size?: number;
}

export interface InboundMessage {
  id: string;
  time: string;
  fromId: string;
  text: string;
  clientMessageId?: string | null;
  conversationId?: string | null;
  isMine?: boolean;
  replyTo?: QuoteRef;
  images: AttachmentRef[];
  files: AttachmentRef[];
}

// ------------------------------------------------------------------------------------------- normalize

const REPLY_RE = /<blockquote[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[^>]*>([\s\S]*?)<\/blockquote>/i;

function stripHtml(html = ""): string {
  return String(html)
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, "$1")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function jsonish(v: unknown): any {
  if (typeof v !== "string") return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
}

const mriFromUrl = (u = "") => decodeURIComponent(String(u).split("/contacts/").pop() || u);
const extOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name ?? "")?.[1] ?? "").toLowerCase();

/** Raw chat-service attachments, mirroring the vendored attachmentsOf (files first, then pasted pictures). */
function rawAttachments(m: any): AttachmentRef[] {
  const out: Omit<AttachmentRef, "index">[] = [];
  const files = jsonish(m?.properties?.files);
  for (const f of Array.isArray(files) ? files : []) {
    const name = f.fileName || f.title || "file";
    out.push({ kind: "file", name, ext: extOf(name), ...(Number(f.fileInfo?.fileSize ?? f.size) ? { size: Number(f.fileInfo?.fileSize ?? f.size) } : {}) });
  }
  let n = 0;
  for (const tag of String(m?.content ?? "").match(/<img\b[^>]*>/gi) ?? []) {
    if (!/itemtype="http:\/\/schema\.skype\.com\/AMSImage"/i.test(tag)) continue;     // emoji and outside pictures are not inputs
    const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1] ?? "";
    if (!/^https:\/\/[^/]*\.?asm\.skype\.com\//i.test(src.replace(/&amp;/g, "&"))) continue;
    out.push({ kind: "image", name: `image-${++n}`, ext: "image" });
  }
  return out.map((a, index) => ({ index, ...a }));
}

/**
 * A message from the vendored Teams client, formatted (getMessages: text, replyTo, attachments/files/images)
 * or raw (content, properties, messagetype), as one InboundMessage. Picture-only and file-only messages keep
 * an empty `text`.
 */
export function normalize(raw: any): InboundMessage {
  const isRaw = typeof raw?.content === "string" && raw?.text === undefined;
  let text: string, replyTo: QuoteRef | undefined, atts: AttachmentRef[];
  if (isRaw) {
    const content: string = raw.content;
    const q = REPLY_RE.exec(content);
    if (q) {
      const author = /<strong[^>]*itemid="([^"]+)"[^>]*>([\s\S]*?)<\/strong>/i.exec(q[1]);
      const qtd = jsonish(raw.properties?.qtdMsgs)?.[0];
      replyTo = {
        messageId: /itemid="([^"]+)"/.exec(q[0])?.[1] ?? qtd?.messageId ?? null,
        from: author ? stripHtml(author[2]) : null,
        fromId: author?.[1] ?? qtd?.sender ?? null,
        preview: stripHtml(/<p[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i.exec(q[1])?.[1] ?? ""),
      };
    }
    // AMSImage pictures carry an alt text; it is not part of what the user typed
    text = stripHtml(content.replace(REPLY_RE, "").replace(/<img\b[^>]*itemtype="http:\/\/schema\.skype\.com\/AMSImage"[^>]*>/gi, ""));
    atts = rawAttachments(raw);
  } else {
    text = String(raw?.text ?? "");
    if (raw?.replyTo) {
      replyTo = {
        messageId: raw.replyTo.messageId != null ? String(raw.replyTo.messageId) : null,
        from: raw.replyTo.from ?? null,
        preview: String(raw.replyTo.preview ?? ""),
        ...(raw.replyTo.clientMessageId ? { clientMessageId: String(raw.replyTo.clientMessageId) } : {}),
        ...(raw.replyTo.fromId ? { fromId: String(raw.replyTo.fromId) } : {}),
      };
    }
    if (Array.isArray(raw?.attachments)) {
      atts = raw.attachments.map((a: any) => ({ index: Number(a.index), kind: a.kind === "image" ? "image" : "file", name: String(a.name ?? (a.kind === "image" ? `image-${Number(a.index) + 1}` : "file")), ext: a.ext ?? extOf(a.name ?? ""), ...(a.size ? { size: Number(a.size) } : {}) }));
    } else {
      const files = (Array.isArray(raw?.files) ? raw.files : []).map((f: any, i: number) => ({ index: Number(f.index ?? i), kind: "file" as const, name: String(f.name ?? "file"), ext: extOf(f.name ?? ""), ...(f.size ? { size: Number(f.size) } : {}) }));
      const images = (Array.isArray(raw?.images) ? raw.images : []).map((im: any, i: number) => ({ index: Number(im.index ?? files.length + i), kind: "image" as const, name: String(im.name ?? `image-${i + 1}`), ext: "image" }));
      atts = [...files, ...images];
    }
    // a picture-only message's formatted text is just the picture's alt text ("image")
    if (atts.some((a) => a.kind === "image") && /^(image|picture|\s)*$/i.test(text)) text = "";
  }
  return {
    id: String(raw?.id ?? ""),
    time: String(raw?.time ?? raw?.originalarrivaltime ?? raw?.composetime ?? nowIso()),
    fromId: String(raw?.fromId ?? (raw?.from ? mriFromUrl(raw.from) : "")),
    text: text.trim(),
    clientMessageId: raw?.clientMessageId ?? raw?.clientmessageid ?? null,
    conversationId: raw?.conversationId ?? raw?.conversationid ?? null,
    ...(raw?.isMine !== undefined ? { isMine: Boolean(raw.isMine) } : {}),
    ...(replyTo ? { replyTo } : {}),
    images: atts.filter((a) => a.kind === "image"),
    files: atts.filter((a) => a.kind === "file"),
  };
}

export const hasAttachments = (m: InboundMessage) => m.images.length + m.files.length > 0;

// ------------------------------------------------------------------------------------------- sent message ids

const PREFIX_RE = /^\s*🤖\s*AI Workforce\s*/u;
/** Comparable text: no prefix, no markdown marks, no ellipsis, single spaces, lower case. */
function comparable(s: string): string {
  return redactSecrets(String(s ?? "")).replace(PREFIX_RE, "").replace(/[*`_]/g, "").replace(/[…]+\s*$/u, "").replace(/\.\.\.\s*$/, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

const extraIdKey = (id: string) => `teams.msgid.${id}`;

function setRowIds(rowId: number, ids: string[], itemId?: string | null, questionKey?: string | null): void {
  const row = db().prepare("SELECT msg_id FROM chat_log WHERE id=?").get(rowId) as { msg_id: string | null } | undefined;
  let first = !row?.msg_id;
  for (const id of ids) {
    if (first) { db().prepare("UPDATE chat_log SET msg_id=? WHERE id=?").run(id, rowId); first = false; continue; }
    if (row?.msg_id === id) continue;
    setMeta(extraIdKey(id), String(rowId));       // later parts of a split message, or the client id as well as the server id
  }
  if (itemId) db().prepare("UPDATE chat_log SET item_id=COALESCE(item_id, ?) WHERE id=?").run(itemId, rowId);
  if (questionKey) db().prepare("UPDATE chat_log SET question_key=COALESCE(question_key, ?) WHERE id=?").run(questionKey, rowId);
}

export interface SentRecord { msgId?: string | null; clientMsgId?: string | null; itemId?: string | null; questionKey?: string | null; text: string }

/**
 * Remember the Teams id of a message we sent. Call it after logChat("out", …): the row logChat wrote is found by its
 * text (a split message's parts all map to the same row) and gets msg_id, item_id and question_key. When no row
 * matches, a new "out" row is written. Returns the chat_log row id.
 */
export function recordSent(r: SentRecord): number | undefined {
  const ids = [r.msgId, r.clientMsgId].filter((x): x is string => !!x).map(String);
  const ids_ = [...new Set(ids)];
  try {
    const part = comparable(r.text);
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const rows = db().prepare("SELECT id, text, msg_id FROM chat_log WHERE direction='out' AND ts >= ? ORDER BY id DESC LIMIT 30").all(since) as { id: number; text: string; msg_id: string | null }[];
    const probe = part.slice(0, 200);
    const hit = rows.find((x) => comparable(x.text) === part) ?? (probe.length >= 8 ? rows.find((x) => comparable(x.text).includes(probe)) : undefined);
    if (hit) { setRowIds(hit.id, ids_, r.itemId, r.questionKey); return hit.id; }
    const text = redactSecrets(r.text);
    const refs = refsIn(text);
    if (r.itemId && !refs.includes(r.itemId)) refs.unshift(r.itemId);
    const res = db().prepare("INSERT INTO chat_log (ts, direction, kind, text, task_ref, refs, msg_id, item_id, question_key) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(nowIso(), "out", "chat", truncate(text, 8000), r.itemId ?? null, JSON.stringify(refs), ids_[0] ?? null, r.itemId ?? null, r.questionKey ?? null);
    const id = Number(res.lastInsertRowid);
    for (const extra of ids_.slice(1)) setMeta(extraIdKey(extra), String(id));
    return id;
  } catch { return undefined; }      // best effort: never block a message
}

/** We sent a message knowing only its client id; the poller later saw the server id. Link them. */
export function learnServerId(clientMsgId: string, serverId: string): void {
  if (!clientMsgId || !serverId || clientMsgId === serverId) return;
  try {
    const row = rowByAnyId(clientMsgId);
    if (row && !rowByAnyId(serverId)) setMeta(extraIdKey(serverId), String(row.id));
  } catch { /* best effort */ }
}

/**
 * Remember an incoming message's id, its quote and the item/question it was routed to. Updates the newest "in" row
 * with the same text (what logChat wrote), else inserts one. An answer recorded here marks the question answered.
 */
export function recordReceived(msg: InboundMessage, route: { itemId?: string | null; questionKey?: string | null } = {}): number | undefined {
  try {
    const part = comparable(msg.text);
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const rows = db().prepare("SELECT id, text FROM chat_log WHERE direction='in' AND msg_id IS NULL AND ts >= ? ORDER BY id DESC LIMIT 10").all(since) as { id: number; text: string }[];
    const hit = part ? rows.find((x) => comparable(x.text) === part) : undefined;
    if (hit) {
      db().prepare("UPDATE chat_log SET msg_id=?, reply_to=?, item_id=COALESCE(?, item_id), question_key=COALESCE(?, question_key) WHERE id=?")
        .run(msg.id || null, msg.replyTo?.messageId ?? null, route.itemId ?? null, route.questionKey ?? null, hit.id);
      return hit.id;
    }
    const text = redactSecrets(msg.text || (hasAttachments(msg) ? `[sent ${[msg.images.length ? `${msg.images.length} picture(s)` : "", msg.files.length ? `${msg.files.length} file(s)` : ""].filter(Boolean).join(" and ")}]` : ""));
    const refs = refsIn(text);
    const res = db().prepare("INSERT INTO chat_log (ts, direction, kind, text, task_ref, refs, msg_id, reply_to, item_id, question_key) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(nowIso(), "in", null, truncate(text, 8000), route.itemId ?? null, JSON.stringify(refs), msg.id || null, msg.replyTo?.messageId ?? null, route.itemId ?? null, route.questionKey ?? null);
    return Number(res.lastInsertRowid);
  } catch { return undefined; }
}

// ------------------------------------------------------------------------------------------- resolving a quote

interface LogRow { id: number; ts: string; direction: string; text: string; task_ref: string | null; refs: string | null; msg_id: string | null; item_id: string | null; question_key: string | null }

function rowByAnyId(id: string): LogRow | undefined {
  if (!id) return undefined;
  const direct = db().prepare("SELECT * FROM chat_log WHERE msg_id=? ORDER BY id DESC LIMIT 1").get(id) as LogRow | undefined;
  if (direct) return direct;
  const rowId = getMeta(extraIdKey(id));
  return rowId ? db().prepare("SELECT * FROM chat_log WHERE id=?").get(Number(rowId)) as LogRow | undefined : undefined;
}

function rowByPreview(preview: string): LogRow | undefined {
  const p = comparable(preview);
  if (p.length < 8) return undefined;
  const probe = p.slice(0, 120);
  const rows = db().prepare("SELECT * FROM chat_log WHERE direction='out' ORDER BY id DESC LIMIT 300").all() as unknown as LogRow[];
  return rows.find((r) => comparable(r.text).startsWith(probe)) ?? rows.find((r) => comparable(r.text).includes(probe));
}

export interface QuotedTarget {
  /** The quote is one of our own (bot / notification) messages. */
  bot: boolean;
  itemId?: string;
  questionKey?: string;
  /** A later reply already answered that question. */
  answered?: boolean;
  answer?: string;
  /** How the quoted message was found. */
  matchedBy: "msg_id" | "client_id" | "preview" | "none";
  rowId?: number;
}

export interface ResolveOpts {
  /** Ask the engine whether the question is still open; when given, it decides `answered`. */
  isOpen?(itemId: string, questionKey: string | undefined): boolean | undefined;
}

/** Which item and question a quoted message is about. `bot:false` when the quote is not one of our messages. */
export function resolveQuoted(replyTo: QuoteRef | undefined | null, opts: ResolveOpts = {}): QuotedTarget {
  if (!replyTo) return { bot: false, matchedBy: "none" };
  let row: LogRow | undefined, matchedBy: QuotedTarget["matchedBy"] = "none";
  try {
    if (replyTo.messageId && (row = rowByAnyId(replyTo.messageId))) matchedBy = "msg_id";
    else if (replyTo.clientMessageId && (row = rowByAnyId(replyTo.clientMessageId))) matchedBy = "client_id";
    else if ((row = rowByPreview(replyTo.preview))) matchedBy = "preview";
  } catch { row = undefined; }
  if (!row || row.direction !== "out") return { bot: false, matchedBy: row ? matchedBy : "none" };
  const refs: string[] = (() => { try { return JSON.parse(row.refs ?? "[]"); } catch { return []; } })();
  const itemId = row.item_id ?? row.task_ref ?? (refs.length === 1 ? refs[0] : undefined) ?? undefined;
  const questionKey = row.question_key ?? undefined;
  const out: QuotedTarget = { bot: true, matchedBy, rowId: row.id, ...(itemId ? { itemId } : {}), ...(questionKey ? { questionKey } : {}) };
  if (itemId) {
    const open = opts.isOpen?.(itemId, questionKey);
    const later = questionKey
      ? db().prepare("SELECT text FROM chat_log WHERE direction='in' AND item_id=? AND question_key=? AND id > ? ORDER BY id DESC LIMIT 1").get(itemId, questionKey, row.id) as { text: string } | undefined
      : undefined;
    if (open === false || (open === undefined && later)) {
      out.answered = true;
      if (later) out.answer = truncate(later.text.replace(/\s+/g, " ").trim(), 80);
    } else if (open === true || questionKey) out.answered = false;
  }
  return out;
}

// ------------------------------------------------------------------------------------------- routing

export type Route =
  | { kind: "item"; itemId: string; questionKey?: string; via: "quote" | "focus" | "text"; answered?: boolean; notice?: string; quotedContext?: string }
  | { kind: "ask"; question: string; candidates: string[]; quotedContext?: string };

export interface RouteOpts extends ResolveOpts {
  /** Open items to offer when nothing else says which item ("Is this for KAN-52 or KAN-35?"). */
  candidates?: string[];
}

/** "KAN-35 was already answered: Hide. Change it?" */
export function alreadyAnsweredText(itemId: string, answer?: string): string {
  return `${itemId} was already answered${answer ? `: ${answer}` : ""}. Change it?`;
}

function askText(candidates: string[]): string {
  const c = candidates.slice(0, 3);
  if (c.length === 0) return "Which ticket is this for?";
  if (c.length === 1) return `Is this for ${c[0]}?`;
  return `Is this for ${c.slice(0, -1).join(", ")} or ${c[c.length - 1]}?`;
}

/**
 * Which item a message is for, in this order:
 *  1. a quote of one of our messages (that item and that question, even when newer questions wait);
 *  2. the focus item (what the conversation is about right now);
 *  3. one item key named in the text;
 *  4. otherwise one short question.
 * A quote of your own or a teammate's message is passed on as `quotedContext` (fenced: data, not orders).
 */
export function routeTarget(msg: InboundMessage, focus: string | undefined | null, opts: RouteOpts = {}): Route {
  let quotedContext: string | undefined;
  if (msg.replyTo) {
    const q = resolveQuoted(msg.replyTo, opts);
    if (q.bot && q.itemId) {
      return {
        kind: "item", itemId: q.itemId, via: "quote",
        ...(q.questionKey ? { questionKey: q.questionKey } : {}),
        ...(q.answered !== undefined ? { answered: q.answered } : {}),
        ...(q.answered ? { notice: alreadyAnsweredText(q.itemId, q.answer) } : {}),
      };
    }
    if (!q.bot && msg.replyTo.preview) {
      quotedContext = wrapUntrusted(`quoted message from ${msg.replyTo.from ?? "someone"}`, msg.replyTo.preview, 2000);
    }
  }
  const extra = quotedContext ? { quotedContext } : {};
  if (focus) return { kind: "item", itemId: focus, via: "focus", ...extra };
  const keys = refsIn(msg.text);
  if (keys.length === 1) return { kind: "item", itemId: keys[0], via: "text", ...extra };
  const candidates = keys.length > 1 ? keys : (opts.candidates ?? []);
  return { kind: "ask", question: askText(candidates), candidates, ...extra };
}
