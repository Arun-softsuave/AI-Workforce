import fs from "node:fs";
import path from "node:path";
import { aiwHome, ensureDir } from "../core/paths.js";
import { getSecret } from "../core/secrets.js";
import { sha256, sleep, truncate } from "../core/util.js";

/**
 * Figma accuracy (W12, W13, module 5.11a).
 *  - exactValues(): sizes, spacing, colours, typography, effects, tokens and component states AS-IS (never condensed).
 *  - getFrame(): one frame through the Figma REST API, cached by file key + node id + file version.
 *  - frameImage(): the frame rendered once per file version, cached as a PNG.
 *  - framePointer(): name -> node id, kept in the design document so a later agent asks for exactly that frame.
 *  - diffValues() / watchVersions(): the Figma version watch -> `design_changed` events.
 */

// ------------------------------------------------------------------ dependencies (injectable for tests)

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean; status: number; headers?: { get(name: string): string | null };
  json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; text?(): Promise<string>;
}>;

export interface FigmaDeps {
  fetch?: FetchLike;
  /** Figma personal access token; defaults to the OS vault ("figma.token"). */
  token?: () => string | undefined;
  /** Cache folder; defaults to <AIW_HOME>/cache/figma. */
  cacheDir?: string;
}

const API = process.env.AIW_FIGMA_API ?? "https://api.figma.com";

function cacheDir(d?: FigmaDeps): string {
  return ensureDir(d?.cacheDir ?? path.join(aiwHome(), "cache", "figma"));
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-");

async function figmaGet(d: FigmaDeps | undefined, url: string, auth = true): Promise<any> {
  const f: FetchLike = d?.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const headers: Record<string, string> = {};
  if (auth) {
    const token = (d?.token ?? (() => getSecret("figma.token")))();
    if (!token) throw new Error("Figma is not connected – run `aiw connect figma`");
    headers["X-Figma-Token"] = token;
  }
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, { headers });
    if (res.ok) return auth ? res.json() : res.arrayBuffer();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const ra = Number(res.headers?.get("retry-after") ?? "");
      await sleep(Math.min(10_000, ra > 0 ? ra * 1000 : 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 403) throw new Error("Figma refused the request – the token may have expired or has no access to this file");
    if (res.status === 404) throw new Error("Figma file or frame not found");
    throw new Error(`Figma request failed (${res.status})`);
  }
}

// ------------------------------------------------------------------ exact values

/** One layer's exact values. `props` maps a property name to its value written as-is. */
export interface ExactLayer { path: string; id: string; type: string; props: Record<string, string> }

/** Names for style ids ("S:123" -> "Primary/500") and variable ids ("VariableID:1:2" -> "color/brand"). */
export type NameMap = Record<string, string>;

/**
 * Figma stores numbers as 32-bit floats (0.8 arrives as 0.800000011920929). Seven significant digits is exactly what a
 * 32-bit float holds, so this only removes storage noise – a design value is never rounded.
 */
export function num(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(7)));
}

const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();

