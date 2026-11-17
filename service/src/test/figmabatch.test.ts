import "./helpers.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testHome } from "./helpers.js";
import {
  exactValues, formatExact, framePointer, framePointerLine, parseFramePointers, getFrame, frameImage,
  diffValues, watchVersions, designChangedMessage, num, colour, type FetchLike,
} from "../knowledge/figma.js";
import {
  queueBatchCall, flushBatch, pollBatches, getResult, takeResult, runOverdue, tickBatches, batchQueue, customIdFor,
  type BatchClient,
} from "../agents/batch.js";

// ------------------------------------------------------------------ Figma fixtures

function chips(padding: number, withHover: boolean, version: string) {
  const variants: any[] = [
    { id: "2:1", name: "State=Default", type: "COMPONENT", absoluteBoundingBox: { width: 96, height: 32 }, paddingTop: 6, paddingBottom: 6, paddingLeft: padding, paddingRight: padding, children: [] },
  ];
  if (withHover) variants.push({ id: "2:2", name: "State=Hover", type: "COMPONENT", absoluteBoundingBox: { width: 96, height: 32 }, children: [{ id: "2:3", name: "Label", type: "TEXT", characters: "Yes" }] });
  return {
    version,
    doc: {
      id: "1:2", name: "Chat / Reply chips", type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 375.5, height: 48 },
      layoutMode: "HORIZONTAL", itemSpacing: 8, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER",
      paddingTop: padding, paddingRight: padding, paddingBottom: padding, paddingLeft: padding,
      cornerRadius: 12.5,
      fills: [{ type: "SOLID", color: { r: 0.0627451, g: 0.7254902, b: 0.5058824, a: 1 }, opacity: 0.800000011920929, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:9:1" } } }],
      strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.1 } }], strokeWeight: 1, strokeAlign: "INSIDE",
      effects: [{ type: "DROP_SHADOW", visible: true, offset: { x: 0, y: 2 }, radius: 4, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
      styles: { fill: "S:1" },
      children: [
        { id: "1:3", name: "Title", type: "TEXT", characters: "Quick replies",
          style: { fontFamily: "Inter", fontSize: 14, fontWeight: 600, lineHeightPx: 20, lineHeightUnit: "PIXELS", letterSpacing: -0.1 } },
        { id: "1:4", name: "Hidden", type: "FRAME", visible: false },
        { id: "1:5", name: "Chip", type: "COMPONENT_SET", children: variants },
      ],
    },
  };
}

/** A fake Figma API: serves whichever design state `current` holds; counts calls. */
function fakeFigma() {
  const state = { current: chips(12, false, "100"), calls: [] as string[], byVersion: new Map<string, any>() };
  state.byVersion.set("100", state.current);
  const res = (body: any, status = 200) => ({
    ok: status < 400, status, headers: { get: () => null },
    json: async () => body, arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body).buffer : new ArrayBuffer(0)),
  });
  const fetch: FetchLike = async (url, init) => {
    state.calls.push(url);
    if (url.startsWith("https://img.example/")) return res("PNGDATA");
    assert.equal(init?.headers?.["X-Figma-Token"], "figd_test", "token is sent");
    const u = new URL(url);
    if (/\/variables\/local$/.test(u.pathname)) return res({ status: 403, error: true }, 403);
    if (/^\/v1\/images\//.test(u.pathname)) return res({ images: { [u.searchParams.get("ids")!]: `https://img.example/${u.searchParams.get("version")}.png` } });
    if (/\/nodes$/.test(u.pathname)) {
      const v = state.byVersion.get(u.searchParams.get("version") ?? state.current.version) ?? state.current;
      return res({ name: "App", nodes: { [u.searchParams.get("ids")!]: { document: v.doc, styles: { "S:1": { name: "Brand/Primary" } } } } });
    }
    if (/^\/v1\/files\/[^/]+$/.test(u.pathname)) return res({ name: "App", version: state.current.version, lastModified: "2026-11-01" });
    return res({}, 404);
  };
  const set = (padding: number, hover: boolean, version: string) => { state.current = chips(padding, hover, version); state.byVersion.set(version, state.current); };
  return { state, fetch, set, deps: { fetch, token: () => "figd_test", cacheDir: path.join(testHome, "figma-cache-" + Math.random().toString(36).slice(2)) } };
}

