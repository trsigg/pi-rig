import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractQuotes, formatStatus, matchQuote, normalize, replay, Tracker, visibleText } from "../extensions/catchup/core.ts";
import catchup from "../extensions/catchup/index.ts";
import { emit, fakeUI, registrations, sandbox } from "./portable-harness.mjs";

const params = { gap_threshold_min: 20, caught_up_tolerance_chars: 10, net_rate_chars_per_min: { median: 100, p10: 50, p90: 200 }, online: { tau_min: 2, clip: [0.5, 2] }, breaks: { threshold_excess_min: 5, typical_read_min: 1 } };
const entry = (role, text, seconds) => ({ type: "message", timestamp: new Date(seconds * 1000).toISOString(), message: { role, content: [{ type: "text", text }] } });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// Explicit synthetic stream positions and arithmetic expectations, independent of a local session file.
const conversation = [entry("assistant", "Opening marker. " + "x".repeat(1000), 0), entry("user", "> Opening marker.", 60), entry("assistant", "next section " + "y".repeat(200), 150), entry("user", "> next section", 180)];
const checks = [
  { count: 2, now: 60, position: 15, unread: 1001, eta: 10.01, low: 5.005, high: 20.02 },
  { count: 2, now: 120, position: 15, unread: 901, eta: 9.01, low: 4.505, high: 18.02 },
  { count: 3, now: 180, position: 15, unread: 1015, eta: 10.15, low: 5.075, high: 20.3 },
  { count: 4, now: 180, position: 1029, unread: 201, eta: 1.34, low: 0.67, high: 2.68 },
];

test("synthetic replay matches explicit positions, elapsed reading, growth, and clipped online rates", () => {
  for (const c of checks) {
    const tracker = replay(conversation.slice(0, c.count), c.now, params);
    const estimate = tracker.estimate(c.now);
    assert.equal(tracker.episode.P, c.position);
    assert.equal(estimate.unread, c.unread);
    close(estimate.eta, c.eta);
    close(estimate.etaLow, c.low);
    close(estimate.etaHigh, c.high);
    assert.equal(estimate.onBreak, false);
  }
});

test("normalization, repeated/fuzzy quotes, visible questions, and status format", () => {
  assert.equal(normalize("## Hi — [link](https://example.com) “q” `code` **b**\n> - item 🎉"), 'hi - link "q" code b item \uFFFD');
  assert.deepEqual(extractQuotes("> a\n>b\nask?\n  > c"), [" a b", " c"]);
  const stream = normalize("one two three four five six seven eight nine ten eleven twelve");
  assert.deepEqual(matchQuote(stream, "four five", undefined), [14, 23]);
  assert.deepEqual(matchQuote(stream, "one two three four five six seven xx nine ten eleven twelve", undefined), [0, 27]);
  assert.equal(matchQuote(stream, "abc", undefined), undefined);
  const repeated = "hello " + "x".repeat(3000) + " hello";
  assert.deepEqual(matchQuote(repeated, "hello", undefined), [3007, 3012]);
  assert.deepEqual(matchQuote(repeated, "hello", 0), [0, 5]);
  assert.equal(visibleText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "ask_user", arguments: { message: "Pick one", questions: [{ question: "Which?" }] } }, { type: "text", text: "shown" }] }), "Pick one\nWhich?\nshown");
  assert.equal(formatStatus({ unread: 9100, eta: 19.6, etaLow: 8.2, etaHigh: 45.4, onBreak: true }), "⏸ ⏱ ~20m (8–45) · 9k unread");
});

test("breaks, caught-up expiry, stale replay, and markup expansions", () => {
  const t = replay(conversation.slice(0, 2), 60, params);
  assert.equal(t.estimate(481).onBreak, true);
  t.add("user", "<skill>not a human prompt</skill>", 482);
  assert.equal(t.lastUserTs, 60);
  t.expire(660);
  assert.equal(t.estimate(660), undefined);
  assert.equal(replay(conversation, 180 + 1201, params).episode, undefined);
  const fitted = JSON.parse(readFileSync(new URL("../extensions/catchup/model.json", import.meta.url)));
  const synthetic = new Tracker(fitted);
  synthetic.add("assistant", "Start. " + "z".repeat(12000), 0);
  synthetic.add("user", "> Start.", 60);
  close(synthetic.estimate(60).eta, 12001 / 472.5596705735091);
});

test("opt-in footer updates on messages and releases the sole periodic timer", async (t) => {
  sandbox(t, { catchup: { enabled: true } });
  const oldSet = globalThis.setInterval, oldClear = globalThis.clearInterval;
  const active = new Set();
  globalThis.setInterval = (callback, ms) => { assert.equal(ms, 30000); const token = { callback, unref() {} }; active.add(token); return token; };
  globalThis.clearInterval = (token) => { active.delete(token); };
  t.after(() => { globalThis.setInterval = oldSet; globalThis.clearInterval = oldClear; });
  const ext = registrations(catchup);
  const { ctx, state } = fakeUI();
  await emit(ext, "session_start", {}, ctx);
  assert.equal(active.size, 1);
  await emit(ext, "message_end", { message: { role: "assistant", content: "Start. " + "z".repeat(12000), timestamp: Date.now() } }, ctx);
  await emit(ext, "message_start", { message: { role: "user", content: "> Start.", timestamp: Date.now() } }, ctx);
  assert.match(state.statuses.get("catchup"), /unread/);
  await emit(ext, "session_start", {}, ctx);
  assert.equal(active.size, 1, "restart replaces timer");
  await emit(ext, "session_shutdown", {}, ctx);
  assert.equal(active.size, 0);
  assert.equal(state.statuses.get("catchup"), undefined);
});