/** Figma colour {r,g,b,a} (0..1) -> "#RRGGBB" plus the opacity when it is not fully opaque. */
export function colour(c: any, paintOpacity = 1): string {
  if (!c) return "";
  const a = (c.a ?? 1) * paintOpacity;
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${a < 1 ? ` ${num(Math.round(a * 1e6) / 1e4)}%` : ""}`;
}

function paint(p: any, names: NameMap): string {
  if (p.visible === false) return "";
  const token = p.boundVariables?.color?.id ? ` (${names[p.boundVariables.color.id] ?? p.boundVariables.color.id})` : "";
  if (p.type === "SOLID") return colour(p.color, p.opacity ?? 1) + token;
  if (p.type?.startsWith("GRADIENT")) {
    const stops = (p.gradientStops ?? []).map((s: any) => `${colour(s.color)} ${num(s.position * 100)}%`).join(", ");
    return `${p.type.replace("GRADIENT_", "").toLowerCase()} gradient(${stops})${p.opacity !== undefined && p.opacity < 1 ? ` opacity ${num(p.opacity)}` : ""}`;
  }
  if (p.type === "IMAGE") return `image (${(p.scaleMode ?? "fill").toLowerCase()})`;
  return p.type?.toLowerCase() ?? "";
}

function effect(e: any, names: NameMap): string {
  if (e.visible === false) return "";
  const kind = String(e.type ?? "").toLowerCase().replace(/_/g, " ");
  if (/SHADOW/.test(e.type)) {
    const token = e.boundVariables ? Object.values(e.boundVariables).map((v: any) => names[v?.id] ?? v?.id).filter(Boolean) : [];
    return `${kind} x ${num(e.offset?.x ?? 0)} y ${num(e.offset?.y ?? 0)} blur ${num(e.radius ?? 0)} spread ${num(e.spread ?? 0)} ${colour(e.color)}${token.length ? ` (${token.join(", ")})` : ""}`;
  }
  return `${kind} ${num(e.radius ?? 0)}`;
}

function lineHeight(s: any): string | undefined {
  if (s.lineHeightUnit === "INTRINSIC_%" || (s.lineHeightPx === undefined && s.lineHeightPercentFontSize === undefined)) return s.lineHeightPx === undefined ? undefined : "auto";
  if (s.lineHeightUnit === "FONT_SIZE_%" && s.lineHeightPercentFontSize !== undefined) return `${num(s.lineHeightPercentFontSize)}%`;
  return s.lineHeightPx !== undefined ? `${num(s.lineHeightPx)}px` : undefined;
}

function variantOf(n: any): string | undefined {
  const cp = n.componentProperties;
  if (cp && typeof cp === "object") {
    const v = Object.entries(cp).filter(([, p]: any) => p?.type === "VARIANT").map(([k, p]: any) => `${k.replace(/#.*$/, "")}=${p.value}`);
    if (v.length) return v.join(", ");
  }
  if (n.type === "COMPONENT" && /=/.test(n.name ?? "")) return n.name;
  return undefined;
}

/** Exact values of one layer (no children). */
export function layerValues(n: any, names: NameMap = {}): Record<string, string> {
  const p: Record<string, string> = {};
  const box = n.absoluteBoundingBox ?? (n.size ? { width: n.size.x, height: n.size.y } : undefined);
  if (box && box.width !== undefined) p.size = `${num(box.width)}×${num(box.height)}`;
  if (n.layoutSizingHorizontal || n.layoutSizingVertical) p.sizing = `${(n.layoutSizingHorizontal ?? "fixed").toLowerCase()} / ${(n.layoutSizingVertical ?? "fixed").toLowerCase()}`;
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) if (typeof n[k] === "number") p[k.replace(/([A-Z])/g, " $1").toLowerCase()] = num(n[k]);
  if (n.layoutMode && n.layoutMode !== "NONE") {
    p.layout = n.layoutMode === "HORIZONTAL" ? "row" : n.layoutMode === "VERTICAL" ? "column" : n.layoutMode.toLowerCase();
    if (n.layoutWrap === "WRAP") p.layout += " wrap";
    p.gap = n.primaryAxisAlignItems === "SPACE_BETWEEN" ? "auto (space between)" : num(n.itemSpacing ?? 0);
    if (typeof n.counterAxisSpacing === "number") p["row gap"] = num(n.counterAxisSpacing);
    if (n.primaryAxisAlignItems) p["align main"] = n.primaryAxisAlignItems.toLowerCase().replace(/_/g, " ");
    if (n.counterAxisAlignItems) p["align cross"] = n.counterAxisAlignItems.toLowerCase().replace(/_/g, " ");
  }
  const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
  if (pad.some((v) => typeof v === "number" && v !== 0)) {
    const [t, r, b, l] = pad.map((v) => num(v ?? 0));
    p.padding = t === r && r === b && b === l ? t : t === b && r === l ? `${t} ${r}` : `${t} ${r} ${b} ${l}`;
  }
  if (Array.isArray(n.rectangleCornerRadii) && new Set(n.rectangleCornerRadii).size > 1) p["corner radius"] = n.rectangleCornerRadii.map(num).join(" ");
  else if (typeof n.cornerRadius === "number" && n.cornerRadius !== 0) p["corner radius"] = num(n.cornerRadius);
  if (typeof n.opacity === "number" && n.opacity < 1) p.opacity = num(n.opacity);
  if (n.blendMode && !["PASS_THROUGH", "NORMAL"].includes(n.blendMode)) p.blend = n.blendMode.toLowerCase();
  const fills = (n.fills ?? []).map((f: any) => paint(f, names)).filter(Boolean);
  if (fills.length) p.fill = fills.join(" + ");
  const strokes = (n.strokes ?? []).map((f: any) => paint(f, names)).filter(Boolean);
  if (strokes.length) {
    const w = n.individualStrokeWeights
      ? [n.individualStrokeWeights.top, n.individualStrokeWeights.right, n.individualStrokeWeights.bottom, n.individualStrokeWeights.left].map(num).join(" ")
      : num(n.strokeWeight ?? 1);
    p.stroke = `${strokes.join(" + ")} ${w}px${n.strokeAlign ? ` ${n.strokeAlign.toLowerCase()}` : ""}${n.strokeDashes?.length ? " dashed" : ""}`;
  }
  const effects = (n.effects ?? []).map((e: any) => effect(e, names)).filter(Boolean);
  if (effects.length) p.effects = effects.join("; ");
  if (n.type === "TEXT") {
    const s = n.style ?? {};
    if (s.fontFamily) p.font = `${s.fontFamily}${s.fontPostScriptName ? ` (${s.fontPostScriptName})` : ""}`;
    if (s.fontSize !== undefined) p["font size"] = num(s.fontSize);
    if (s.fontWeight !== undefined) p["font weight"] = num(s.fontWeight);
    if (s.italic) p["font style"] = "italic";
    const lh = lineHeight(s);
    if (lh) p["line height"] = lh;
    if (s.letterSpacing !== undefined && s.letterSpacing !== 0) p["letter spacing"] = `${num(s.letterSpacing)}px`;
    if (s.textCase && s.textCase !== "ORIGINAL") p["text case"] = s.textCase.toLowerCase();
    if (s.textDecoration && s.textDecoration !== "NONE") p["text decoration"] = s.textDecoration.toLowerCase();
    if (s.textAlignHorizontal && s.textAlignHorizontal !== "LEFT") p["text align"] = s.textAlignHorizontal.toLowerCase();
    if (typeof n.characters === "string") p.text = JSON.stringify(n.characters.length > 400 ? truncate(n.characters, 400) : n.characters);
  }
  // styles (named text / colour / effect styles) and variables (design tokens) bound to this layer
  const styles = Object.entries(n.styles ?? {}).map(([k, id]: any) => `${k}: ${names[id] ?? id}`);
  if (styles.length) p.styles = styles.join(", ");
  const vars = new Set<string>();
  const collect = (v: any) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(collect);
    else if (v.type === "VARIABLE_ALIAS" && v.id) vars.add(names[v.id] ?? v.id);
    else if (typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(n.boundVariables);
  for (const x of [...(n.fills ?? []), ...(n.strokes ?? []), ...(n.effects ?? [])]) if (x?.visible !== false) collect(x?.boundVariables);
  if (vars.size) p.tokens = [...vars].join(", ");
  const variant = variantOf(n);
  if (variant) p.variant = variant;
  if (n.type === "COMPONENT_SET") {
    const vs = (n.children ?? []).filter((c: any) => c.type === "COMPONENT").map((c: any) => c.name);
    if (vs.length) p.variants = vs.join(" | ");
  }
  return p;
}

/**
 * Every visible layer of a node with its exact values (depth-first, at most `maxLayers`).
 * The layer path is the chain of layer names ("Reply chips › Chip › Label").
 */
export function exactValues(nodeJson: any, names: NameMap = {}, maxLayers = 400): ExactLayer[] {
  const out: ExactLayer[] = [];
  const seen = new Map<string, number>();
  const walk = (n: any, parent: string) => {
    if (!n || n.visible === false || out.length >= maxLayers) return;
    let p = parent ? `${parent} › ${n.name ?? n.type}` : String(n.name ?? n.type);
    const dup = seen.get(p) ?? 0;                       // two siblings with the same name: "Chip", "Chip #2"
    seen.set(p, dup + 1);
    if (dup) p = `${p} #${dup + 1}`;
    out.push({ path: p, id: String(n.id ?? ""), type: String(n.type ?? ""), props: layerValues(n, names) });
    for (const c of n.children ?? []) walk(c, p);
  };
  walk(nodeJson, "");
  return out;
}

/** The exact values as text for an agent prompt – every value as-is. */
export function formatExact(layers: ExactLayer[]): string {
  return layers.map((l) => {
    const depth = l.path.split(" › ").length - 1;
    const name = l.path.split(" › ").pop();
    const props = Object.entries(l.props).map(([k, v]) => `${k} ${v}`).join("; ");
    return `${"  ".repeat(depth)}- ${l.type} ${name} [${l.id}]${props ? `: ${props}` : ""}`;
  }).join("\n");
}

// ------------------------------------------------------------------ frame pointers

export interface FramePointer { name: string; nodeId: string; fileKey: string; link: string }

/** name -> node id, kept in the design document so a later agent asks for exactly that frame. */
export function framePointer(name: string, nodeId: string, fileKey: string): FramePointer {
  const id = nodeId.replace("-", ":");
  return { name, nodeId: id, fileKey, link: `https://www.figma.com/design/${fileKey}/?node-id=${id.replace(":", "-")}` };
}

/** One line for the design document: `- Chat / Reply chips → 12:345 (https://…)`. */
export function framePointerLine(p: FramePointer): string {
  return `- ${p.name} → ${p.nodeId} (${p.link})`;
}

/** Reads the frame pointers back from a design document. */
export function parseFramePointers(text: string): FramePointer[] {
  const out: FramePointer[] = [];
  const re = /^- (.+?) → (\d+:\d+) \(https:\/\/www\.figma\.com\/design\/([A-Za-z0-9]+)\/[^)]*\)\s*$/gm;
  for (let m; (m = re.exec(text));) out.push(framePointer(m[1], m[2], m[3]));
  return out;
}