// ------------------------------------------------------------------ Figma tests

test("exact values are kept as-is: sizes, padding, gap, radius, colours, typography, effects, tokens, states", () => {
  const layers = exactValues(chips(12, true, "1").doc, { "S:1": "Brand/Primary", "VariableID:9:1": "color/brand" });
  const root = layers[0].props;
  assert.equal(root.size, "375.5×48");
  assert.equal(root.padding, "12");
  assert.equal(root.gap, "8");
  assert.equal(root.layout, "row");
  assert.equal(root["corner radius"], "12.5");
  assert.equal(root.fill, "#10B981 80% (color/brand)");
  assert.match(root.stroke, /^#000000 10% 1px inside$/);
  assert.equal(root.effects, "drop shadow x 0 y 2 blur 4 spread 0 #000000 25%");
  assert.equal(root.styles, "fill: Brand/Primary");
  assert.equal(root.tokens, "color/brand");
  const title = layers.find((l) => l.path.endsWith("Title"))!.props;
  assert.equal(title.font, "Inter");
  assert.equal(title["font size"], "14");
  assert.equal(title["font weight"], "600");
  assert.equal(title["line height"], "20px");
  assert.equal(title["letter spacing"], "-0.1px");
  assert.equal(title.text, '"Quick replies"');
  assert.ok(!layers.some((l) => l.path.endsWith("Hidden")), "hidden layers are skipped");
  const set = layers.find((l) => l.type === "COMPONENT_SET")!.props;
  assert.equal(set.variants, "State=Default | State=Hover");
  assert.equal(layers.find((l) => l.id === "2:1")!.props.padding, "6 12");
  assert.equal(num(0.800000011920929), "0.8");
  assert.equal(num(13.333), "13.333");
  assert.equal(colour({ r: 1, g: 1, b: 1, a: 1 }), "#FFFFFF");
  assert.match(formatExact(layers), /- FRAME Chat \/ Reply chips \[1:2\]: size 375.5×48/);
});

test("frame pointers round-trip through the design document", () => {
  const p = framePointer("Chat / Reply chips", "12-345", "AbCdEfGhIjKl");
  assert.equal(p.nodeId, "12:345");
  assert.equal(p.link, "https://www.figma.com/design/AbCdEfGhIjKl/?node-id=12-345");
  const doc = `# Design\n\n## Frames\n${framePointerLine(p)}\n${framePointerLine(framePointer("Empty state", "1:9", "AbCdEfGhIjKl"))}\n`;
  assert.deepEqual(parseFramePointers(doc).map((x) => `${x.name}=${x.nodeId}`), ["Chat / Reply chips=12:345", "Empty state=1:9"]);
});

test("getFrame fetches one node once per file version; a visual need also renders a cached image", async () => {
  const f = fakeFigma();
  const a = await getFrame("FILEKEY1234", "1-2", "values", f.deps);
  assert.equal(a.fromCache, false);
  assert.equal(a.version, "100");
  assert.equal(a.name, "Chat / Reply chips");
  assert.match(a.text, /padding 12/);
  const nodeCalls = () => f.state.calls.filter((u) => u.includes("/nodes")).length;
  assert.equal(nodeCalls(), 1);
  const b = await getFrame("FILEKEY1234", "1:2", "visual", f.deps);
  assert.equal(b.fromCache, true);
  assert.equal(nodeCalls(), 1, "same version -> cache");
  assert.ok(b.image && fs.existsSync(b.image));
  assert.equal(fs.readFileSync(b.image!, "utf8"), "PNGDATA");
  const imgCalls = f.state.calls.filter((u) => u.includes("/v1/images/")).length;
  await frameImage("FILEKEY1234", "1:2", "100", f.deps);
  assert.equal(f.state.calls.filter((u) => u.includes("/v1/images/")).length, imgCalls, "image is rendered once per version");
  f.set(16, false, "101");
  const c = await getFrame("FILEKEY1234", "1:2", "values", f.deps);
  assert.equal(c.fromCache, false);
  assert.equal(nodeCalls(), 2, "new version -> fetched again");
  await assert.rejects(getFrame("FILEKEY1234", "1:2", "values", { ...f.deps, token: () => undefined }), /not connected/);
});

test("diffValues gives short plain lines", () => {
  const before = exactValues(chips(12, false, "1").doc);
  const after = exactValues(chips(16, true, "2").doc);
  const lines = diffValues(before, after);
  assert.ok(lines.includes("padding 12 -> 16"), lines.join("\n"));
  assert.ok(lines.includes("new hover state"), lines.join("\n"));
  assert.ok(lines.includes("Chip › State=Default: padding 6 12 -> 6 16"), lines.join("\n"));
  assert.ok(!lines.some((l) => /Label/.test(l)), "layers inside a new layer are not listed one by one");
  assert.deepEqual(diffValues(before, exactValues(chips(12, false, "3").doc)), []);
  assert.ok(diffValues(after, before).includes("hover state removed"));
});

test("version watch: first sighting records, unchanged is quiet, a real change gives design_changed", async () => {
  const f = fakeFigma();
  const entries = [{ fileKey: "FILEKEY1234", itemId: "task_1", frames: [{ nodeId: "1:2", name: "Chat / Reply chips" }] }];
  assert.deepEqual(await watchVersions(entries, f.deps), []);
  assert.deepEqual(await watchVersions(entries, f.deps), []);
  const versionCalls = f.state.calls.filter((u) => /\/v1\/files\/FILEKEY1234\?depth=1/.test(u)).length;
  assert.equal(versionCalls, 2, "one cheap call per file per poll");
  f.set(12, false, "101");                               // new version but this frame is the same
  assert.deepEqual(await watchVersions(entries, f.deps), []);
  f.set(16, true, "102");
  const ev = await watchVersions(entries, f.deps);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "design_changed");
  assert.equal(ev[0].itemId, "task_1");
  assert.equal(ev[0].oldVersion, "101");
  assert.equal(ev[0].newVersion, "102");
  assert.ok(ev[0].compared);
  assert.equal(designChangedMessage(ev[0]).startsWith("Design of 'Chat / Reply chips' changed: padding 12 -> 16"), true);
  assert.deepEqual(await watchVersions(entries, f.deps), [], "same version again -> quiet");
});

