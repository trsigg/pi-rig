// Some providers tag pre-tool narration as thinking, with a base64 signature containing a narration marker.
const NARRATION = Buffer.from("narration");

/** True only for a thinking block whose base64 signature decodes to bytes containing "narration". */
export function isNarration(block: unknown): boolean {
	const b = block as { type?: unknown; thinkingSignature?: unknown } | null;
	if (b?.type !== "thinking" || typeof b.thinkingSignature !== "string" || !b.thinkingSignature) return false;
	if (!/^[A-Za-z0-9+/=_-]+$/.test(b.thinkingSignature)) return false;
	try {
		return Buffer.from(b.thinkingSignature, "base64").includes(NARRATION);
	} catch {
		return false;
	}
}