// ------------------------------------------------------------------ fetching with a version cache

/** The file's current version – one cheap call (depth=1). */
export async function fileVersion(fileKey: string, deps?: FigmaDeps): Promise<{ version: string; lastModified?: string; name?: string }> {
  const f = await figmaGet(deps, `${API}/v1/files/${encodeURIComponent(fileKey)}?depth=1`);
  return { version: String(f.version ?? f.lastModified ?? ""), lastModified: f.lastModified, name: f.name };
}

export type FrameNeed = "values" | "visual";

export interface Frame {
  fileKey: string; nodeId: string; name: string; type: string; version: string;
  layers: ExactLayer[];
  /** exact values as text, ready for a prompt */
  text: string;
  pointer: FramePointer;
  /** PNG on disk (need = "visual") */
  image?: string;
  fromCache: boolean;
}

const entryFile = (d: FigmaDeps | undefined, fileKey: string, nodeId: string, version: string) =>
  path.join(cacheDir(d), "frames", `${safe(fileKey)}_${safe(nodeId)}_${sha256(version).slice(0, 16)}.json`);

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; }
}
function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Style names come with the nodes response; variable names need the variables API (Enterprise only – skipped if refused). */
async function namesFor(fileKey: string, nodesResponse: any, deps?: FigmaDeps): Promise<NameMap> {
  const names: NameMap = {};
  for (const n of Object.values(nodesResponse?.nodes ?? {}) as any[]) {
    for (const [id, s] of Object.entries(n?.styles ?? {}) as any[]) if (s?.name) names[id] = s.name;
  }
  try {
    const v = await figmaGet(deps, `${API}/v1/files/${encodeURIComponent(fileKey)}/variables/local`);
    for (const [id, x] of Object.entries(v?.meta?.variables ?? {}) as any[]) if (x?.name) names[id] = x.name;
  } catch { /* plan without the variables API: ids stay as they are */ }
  return names;
}

