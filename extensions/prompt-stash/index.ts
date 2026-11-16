import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rigSettings } from "../../shared/settings/index.ts";
import { matchesKey } from "@earendil-works/pi-tui";

// Ctrl+S with a draft: push it onto the stash
// and clear the editor; the newest draft comes back once the next prompt is
// submitted. Ctrl+S on an empty editor pops it immediately. In-memory stack.
//
// Restore watches Enter rather than the `input` event: pi-rig's queue returns
// "handled" for prompts sent while the agent works, which stops later handlers.
export default function promptStash(pi: ExtensionAPI) {
	const settings = rigSettings(getAgentDir()).declare("prompt-stash", [
		{ key: "enabled", type: "boolean", default: false, description: "Stash prompt drafts with Ctrl+S (reload to apply)" },
	]);
	if (!settings.get("enabled")) return;
	const stash: string[] = [];
	let unsubscribe: (() => void) | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;

	pi.registerShortcut("ctrl+s", {
		description: "Stash the prompt draft, or restore the stash into an empty editor",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;
			const text = ctx.ui.getEditorText();
			if (text.trim()) {
				stash.push(text);
				ctx.ui.setEditorText("");
				ctx.ui.notify(`Prompt stashed (${stash.length} total; restores after your next submit, or Ctrl+S)`, "info");
			} else if (stash.length) {
				ctx.ui.setEditorText(stash.pop()!);
			} else {
				ctx.ui.notify("Nothing stashed", "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		unsubscribe?.();
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!stash.length || !matchesKey(data, "enter")) return;
			const submitted = ctx.ui.getEditorText().trim();
			// Slash commands (/tree, /reload, ...) aren't prompts: /tree loads its own text into the editor.
			if (!submitted || submitted.startsWith("/")) return;
			// Let the editor submit and clear first; restore only if it actually did.
			// The submit may be /reload or a session switch, which makes this ctx stale.
			clearTimeout(pending);
			pending = setTimeout(() => {
				pending = undefined;
				try {
					if (stash.length && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(stash.pop()!);
				} catch {
					// stale ctx: the stash stays for the new session's Ctrl+S
				}
			}, 0);
		});
	});

	pi.on("session_shutdown", () => {
		clearTimeout(pending);
		pending = undefined;
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