// ------------------------------------------------------------------ Batch tests

function fakeClient() {
  const st = { batches: new Map<string, { status: string; requests: any[] }>(), direct: 0, created: 0, failIds: new Set<string>() };
  const client: BatchClient = {
    messages: {
      create: async (p: any) => { st.direct++; return { model: p.model, content: [{ type: "text", text: `direct:${p.messages[0].content}` }], usage: { input_tokens: 10, output_tokens: 5 } }; },
      batches: {
        create: async ({ requests }) => {
          for (const r of requests) assert.match(r.custom_id, /^[a-zA-Z0-9_-]{1,64}$/);
          const id = `msgbatch_${++st.created}`;
          st.batches.set(id, { status: "in_progress", requests });
          return { id, processing_status: "in_progress" };
        },
        retrieve: async (id) => ({ id, processing_status: st.batches.get(id)!.status }),
        results: async (id) => (async function* () {
          for (const r of st.batches.get(id)!.requests) {
            if (st.failIds.has(r.custom_id)) yield { custom_id: r.custom_id, result: { type: "errored", error: { type: "error" } } };
            else yield { custom_id: r.custom_id, result: { type: "succeeded", message: { model: r.params.model, content: [{ type: "text", text: `batch:${r.params.messages[0].content}` }], usage: { input_tokens: 10, output_tokens: 5 } } } };
          }
        })(),
      },
    },
  };
  return { st, client };
}