/** The cached frame for an exact version, if it was fetched before. */
export function cachedFrame(fileKey: string, nodeId: string, version: string, deps?: FigmaDeps): Frame | undefined {
  const f = readJson<Frame>(entryFile(deps, fileKey, nodeId.replace("-", ":"), version));
  return f ? { ...f, fromCache: true } : undefined;
}

/**
 * One Figma frame with its exact values. Cached by file key + node id + file version, so asking again costs one
 * version call (or none, when `version` is passed). need = "visual" also renders the frame image (cached too).
 */
export async function getFrame(fileKey: string, nodeId: string, need: FrameNeed = "values", deps?: FigmaDeps & { version?: string }): Promise<Frame> {
  const id = nodeId.replace("-", ":");
  const version = deps?.version ?? (await fileVersion(fileKey, deps)).version;
  let frame = cachedFrame(fileKey, id, version, deps);
  if (!frame) {
    const r = await figmaGet(deps, `${API}/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(id)}&version=${encodeURIComponent(version)}`);
    const doc = r?.nodes?.[id]?.document;
    if (!doc) throw new Error(`Figma frame ${id} not found in file ${fileKey}`);
    const names = await namesFor(fileKey, r, deps);
    const layers = exactValues(doc, names);
    frame = {
      fileKey, nodeId: id, name: String(doc.name ?? id), type: String(doc.type ?? ""), version, layers,
      text: `# Figma frame "${doc.name}" (${id}, file version ${version})\n${formatExact(layers)}`,
      pointer: framePointer(String(doc.name ?? id), id, fileKey), fromCache: false,
    };
    writeJson(entryFile(deps, fileKey, id, version), { ...frame, image: undefined, fromCache: undefined });
  }
  if (need === "visual") frame.image = await frameImage(fileKey, id, version, deps);
  return frame;
}

