// The monitor tool (spec #30, ticket #50), with Claude Code's rules: each batch of
// lines a watch command prints on stdout becomes one notice to the agent, cut and
// rate-limited; a flood or 5 GB of output stops it as failed. Deadlines end quietly. Stdout goes to a log the
// FleetView row shows, stderr to a separate log. Every timer runs on process-groups' seam.
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, writeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { duration, fleet } from "../../shared/fleet/index.ts";
import { logDir, MAX_OUTPUT, MAX_OUTPUT_BYTES, spawnGroup, timers, tooManyJobs } from "../../shared/process-groups/index.ts";
import { oneLine, unfinished } from "../../shared/text/index.ts";
import { resultText, toolRenderers } from "../../shared/tool-display/index.ts";

const LINE_CHARS = 500;
const NOTICE_CHARS = 3000;
/** A notice shows at most this much of the description, so the drop count and the lines survive the notice cut. */
const NAME_CHARS = 100;
/** An unended line longer than this is sanitised and cut early, so it cannot grow without bound. */
const PARTIAL_MAX = 4 * LINE_CHARS;
/** Notices a monitor may send at once; one comes back every REFILL_MS. */
const BUDGET = 10;
const REFILL_MS = 2000;
/**
 * A flood window opens at a drop and stays open while drops keep coming, each within
 * REFILL_MS of the last; one open this long stops the monitor as `flooded`.
 */
const FLOOD_MS = 30_000;
const DEFAULT_S = 300;

/** The first `n` code points of `s`. */
const cut = (s: string, n: number) => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));

type Reason = "flooded" | "timeout" | "output" | "stopped" | "shutdown";
type Monitor = {
  id: string;
  g: ReturnType<typeof spawnGroup>;
  owner: string;
  description: string;
  log: string;
  errors: string;
  seconds: number;
  interval: number;
  held: string[];
  flush?: unknown;
  sentAt?: number;
  out: number;
  code?: number;
  reason?: Reason;
  /** Set once the group is being ended; resolves when it is empty and the monitor has settled. */
  killed?: Promise<void>;
  tokens: number;
  dropped: number;
  partial: string;
  /** The last non-blank stdout line, for the FleetView row. */
  last: string;
  refill?: unknown;
  flood?: unknown;
  /** Closes the flood window when REFILL_MS pass without a drop. */
  gap?: unknown;
  deadline?: unknown;
  /** Resolves once stdout has closed and the end notice is sent. */
  done: Promise<void>;
};

// Runtime-only deadline and notice metadata for jobs list.
const info: Map<string, () => string[]> = ((globalThis as any)[Symbol.for("pi-rig.monitor-info")] ??= new Map());