test("batch: queue, send, poll, results stored by key", async () => {
  const { st, client } = fakeClient();
  let t = Date.parse("2026-11-17T00:00:00Z");
  const d = { client, now: () => t, file: path.join(testHome, "batch-a.json") };
  assert.equal(queueBatchCall({ key: "handbook:p1", model: "claude-haiku-5-5", system: "Summarise.", prompt: "one", maxTokens: 500 }, d), true);
  assert.equal(queueBatchCall({ key: "handbook:p1", model: "claude-haiku-5-5", prompt: "dup", maxTokens: 500 }, d), false, "same key is queued once");
  queueBatchCall({ key: "digest:2026-11-17 / team", model: "claude-haiku-5-5", prompt: "two", maxTokens: 500 }, d);
  const ids = await flushBatch(d);
  assert.equal(ids.length, 1);
  assert.equal(st.batches.get(ids[0])!.requests.length, 2);
  assert.equal(st.batches.get(ids[0])!.requests[0].params.system, "Summarise.");
  assert.deepEqual(await flushBatch(d), [], "nothing is sent twice");
  assert.equal(await pollBatches(d), 0, "still running");
  assert.equal(getResult("handbook:p1", d), undefined);
  st.batches.get(ids[0])!.status = "ended";
  assert.equal(await pollBatches(d), 2);
  assert.equal(getResult("handbook:p1", d)!.text, "batch:one");
  assert.equal(getResult("handbook:p1", d)!.via, "batch");
  assert.deepEqual(getResult("digest:2026-11-17 / team", d)!.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(st.direct, 0);
  assert.equal(batchQueue(d).openBatches, 0);
  assert.equal(takeResult("handbook:p1", d)!.text, "batch:one");
  assert.equal(getResult("handbook:p1", d), undefined);
  assert.notEqual(customIdFor("a/b"), customIdFor("a_b"));
});

test("batch: a call past its deadline runs normally; a late batch answer is ignored; failed items rerun", async () => {
  const { st, client } = fakeClient();
  let t = Date.parse("2026-11-17T00:00:00Z");
  const d = { client, now: () => t, file: path.join(testHome, "batch-b.json") };
  queueBatchCall({ key: "late", model: "m", prompt: "late", maxTokens: 100, waitMs: 60_000 }, d);
  queueBatchCall({ key: "fails", model: "m", prompt: "fails", maxTokens: 100 }, d);
  const [id] = await flushBatch(d);
  assert.equal(await runOverdue(d), 0, "nothing is due yet");
  t += 61_000;
  assert.equal(await runOverdue(d), 1);
  assert.equal(getResult("late", d)!.text, "direct:late");
  assert.equal(getResult("late", d)!.via, "direct");
  st.failIds.add(customIdFor("fails"));
  st.batches.get(id)!.status = "ended";
  assert.equal(await pollBatches(d), 0, "the late answer is ignored and the failed one is not stored");
  assert.equal(getResult("late", d)!.via, "direct");
  const tick = await tickBatches(d);
  assert.equal(tick.ranDirect, 1);
  assert.equal(getResult("fails", d)!.text, "direct:fails");
  assert.deepEqual(batchQueue(d), { waiting: [], sent: [], results: 2, openBatches: 0 });
});

test("batch: an injected direct runner is used for the fallback; repeated failures end with an error result", async () => {
  const { client } = fakeClient();
  let t = 0;
  let calls = 0;
  const d = { client, now: () => t, file: path.join(testHome, "batch-c.json"), direct: async () => { calls++; throw new Error("down"); } };
  queueBatchCall({ key: "k", model: "m", prompt: "p", maxTokens: 10, waitMs: 1 }, d);
  t = 10;
  for (let i = 0; i < 3; i++) await runOverdue(d);
  assert.equal(calls, 3);
  assert.match(getResult("k", d)!.error!, /down/);
});
