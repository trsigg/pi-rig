import { test } from "node:test";
import assert from "node:assert/strict";
import { TreeSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { installTree, releaseTree } from "../extensions/tree-compact/index.ts";
import { installTiming, releaseTiming } from "../extensions/prompt-timing/index.ts";

const strip = (s) => s.replace(/\x1b\[[0-9;:]*m/g, "");

test("real tree rows receive timestamps and model/custom labels; shutdown restores both prototypes", () => {
  initTheme("dark");
  const node = (id, type, more) => ({ entry: { id, parentId: null, timestamp: "2024-01-02T03:04:00Z", type, ...more }, children: [] });
  const model = node("model-example", "message", { message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
  const custom = node("notice-example", "custom_message", { customType: "example.notice", content: "Notice", display: true });
  const tree = new TreeSelectorComponent([model, custom], "model-example", 24, () => {}, () => {}, undefined, undefined, "all");
  const selector = TreeSelectorComponent.prototype, row = Object.getPrototypeOf(tree.getTreeList());
  const originalRender = selector.render, originalRow = row.getEntryDisplayText;
  const a = {}, b = {};
  try {
    installTree(selector, a); installTree(selector, b);
    assert.equal(row.getEntryDisplayText, originalRow, "row patch is lazy");
    const rendered = tree.render(80);
    assert.ok(rendered.length);
    const d = new Date(model.entry.timestamp);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    assert.equal(strip(row.getEntryDisplayText.call(tree.getTreeList(), model, false)), `${hhmm} model: Hello`);
    assert.match(row.getEntryDisplayText.call(tree.getTreeList(), custom, false), /\x1b\[34m\[example\.notice\]: /);
    assert.equal(strip(row.getEntryDisplayText.call(tree.getTreeList(), { ...model, entry: { ...model.entry, timestamp: "invalid" } }, false)), "model: Hello");
    releaseTree(selector, a);
    assert.notEqual(selector.render, originalRender);
  } finally { releaseTree(selector, a); releaseTree(selector, b); }
  assert.equal(selector.render, originalRender);
  assert.equal(row.getEntryDisplayText, originalRow);
});

test("tree patch releases safely underneath a later wrapper", () => {
  const selector = { render() { return ["plain"]; } }, owner = {};
  installTree(selector, owner);
  const timing = selector.render;
  const later = function () { return timing.call(this); };
  selector.render = later;
  releaseTree(selector, owner);
  assert.equal(selector.render, later);
  assert.deepEqual(selector.render(), ["plain"]);
});

test("prompt timing records interactive latency and slow handlers, isolates runners, and restores every wrapper", async () => {
  let time = 0;
  const logs = [];
  const h = async () => { time += 25; };
  const fast = async () => { time += 5; };
  class Runner {
    extensions = [{ path: "extensions/example/index.ts", handlers: new Map([["input", [h, fast]], ["context", [fast]]]) }];
    async emitInput(_text, _images, _source) { for (const fn of this.extensions[0].handlers.get("input")) await fn(); return "kept return"; }
    emitBeforeAgentStart() {}
    emit() {}
    async emitContext() { for (const fn of this.extensions[0].handlers.get("context")) await fn(); }
  }
  const originals = Object.fromEntries(["emit", "emitInput", "emitContext", "emitBeforeAgentStart"].map((k) => [k, Runner.prototype[k]]));
  const a = {}, b = {}, one = new Runner(), two = new Runner();
  try {
    installTiming(Runner.prototype, a, { now: () => time, log: (line) => logs.push(line) });
    installTiming(Runner.prototype, b);
    assert.equal(await one.emitInput("not logged", [], "rpc"), "kept return");
    one.emit({ type: "message_start", message: { role: "user" } });
    assert.equal(logs.length, 0);
    time = 100;
    await one.emitInput("private input is not logged", [], "interactive");
    await one.emitContext();
    time += 10;
    await two.emitInput("other runner", [], "interactive");
    time += 5;
    one.emit({ type: "message_start", message: { role: "assistant" } });
    assert.equal(logs.length, 0);
    one.emit({ type: "message_start", message: { role: "user" } });
    assert.equal(logs[0], "enter->shown=80ms handlers=35ms example:input=25ms");
    two.emit({ type: "message_start", message: { role: "user" } });
    assert.equal(logs[1], "enter->shown=35ms handlers=30ms example:input=25ms");
    assert.doesNotMatch(logs.join("\n"), /private input|extensions\//);
    releaseTiming(Runner.prototype, a);
    assert.notEqual(Runner.prototype.emitInput, originals.emitInput);
  } finally { releaseTiming(Runner.prototype, a); releaseTiming(Runner.prototype, b); }
  for (const [key, original] of Object.entries(originals)) assert.equal(Runner.prototype[key], original);
  for (const runner of [one, two]) assert.deepEqual(runner.extensions[0].handlers.get("input"), [h, fast]);
});

test("timing wrappers measure thrown handlers and become inert under later wrappers", async () => {
  let time = 1;
  const lines = [];
  const error = new Error("expected synthetic failure");
  const handler = async () => { time += 30; throw error; };
  const list = [handler];
  class Runner {
    extensions = [{ path: "example.ts", handlers: new Map([["input", list]]) }];
    async emitInput() { return list[0](); }
    emit() {}
  }
  const owner = {}, runner = new Runner();
  installTiming(Runner.prototype, owner, { now: () => time, log: (line) => lines.push(line) });
  try {
    await assert.rejects(runner.emitInput("", [], "interactive"), (e) => e === error);
    runner.emit({ type: "message_start", message: { role: "user" } });
    assert.match(lines[0], /example\.ts:input=30ms/);
    const below = Runner.prototype.emitInput;
    const later = function (...args) { return below.apply(this, args); };
    Runner.prototype.emitInput = later;
    releaseTiming(Runner.prototype, owner);
    assert.equal(Runner.prototype.emitInput, later);
    assert.equal(list[0], handler);
    await assert.rejects(runner.emitInput("", [], "interactive"), (e) => e === error);
    assert.equal(lines.length, 1);
  } finally { releaseTiming(Runner.prototype, owner); }
});
