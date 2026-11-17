import path from "node:path";
import { pathToFileURL } from "node:url";
import { serviceRoot } from "../core/paths.js";

/**
 * Microsoft Teams (personal / teams.live.com) – two-way chat via the vendored msteams-personal-mcp core.
 *  - Sign-in: Microsoft device code with a personal Microsoft account; token kept in the OS credential vault.
 *  - Outbound: notifications are posted as chat messages (default: your private "Notes" chat, id 48:notes).
 *  - Inbound: messages that start with "aiw" in that chat are read as commands.
 *  Two modes:
 *   - "self": signed in as YOU; notifications go to your private Notes chat; your own messages are commands.
 *   - "bot":  signed in as a separate Microsoft account (e.g. "AI Workforce Bot"); notifications arrive from the bot
 *             in its 1:1 chat with you; only messages from YOU (the owner) are commands.
 * Work/school Teams is not supported by this connector (use the Teams Workflows webhook for that).
 */
export const NOTES_CHAT = "48:notes";
export const AIW_PREFIX = "🤖 AI Workforce";

export interface TpMessage {
  id: string; conversationId: string; from: string; fromId: string; isMine: boolean; time: string; text: string;
  /** The message this one quotes (Teams "reply"), when there is one. */
  replyTo?: { messageId: string | null; from: string | null; preview: string; clientMessageId?: string | null; fromId?: string | null };
  clientMessageId?: string;
  /** Files first, then pictures: `index` is what readAttachment takes. */
  attachments?: { index: number; kind: "image" | "file"; name: string; ext?: string }[];
  images?: { index: number; name: string }[];
  files?: { name: string | null; index: number }[];
}

/** What sendMessage returns: the server id when Teams gave one, else the client id. */
export interface TpSent { sent: boolean; id?: string; messageId?: string | null; clientmessageid?: string }
export interface TpChat { id: string; title: string; type?: string; unread?: boolean }

export interface TeamsPersonalClient {
  hasSavedLogin(): boolean;
  startLogin(): Promise<{ userCode: string; verificationUrl: string; expiresAt: number }>;
  waitForLogin(): Promise<void>;
  logout(): void;
  whoAmI(): Promise<{ mri: string; region: string | null }>;
  listChats(limit?: number, type?: "chat" | "group"): Promise<TpChat[]>;
  findChats(query: string, type?: "chat" | "group"): Promise<TpChat[]>;
  getChatMembers(chatId: string): Promise<{ mri: string; name: string | null; isMe: boolean }[]>;
  sendMessage(chatId: string, text: string): Promise<TpSent>;
  getMessages(chatId: string, since?: string): Promise<TpMessage[]>;
  /**
   * Put files in the signed-in account's OneDrive ("AI Workforce/<folder>/") and return a view-only link to the
   * folder (or to the single file) that opens in the browser. Optional so test fakes may omit it.
   */
  /** One picture or file of a message (index from TpMessage.attachments), at most 10 MB. Optional so test fakes may omit it. */
  readAttachment?(chatId: string, messageId: string, index: number): Promise<{ bytes: Uint8Array; name?: string; mimeType?: string | null }>;
  listAttachments?(chatId: string, messageId: string): Promise<{ index: number; kind: "image" | "file"; name: string; ext?: string }[]>;
  shareFiles?(folder: string, files: { local: string; name: string }[]): Promise<{ url: string; files: { name: string; url: string }[] }>;
}

const GRAPH = "https://graph.microsoft.com/v1.0";

/** OneDrive upload + view link through Microsoft Graph, with the Teams sign-in (Files.ReadWrite). */
async function shareViaOneDrive(getToken: () => Promise<string>, folder: string, files: { local: string; name: string }[]): Promise<{ url: string; files: { name: string; url: string }[] }> {
  const fs = await import("node:fs");
  const token = await getToken();
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const base = `AI Workforce/${folder.replace(/[\\:*?"<>|#%]/g, "-")}`;
  const call = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`OneDrive ${init.method ?? "GET"} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<any>;
  };
  const link = async (id: string) => (await call(`${GRAPH}/me/drive/items/${id}/createLink`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "view", scope: "anonymous" }) })).link?.webUrl as string;
  const out: { name: string; url: string }[] = [];
  for (const f of files) {
    const bytes = fs.readFileSync(f.local);
    const target = `${GRAPH}/me/drive/root:/${enc(`${base}/${f.name}`)}`;
    let item: any;
    if (bytes.length <= 4 * 1024 * 1024) {
      item = await call(`${target}:/content`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    } else {
      const session = await call(`${target}:/createUploadSession`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }) });
      const chunk = 5 * 1024 * 1024;
      for (let at = 0; at < bytes.length; at += chunk) {
        const part = bytes.subarray(at, Math.min(at + chunk, bytes.length));
        const res = await fetch(session.uploadUrl, { method: "PUT", headers: { "Content-Length": String(part.length), "Content-Range": `bytes ${at}-${at + part.length - 1}/${bytes.length}` }, body: part });
        if (!res.ok && res.status !== 202) throw new Error(`OneDrive upload failed (${res.status})`);
        if (res.status === 200 || res.status === 201) item = await res.json();
      }
    }
    out.push({ name: f.name, url: (await link(item.id)) ?? item.webUrl });
  }
  if (files.length === 1) return { url: out[0].url, files: out };
  const dir = await call(`${GRAPH}/me/drive/root:/${enc(base)}`);
  return { url: (await link(dir.id)) ?? dir.webUrl, files: out };
}

let override: TeamsPersonalClient | undefined;
/** Tests inject a fake client here. */
export function setTeamsPersonalClient(c: TeamsPersonalClient | undefined): void { override = c; }

let real: TeamsPersonalClient | undefined;

export async function teamsPersonal(): Promise<TeamsPersonalClient> {
  if (override) return override;
  if (real) return real;
  const base = path.join(serviceRoot(), "vendor", "teams-personal");
  const auth: any = await import(pathToFileURL(path.join(base, "auth.js")).href);
  const core: any = await import(pathToFileURL(path.join(base, "core", "teams.js")).href);
  // the Graph token lets readAttachment fetch files shared through OneDrive (pictures work without it)
  const client = core.createTeamsClient(auth.getSkypeToken, { getGraphToken: () => auth.getGraphToken() });
  real = {
    hasSavedLogin: () => auth.hasSavedLogin(),
    startLogin: async () => { const l = await auth.startLogin(); return { userCode: l.userCode, verificationUrl: l.verificationUrl, expiresAt: l.expiresAt }; },
    waitForLogin: () => auth.waitForLogin(),
    logout: () => auth.logout(),
    whoAmI: () => client.whoAmI(),
    listChats: async (limit = 30, type) => client.listChats({ limit, type: type ?? null }),
    findChats: async (q, type) => client.findChats(q, { type: type ?? null }),
    getChatMembers: async (chatId) => client.getChatMembers(chatId),
    // mentionRecipient:false – never @mention someone just because a notification went to a 1:1 chat
    sendMessage: (chatId, text) => client.sendMessage(chatId, text, { mentionRecipient: false }),
    getMessages: (chatId, since) => client.getMessages(chatId, { limit: 30, since }),
    readAttachment: (chatId, messageId, index) => client.readAttachment(chatId, messageId, index, { maxBytes: 10 * 1024 * 1024 }),
    listAttachments: (chatId, messageId) => client.listAttachments(chatId, messageId),
    shareFiles: (folder, files) => shareViaOneDrive(() => auth.getGraphToken(), folder, files),
  };
  return real;
}
