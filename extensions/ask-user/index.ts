// ask_user: questions in a bottom panel with inline free text (spec #34).
import { AssistantMessageComponent, getAgentDir, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, visibleWidth } from "@earendil-works/pi-tui";
import { rigSettings } from "../../shared/settings/index.ts";
import { timers } from "../../shared/process-groups/index.ts";
import { isChild } from "../../shared/subagent/index.ts";
import { resultText, toolRenderers } from "../../shared/tool-display/index.ts";
import { oneLine } from "../../shared/text/index.ts"; // question text is model input
import { answerText, panel, type Outcome, type Question } from "./panel.ts";

const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });

const PARAMETERS = {
  type: "object",
  required: ["message", "questions"],
  properties: {
    message: str("Your reply to the user, shown verbatim (markdown) above the questions: what you found or did, and the context they need to answer. Write it here, not in thinking."),
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description: "Asked together, one tab each",
      items: {
        type: "object",
        required: ["question", "header"],
        additionalProperties: false,
        properties: {
          question: str("The full question with its context"),
          header: { ...str("Tab label"), maxLength: 12 },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description: "Omit for a free-text question",
            items: {
              type: "object",
              required: ["label"],
              additionalProperties: false,
              properties: { label: str("Short choice"), description: str("One line") },
            },
          },
          multiSelect: { type: "boolean", description: "Allow several choices" },
        },
      },
    },
  },
};

const DESCRIPTION =
  "Ask the user 1-4 questions in a panel. Use it instead of listing choices in chat whenever you need a decision, preference or confirmation. " +
  "Put your reply and the context the user needs in `message`: it is shown to them verbatim. The user never sees your thinking. " +
  "Every question also takes a typed answer or a skip. Put a recommended option first and end its label with (Recommended). " +
  'Returns a line per question: `header: labels`, `header: "typed"` or `header: skipped`, then `note: ...` if given; `cancelled` if declined, or `timed out` if unanswered for the configured time (then decide whether to stop or continue on an assumption).';

const clean = (q: Question): Question => ({
  ...q,
  question: oneLine(q.question),
  header: oneLine(q.header),
  options: q.options?.map((o) => ({ label: oneLine(o.label), ...(o.description ? { description: oneLine(o.description) } : {}) })),
});

/** One compact line per question, then the note; `cancelled` alone when declined. */
export function format(questions: Question[], o: Outcome): string {
  if (o.cancelled && o.timedOut)
    return `timed out: no answer after ${o.timedOut} min. The user may be away. If you can't go on safely without the answer, stop and say what you need; otherwise continue on a stated assumption.`;
  if (o.cancelled) return "cancelled";
  const lines = questions.map((q, i) => `${q.header}: ${answerText(o.answers[i])}`);
  if (o.note) lines.push(`note: ${o.note}`);
  return lines.join("\n");
}

// The narration renderer marks its active prototype wrapper with this shared state.
const NARRATION_PATCH = Symbol.for("pi-rig.narration");
const narrationShown = () => (AssistantMessageComponent.prototype as any)[NARRATION_PATCH]?.active === true;
export function isNarration(p: any): boolean {
  const sig = p?.type === "thinking" ? p.thinkingSignature : undefined;
  return typeof sig === "string" && /^[A-Za-z0-9+/=_-]+$/.test(sig) && Buffer.from(sig, "base64").includes("narration");
}

/** Explain the visible-text failure without exposing the thinking contents. */
export const noText = (thinkingBlocks: number, thinkingChars: number) =>
  `ask_user refused: this message has 0 characters of visible text` +
  (thinkingBlocks ? ` (only ${thinkingBlocks} thinking block${thinkingBlocks > 1 ? "s" : ""}, ${thinkingChars} characters, which the user never sees)` : "") +
  ". Text written while thinking is not a reply, even when it is addressed to the user. " +
  "End your thinking, write the explanation as a normal text reply, then call ask_user in that same message. " +
  "Retrying the same way will be refused again.";

const base = toolRenderers({
  title: "Ask User",
  arg: (p: any) => (p?.questions ?? []).map((q: any) => oneLine(q?.header ?? "")).filter(Boolean).join(", "),
  // No summary: the question splits the run, and the answers stay visible.
  result: (r: any, _a, _e, theme) => {
    const [first = "", ...rest] = resultText(r).split("\n");
    return { summary: first || "Answered", body: rest.map((l) => theme.fg("toolOutput", l)) };
  },
});

const renderers = {
  ...base,
  renderCall(args: any, theme: any, context: any) {
    const call = base.renderCall(args, theme, context);
    const message = typeof args?.message === "string" ? args.message.trim() : "";
    if (!message) return call;
    const box = new Container();
    box.addChild(new Markdown(message, 1, 0, getMarkdownTheme()));
    box.addChild(new Spacer(1));
    box.addChild(call);
    return box;
  },
};

export default function (pi: ExtensionAPI) {
  let hasText = false;
  let thinking = { blocks: 0, chars: 0 };
  pi.on("message_end", (event) => {
    const m = event.message as any;
    if (m?.role !== "assistant") return;
    const parts: any[] = Array.isArray(m.content) ? m.content : [];
    const shown = narrationShown();
    hasText = parts.some((p) => (p.type === "text" && p.text?.trim()) || (shown && p.thinking?.trim() && isNarration(p)));
    const t = parts.filter((p) => p.type === "thinking");
    thinking = { blocks: t.length, chars: t.reduce((n, p) => n + (p.thinking?.length ?? 0), 0) };
  });
  const section = rigSettings(getAgentDir()).declare("askUser", [
    { key: "timeoutMinutes", type: "integer", min: 0, max: 1440, default: 20, description: "Minutes an unanswered ask_user panel stays open before the agent is told it timed out (0 = never)" },
  ]);
  // Subagents never open a panel: #26 writes `rig.subagent` as a child session's first entry.
  pi.on("session_start", (_event, ctx) => {
    if (isChild(ctx)) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user"));
    }
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: DESCRIPTION,
    parameters: PARAMETERS as never,
    executionMode: "sequential",
    ...renderers,
    async execute(_id, params: { message?: string; questions: Question[] }, signal, _onUpdate, ctx) {
      const questions = params.questions.map(clean);
      const message = (params.message ?? "").trim();
      for (const q of questions) {
        if (visibleWidth(q.header) > 12) throw new Error(`header "${q.header}" is wider than 12 columns`);
      }
      if (ctx.mode !== "tui") throw new Error("No interactive user here. State your assumption and continue.");
      if (!hasText && !message) throw new Error(noText(thinking.blocks, thinking.chars));
      const outcome: Outcome = signal?.aborted
        ? { cancelled: true }
        : await ctx.ui.custom<Outcome>((tui, theme, kb, close) => {
            let timer: unknown;
            let closed = false;
            const cancel = () => done({ cancelled: true });
            const done = (o: Outcome) => {
              if (closed) return;
              closed = true;
              if (timer !== undefined) timers().clearTimeout(timer as any);
              timer = undefined;
              signal?.removeEventListener("abort", cancel);
              close(o);
            };
            signal?.addEventListener("abort", cancel, { once: true });
            const minutes = section.get("timeoutMinutes") as number;
            if (minutes > 0) timer = timers().setTimeout(() => done({ cancelled: true, timedOut: minutes }), minutes * 60_000);
            return panel(tui, questions, theme, () => tui.requestRender(), done, kb);
          });
      return { content: [{ type: "text", text: format(questions, outcome) }], details: { message, questions, ...outcome } };
    },
  });
}
