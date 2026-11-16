import "../../tests/fixtures/tool-display/pi-tui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const { Editor, KeybindingsManager, TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");
import { panel } from "./panel.ts";

const theme = { fg: (_role, text) => text, bg: (_role, text) => text, bold: (text) => text };
const questions = [{ question: "Which?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }];

test("injected interrupt binding leaves Escape to the modal text editor", () => {
  const made = [];
  class ModalEditor extends Editor {
    mode = "insert";
    constructor(...args) { super(...args); made.push(this); }
    getMode() { return this.mode; }
    handleInput(data) {
      if (data === "\x1b") this.mode = "normal";
      else super.handleInput(data);
    }
  }
  const main = { getMode: () => "insert", constructor: ModalEditor, getText() {}, handleInput() {}, onSubmit() {} };
  const tui = { children: [{ children: [main] }], requestRender() {}, terminal: { rows: 24 } };
  const outcomes = [];
  const kb = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } }, { "app.interrupt": ["alt+c"] });
  const component = panel(tui, questions, theme, () => {}, (outcome) => outcomes.push(outcome), kb);
  assert.equal(made.length, 2, "answer and note use the main editor class");
  component.handleInput("\x1b[A");
  assert.ok(component.render(100).some((line) => line.includes("INSERT")));
  component.handleInput("\x1b");
  assert.deepEqual(outcomes, []);
  assert.ok(component.render(100).some((line) => line.includes("NORMAL") && line.includes("Alt+C cancel")));
  component.handleInput("\x1bc");
  assert.deepEqual(outcomes, [{ cancelled: true }]);
});