export default function (pi: ExtensionAPI) {
  const monitors = new Map<string, Monitor>();
  const dir = logDir("monitor");

  const name = (m: Monitor) => `Monitor ${m.id} (${cut(oneLine(m.description), NAME_CHARS)})`;

  function batch(m: Monitor, lines: string[]) {
    if (!m.interval) return deliver(m, lines);
    m.held.push(...lines);
    if (m.flush !== undefined) return;
    const wait = m.sentAt === undefined ? 0 : Math.max(0, m.sentAt + m.interval - Date.now());
    m.flush = timers().setTimeout(() => {
      m.flush = undefined;
      const held = m.held.splice(0);
      if (held.length && !m.reason) deliver(m, held);
    }, wait);
  }

  /** One notice for lines that arrived together, if the budget has one. */
  function deliver(m: Monitor, lines: string[]) {
    const t = timers();
    if (m.tokens === 0) {
      m.dropped++;
      m.flood ??= t.setTimeout(() => void stop(m, "flooded"), FLOOD_MS);
      if (m.gap !== undefined) t.clearTimeout(m.gap as any);
      m.gap = t.setTimeout(() => {
        t.clearTimeout(m.flood as any);
        m.flood = m.gap = undefined;
      }, REFILL_MS);
      return;
    }
    m.tokens--;
    m.refill ??= t.setTimeout(function refill() {
      m.tokens++;
      m.refill = m.tokens < BUDGET ? t.setTimeout(refill, REFILL_MS) : undefined;
    }, REFILL_MS);
    const dropped = m.dropped;
    m.dropped = 0;
    const head = `${name(m)}:${dropped ? ` (${dropped} earlier notices suppressed by the rate limit)` : ""}`;
    const text = [head, ...lines.map((l) => cut(oneLine(l), LINE_CHARS))].join("\n");
    m.sentAt = Date.now();
    fleet().notify(m.id, cut(text, NOTICE_CHARS));
  }

  function start(p: { command: string; description: string }, seconds: number, interval: number, c: ExtensionContext): Monitor {
    const full = tooManyJobs();
    if (full) throw new Error(full);
    const id = randomUUID().slice(0, 8);
    const log = dir.path(`${id}.log`);
    const errors = dir.path(`${id}.err.log`);
    const g = spawnGroup({ command: p.command, cwd: c.cwd, dir, id, stderr: errors, counted: true });
    const out = openSync(log, "a", 0o600);
    const m: Monitor = { id, g, owner: c.sessionManager.getSessionId(), description: p.description, log, errors, seconds, interval, held: [], out, tokens: BUDGET, dropped: 0, partial: "", last: "", done: g.closed.then(() => settle(m)) };
    g.child.stdout?.setEncoding("utf8"); // whole code points, even across chunks
    g.child.stdout?.on("data", (chunk: string) => {
      writeSync(m.out, chunk);
      if (!m.reason && fstatSync(m.out).size > MAX_OUTPUT_BYTES) void stop(m, "output");
      const lines = (m.partial + chunk).split("\n");
      m.partial = lines.pop()!;
      if (m.partial.length > PARTIAL_MAX) {
        // Keep the line's start, clean and cut, and hold back a sequence the chunk cut off.
        const i = unfinished(m.partial);
        m.partial = cut(oneLine(m.partial.slice(0, i)), LINE_CHARS) + m.partial.slice(i, i + PARTIAL_MAX);
      }
      const tail = m.partial.trim() ? m.partial : lines.findLast((l) => l.trim());
      if (tail) m.last = cut(oneLine(tail), LINE_CHARS);
      if (lines.length && !m.reason) batch(m, lines);
    });
    void g.exited.then((code) => {
      m.code = code;
      void kill(m); // ends what the shell left in its group, and a pipe held open past it
    });
    const startedAt = Date.now();
    if (seconds) m.deadline = timers().setTimeout(() => void stop(m, "timeout"), seconds * 1000);
    monitors.set(id, m);
    info.set(id, () => [
      seconds ? `deadline in ${duration(Math.max(0, startedAt + seconds * 1000 - Date.now()))}` : "no deadline",
      m.sentAt === undefined ? "no notices yet" : `last notice ${duration(Date.now() - m.sentAt)} ago`,
    ]);
    fleet().register({ id, owner: m.owner, kind: "monitor", label: oneLine(p.description), activity: () => m.last, view: { log }, stop: () => stop(m, "stopped") });
    return m;
  }

  /** Ends the group, then closes the pipe. */
  function kill(m: Monitor) {
    return (m.killed ??= (async () => {
      await m.g.kill();
      m.g.child.stdout?.destroy(); // a process outside the group may still hold it
      await m.done;
      monitors.delete(m.id);
      info.delete(m.id);
    })());
  }

  /** Clears the monitor's timers: nothing may fire once it is ending. */
  function clear(m: Monitor) {
    const t = timers();
    for (const h of [m.refill, m.flood, m.gap, m.deadline, m.flush]) if (h !== undefined) t.clearTimeout(h as any);
    m.refill = m.flood = m.gap = m.deadline = m.flush = undefined;
  }

  function stop(m: Monitor, reason: Reason) {
    m.reason ??= reason;
    clear(m);
    return kill(m);
  }

  function settle(m: Monitor) {
    const rest = [...m.held.splice(0), ...(m.partial ? [m.partial] : [])];
    if (rest.length && (!m.reason || m.reason === "timeout")) deliver(m, rest);
    clear(m);
    closeSync(m.out);
    const logs = `Log: ${m.log}. Errors: ${m.errors}`;
    const end = {
      flooded: ["failed", "flooded", `${name(m)} failed [flooded]: it printed faster than the rate limit for ${FLOOD_MS / 1000}s. Tighten the command's filter so it prints fewer lines. ${logs}`],
      timeout: ["completed", "deadline", null],
      output: ["failed", "output", `${name(m)} failed [output]: its output passed ${MAX_OUTPUT}. Tighten the command's filter. ${logs}`],
      stopped: ["stopped", "stopped", `${name(m)} stopped. ${logs}`],
      shutdown: ["stopped", "stopped", null],
    } as const;
    const [status, result, notice] = m.reason
      ? end[m.reason]
      : ([m.code === 0 ? "completed" : "failed", `exit ${m.code}`, `${name(m)} ended: its command exited with code ${m.code}. ${logs}`] as const);
    fleet().finish(m.id, status, result, notice);
  }

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Run a watch command in the background. Each batch of stdout lines it prints reaches you as a notice while you work, so filter it to the events you need " +
      "(e.g. `tail -f app.log | grep --line-buffered ERROR`). Lines are cut at 500 characters. A monitor that prints too often is rate-limited, then stopped. " +
      "It ends when the command exits, at its deadline (quietly, no notice), or on jobs stop. timeout 0 = no deadline: use it for long watches instead of re-arming. " +
      "min_interval batches lines into at most one notice per that many seconds. jobs list shows running monitors. Stderr goes to a separate log.",
    parameters: {
      type: "object",
      required: ["command", "description"],
      additionalProperties: false,
      properties: {
        command: { type: "string", description: "Watch command; each stdout line is an event" },
        description: { type: "string", description: "Short name shown on its notices" },
        timeout: { type: "number", description: `Seconds until it ends quietly; default ${DEFAULT_S}; 0 = no deadline (until the command exits or jobs stop)` },
        min_interval: { type: "number", description: "Seconds; batch lines into at most one notice per interval (default 0 = as they arrive)" },
      },
    },
    async execute(_id: string, p: { command: string; description: string; timeout?: number; min_interval?: number }, _s: unknown, _u: unknown, c: ExtensionContext) {
      if (p.timeout !== undefined && (!Number.isFinite(p.timeout) || p.timeout < 0)) throw new Error("timeout must be 0 (no deadline) or a positive number of seconds");
      if (p.min_interval !== undefined && (!Number.isFinite(p.min_interval) || p.min_interval < 0)) throw new Error("min_interval must be 0 or a positive number of seconds");
      const seconds = p.timeout ?? DEFAULT_S;
      const m = start(p, seconds, (p.min_interval ?? 0) * 1000, c);
      const until = seconds ? `until it ends or after ${seconds}s (quietly)` : "until its command exits or jobs stop";
      const text = `Started monitor ${m.id}; its output lines arrive as notices ${until}. Log: ${m.log}. Errors: ${m.errors}`;
      return { content: [{ type: "text" as const, text }], details: { id: m.id, log: m.log, errors: m.errors } };
    },
    ...toolRenderers({
      title: "Monitor",
      arg: (a: any) => oneLine(a?.description ?? ""),
      summary: { verb: "started", one: "monitor" },
      result: (r: any) => ({ summary: oneLine(resultText(r)), body: [] }),
    }),
  } as any);

  // Monitors belong to this session: shutdown, reload and session switch stop every one, without a notice.
  pi.on("session_shutdown", async () => {
    await Promise.all([...monitors.values()].map((m) => stop(m, "shutdown")));
    dir.remove();
  });
}
