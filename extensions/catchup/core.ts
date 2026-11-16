// Pure catch-up estimator. Offsets count normalized visible characters; astral characters count as one.

export interface Params {
	gap_threshold_min: number;
	caught_up_tolerance_chars: number;
	net_rate_chars_per_min: { median: number; p10: number; p90: number };
	online: { tau_min: number; clip: [number, number] };
	breaks: { threshold_excess_min: number; typical_read_min: number };
}

// ------------------------------------------------------------ normalization

const TR: Record<string, string> = {
	"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
	"\u2013": "-", "\u2014": "-", "\u00a0": " ", "\u2026": "...",
};
const TR_RE = /[\u2018\u2019\u201c\u201d\u2013\u2014\u00a0\u2026]/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const LINEPFX = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/gm;
const DROP = /[*`|~]/g;
const WS = /\s+/g;
const ASTRAL = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/** Drop markdown, unify quotes, collapse whitespace, and lowercase. */
export function normalize(s: string): string {
	s = s.replace(TR_RE, (c) => TR[c]).replace(LINK, "$1").replace(LINEPFX, "").replace(DROP, "");
	return s.replace(WS, " ").trim().toLowerCase().replace(ASTRAL, "\uFFFD");
}

/** Blocks of consecutive lines starting with ">", each joined by spaces. */
export function extractQuotes(text: string): string[] {
	const quotes: string[] = [];
	let cur: string[] = [];
	for (const line of text.split("\n")) {
		const l = line.trimStart();
		if (l.startsWith(">")) cur.push(l.slice(1));
		else if (cur.length) quotes.push(cur.join(" ")), (cur = []);
	}
	if (cur.length) quotes.push(cur.join(" "));
	return quotes;
}

// ----------------------------------------------------------------- matching

const MIN_EXACT = 4, WIN_WORDS = 6, MIN_WIN_CHARS = 20;

function occurrences(stream: string, sub: string, cap: number): number[] {
	const out: number[] = [];
	for (let i = 0; out.length < cap; ) {
		const j = stream.indexOf(sub, i);
		if (j < 0) break;
		out.push(j);
		i = j + 1;
	}
	return out;
}

/** [start, end] of a normalized quote in `stream` (all of it precedes the quoting message), or undefined. */
export function matchQuote(stream: string, q: string, anchor: number | undefined): [number, number] | undefined {
	if (q.length < MIN_EXACT) return undefined;
	let cands: [number, number][] = occurrences(stream, q, 200).map((p) => [p, p + q.length]);
	if (!cands.length) {
		const votes = new Map<number, [number, number, number]>();
		let offs = 0;
		for (const piece of q.split("...").map((x) => x.trim()).filter(Boolean)) {
			const base = q.indexOf(piece, offs);
			offs = base + piece.length;
			const words = piece.split(" ");
			const wins = words.length <= WIN_WORDS ? [piece] : [];
			for (let i = 0; words.length > WIN_WORDS && i < words.length - WIN_WORDS + 1; i += 2) wins.push(words.slice(i, i + WIN_WORDS).join(" "));
			for (const w of wins) {
				if (w.length < MIN_WIN_CHARS) continue;
				const wo = q.indexOf(w, base);
				for (const p of occurrences(stream, w, 20)) {
					const k = Math.floor((p - wo) / 50);
					let v = votes.get(k);
					if (!v) votes.set(k, (v = [0, p - wo, p + w.length]));
					v[0] += w.length;
					v[2] = Math.max(v[2], p + w.length);
				}
			}
		}
		if (!votes.size) return undefined;
		const best = Math.max(...[...votes.values()].map((v) => v[0]));
		if (best < Math.max(MIN_WIN_CHARS, 0.3 * q.length)) return undefined;
		cands = [...votes.values()].filter((v) => v[0] >= 0.6 * best).map((v): [number, number] => [Math.max(0, v[1]), v[2]]);
		cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	}
	if (anchor !== undefined) {
		const after = cands.find((c) => c[0] >= anchor - 2000);
		if (after) return after;
	}
	return cands[cands.length - 1];
}

// ------------------------------------------------------------------ messages

const askText = (a: any): string => {
	const out: string[] = [];
	if (a && typeof a === "object") {
		if (typeof a.message === "string") out.push(a.message);
		for (const q of Array.isArray(a.questions) ? a.questions : []) if (typeof q?.question === "string") out.push(q.question);
	}
	return out.join("\n");
};

/** Visible text of a Pi user/assistant message (text parts + ask_user message/questions), or undefined. */
export function visibleText(m: any): string | undefined {
	const c = m?.content;
	const parts: string[] = [];
	if (typeof c === "string") parts.push(c);
	else if (Array.isArray(c))
		for (const p of c) {
			if (p?.type === "text") parts.push(p.text || "");
			else if (m.role === "assistant" && p?.type === "toolCall" && p.name === "ask_user") parts.push(askText(p.arguments));
		}
	const text = parts.filter(Boolean).join("\n");
	return text.trim() ? text : undefined;
}

// ------------------------------------------------------------------ tracker

interface Episode {
	t0: number; // seconds
	P: number;
	firstPos: number;
	sFirst: number;
	lastMsgTs: number; // last quoting message
}

export interface Estimate {
	unread: number;
	eta: number;
	etaLow: number;
	etaHigh: number;
	onBreak: boolean;
	caughtUp: boolean;
	stale: boolean;
}

/**
 * Incremental session state: the visible stream, the reading position and the current episode.
 * Feed messages in session order with add(); estimate(now) gives the live numbers.
 */
export class Tracker {
	stream = "";
	private ts: number[] = []; // per visible assistant block
	private ends: number[] = [];
	private anchor: number | undefined;
	lastUserTs: number | undefined; // any user message
	episode: Episode | undefined;

	private params: Params;
	constructor(params: Params) {
		this.params = params;
	}

	/** S(t): visible chars produced at or before t. */
	sAt(t: number): number {
		let lo = 0, hi = this.ts.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.ts[mid] <= t) lo = mid + 1;
			else hi = mid;
		}
		return lo ? this.ends[lo - 1] : 0;
	}

	/** Adds a message (ts in seconds). Quotes are matched only when `match` is set (see rebuild in index.ts). */
	add(role: string, text: string | undefined, ts: number, match = true) {
		if (!text) return;
		if (role === "assistant") {
			const t = normalize(text);
			if (!t) return;
			this.stream = this.stream ? `${this.stream} ${t}` : t;
			this.ts.push(ts);
			this.ends.push(this.stream.length);
			return;
		}
		if (role !== "user" || text.trimStart().startsWith("<")) return; // Ignore markup-led expansions.
		this.expire(ts);
		const quotes = match ? extractQuotes(text) : [];
		let P: number | undefined, first: number | undefined;
		for (const q of quotes) {
			const m = matchQuote(this.stream, normalize(q), this.anchor);
			if (!m) continue;
			this.anchor = m[1];
			P = P === undefined ? m[1] : Math.max(P, m[1]);
			first ??= m[1];
		}
		const ep = this.episode;
		if (ep && quotes.length) {
			if (P !== undefined) ep.P = Math.max(ep.P, P);
			ep.lastMsgTs = ts;
		} else if (!ep && P !== undefined) {
			this.episode = { t0: ts, P, firstPos: first!, sFirst: this.sAt(ts), lastMsgTs: ts };
		}
		this.lastUserTs = ts;
		this.expire(ts);
	}

	/** Ends the episode once caught up, or after gap_threshold_min with no user message. */
	expire(now: number) {
		if (!this.episode) return;
		const stale = this.lastUserTs !== undefined && now - this.lastUserTs > this.params.gap_threshold_min * 60;
		if (stale || this.estimate(now)!.caughtUp) this.episode = undefined;
	}

	/** Wall-time estimate, including break detection; undefined outside a quoting episode. */
	estimate(now: number): Estimate | undefined {
		const ep = this.episode;
		if (!ep) return undefined;
		const p = this.params, pv = p.net_rate_chars_per_min, bk = p.breaks;
		let unread = Math.max(0, this.sAt(now) - ep.P);
		let v = pv.median;
		const el = (ep.lastMsgTs - ep.t0) / 60;
		if (el > 0) {
			const w = el / (el + p.online.tau_min);
			const [lo, hi] = p.online.clip;
			const vObs = Math.min(Math.max((ep.sFirst - ep.firstPos - unread) / el, lo * v), hi * v);
			v = (1 - w) * v + w * vObs;
		}
		const since = Math.max(0, (now - ep.lastMsgTs) / 60);
		unread = Math.max(0, unread - v * since);
		const k = v / pv.median;
		return {
			unread,
			eta: unread / v,
			etaLow: unread / (pv.p90 * k),
			etaHigh: unread / (pv.p10 * k),
			onBreak: since > bk.threshold_excess_min + bk.typical_read_min,
			caughtUp: unread <= p.caught_up_tolerance_chars,
			stale: now - ep.lastMsgTs > p.gap_threshold_min * 60,
		};
	}
}

/** Footer text: `⏱ ~20m (8–45) · 9k unread`, `⏸` first while on a break. */
export function formatStatus(e: Estimate): string {
	const m = Math.round;
	return `${e.onBreak ? "⏸ " : ""}⏱ ~${m(e.eta)}m (${m(e.etaLow)}–${m(e.etaHigh)}) · ${m(e.unread / 1000)}k unread`;
}

/**
 * Rebuilds a Tracker from session entries (file order). Quotes are matched only in the trailing run of user
 * messages with gaps of at most gap_threshold_min that is still open at `now`, so a long session isn't re-matched.
 */
export function replay(entries: any[], now: number, params: Params): Tracker {
	const msgs: [string, string | undefined, number][] = [];
	for (const e of entries) {
		const role = e.type === "message" ? e.message?.role : undefined;
		if (role !== "user" && role !== "assistant") continue;
		msgs.push([role, visibleText(e.message), Date.parse(e.timestamp) / 1000]);
	}
	const gap = params.gap_threshold_min * 60;
	let from = Infinity, prev = now;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const [role, text, ts] = msgs[i];
		if (role !== "user" || !text || text.trimStart().startsWith("<")) continue;
		if (prev - ts > gap) break;
		from = prev = ts;
	}
	const t = new Tracker(params);
	for (const [role, text, ts] of msgs) t.add(role, text, ts, ts >= from);
	t.expire(now);
	return t;
}