/** The frame rendered as a PNG – once per file version, kept on disk. Returns the file path. */
export async function frameImage(fileKey: string, nodeId: string, version: string, deps?: FigmaDeps & { scale?: number }): Promise<string> {
  const id = nodeId.replace("-", ":");
  const file = path.join(cacheDir(deps), "images", `${safe(fileKey)}_${safe(id)}_${sha256(version).slice(0, 16)}.png`);
  if (fs.existsSync(file)) return file;
  const r = await figmaGet(deps, `${API}/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(id)}&format=png&scale=${deps?.scale ?? 2}&version=${encodeURIComponent(version)}`);
  if (r?.err) throw new Error("Figma could not render the frame image");
  const url = r?.images?.[id];
  if (!url) throw new Error(`Figma returned no image for frame ${id}`);
  const buf = Buffer.from(await figmaGet(deps, url, false));
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, buf);
  return file;
}

// ------------------------------------------------------------------ diff and version watch

/** "State=Hover, Size=Small" -> "hover, small" */
const stateName = (v: string) => v.split(/,\s*/).map((x) => x.split("=").pop()!.trim().toLowerCase()).join(", ");

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

/**
 * What changed between two versions of a frame, as short plain lines ("Chip: padding 12 -> 16").
 * Layers are matched by node id first, then by path. The root frame's own values have no layer prefix.
 */
export function diffValues(oldLayers: ExactLayer[], newLayers: ExactLayer[]): string[] {
  const out: string[] = [];
  const root = newLayers[0]?.path ?? oldLayers[0]?.path ?? "";
  const label = (l: ExactLayer) => {
    const rel = l.path === root ? "" : l.path.startsWith(`${root} › `) ? l.path.slice(root.length + 3) : l.path;
    return rel ? `${rel}: ` : "";
  };
  const oldById = new Map(oldLayers.filter((l) => l.id).map((l) => [l.id, l]));
  const oldByPath = new Map(oldLayers.map((l) => [l.path, l]));
  const matched = new Set<ExactLayer>();
  const under = (p: string, roots: string[]) => roots.some((r) => p.startsWith(`${r} › `));
  const added: string[] = [];
  for (const n of newLayers) {
    const o = (n.id && oldById.get(n.id)) || oldByPath.get(n.path);
    if (!o || matched.has(o)) {
      if (under(n.path, added)) continue;                 // the layers inside a new layer are part of it
      added.push(n.path);
      out.push(n.props.variant ? `new ${stateName(n.props.variant)} state` : `new layer ${n.path.split(" › ").pop()}`);
      continue;
    }
    matched.add(o);
    const pre = label(n);
    if (o.path !== n.path && o.path.split(" › ").pop() !== n.path.split(" › ").pop()) out.push(`${pre}renamed from ${o.path.split(" › ").pop()}`);
    for (const k of new Set([...Object.keys(o.props), ...Object.keys(n.props)])) {
      const a = o.props[k], b = n.props[k];
      if (a === b) continue;
      if (k === "variants") continue;                     // reported through the variant layers themselves
      if (a === undefined) out.push(`${pre}${k} added: ${short(b!)}`);
      else if (b === undefined) out.push(`${pre}${k} removed (was ${short(a)})`);
      else out.push(`${pre}${k} ${short(a)} -> ${short(b)}`);
    }
  }
  const removed: string[] = [];
  for (const o of oldLayers) {
    if (matched.has(o) || under(o.path, removed)) continue;
    removed.push(o.path);
    out.push(o.props.variant ? `${stateName(o.props.variant)} state removed` : `layer ${o.path.split(" › ").pop()} removed`);
  }
  return out;
}

export interface WatchEntry {
  fileKey: string;
  frames: { nodeId: string; name?: string }[];
  /** the active item (task) using these frames */
  itemId?: string;
  /** version the item last saw; when omitted the watch's own record is used */
  lastVersion?: string;
}

export interface DesignChangedEvent {
  type: "design_changed";
  itemId?: string; fileKey: string; nodeId: string; frameName: string;
  oldVersion: string; newVersion: string;
  /** short plain lines, e.g. "padding 12 -> 16"; empty when the frame itself did not change */
  changes: string[];
  /** false when no earlier copy of the frame was cached, so the exact differences are unknown */
  compared: boolean;
}

const watchFile = (d?: FigmaDeps) => path.join(cacheDir(d), "watch.json");

/** The version the watch last saw per file. */
export function watchedVersions(deps?: FigmaDeps): Record<string, string> {
  return readJson<Record<string, string>>(watchFile(deps)) ?? {};
}

/**
 * The Figma version watch (checked with the Jira poll): one cheap version call per file. For every file whose version
 * moved, each watched frame is fetched again and diffed against the cached copy. A `design_changed` event is returned
 * only for frames that really changed (or could not be compared). The first sighting of a file only records it.
 */
export async function watchVersions(entries: WatchEntry[], deps?: FigmaDeps): Promise<DesignChangedEvent[]> {
  const seen = watchedVersions(deps);
  const events: DesignChangedEvent[] = [];
  const versions = new Map<string, string>();
  for (const e of entries) {
    if (!versions.has(e.fileKey)) {
      try { versions.set(e.fileKey, (await fileVersion(e.fileKey, deps)).version); }
      catch { continue; }                                    // Figma down or not connected: try again next poll
    }
    const now = versions.get(e.fileKey)!;
    const before = e.lastVersion ?? seen[e.fileKey];
    if (!before || before === now) {
      // nothing to compare yet: make sure the current copy is cached for the next change
      if (!before) for (const f of e.frames) await getFrame(e.fileKey, f.nodeId, "values", { ...deps, version: now }).catch(() => undefined);
      continue;
    }
    for (const f of e.frames) {
      let fresh: Frame;
      try { fresh = await getFrame(e.fileKey, f.nodeId, "values", { ...deps, version: now }); }
      catch { continue; }
      const old = cachedFrame(e.fileKey, f.nodeId, before, deps);
      const changes = old ? diffValues(old.layers, fresh.layers) : [];
      if (old && !changes.length) continue;
      events.push({
        type: "design_changed", itemId: e.itemId, fileKey: e.fileKey, nodeId: fresh.nodeId, frameName: f.name ?? fresh.name,
        oldVersion: before, newVersion: now, changes, compared: !!old,
      });
    }
  }
  const next = { ...seen };
  for (const [k, v] of versions) next[k] = v;
  writeJson(watchFile(deps), next);
  return events;
}

/** The short Teams message for a design change (W13): "Design of 'Chat / Reply chips' changed: padding 12 -> 16. Adapt?" */
export function designChangedMessage(ev: DesignChangedEvent, ask = true): string {
  const top = ev.changes.slice(0, 3).join(", ");
  const more = ev.changes.length > 3 ? ` and ${ev.changes.length - 3} more` : "";
  const what = ev.compared ? `: ${top}${more}` : " (could not compare with the earlier copy)";
  return `Design of '${ev.frameName}' changed${what}.${ask ? " Adapt?" : ""}`;
}
