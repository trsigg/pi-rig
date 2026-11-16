# ask-user

`ask_user` asks one to four questions in a bottom panel, keeping the transcript visible.
It replaces `pi-ask-user`.

## Tool

`ask_user({ message, questions })`:

- `message` (required): the user's context, rendered as Markdown above the call row and retained in history. Put explanations here, not in hidden thinking.
- Each question has `question`, `header` (at most 12 columns), optional `options` (2–4 labels with optional descriptions) and optional `multiSelect`.
- Every question accepts a typed answer or skip. Multiple questions end on a review tab with an optional note.
- Results contain `header: labels`, `header: "typed"` or `header: skipped`, plus `note: ...` when given. Cancellation returns `cancelled`.
- An unanswered panel closes after `timeoutMinutes` and returns `timed out: …`, asking the agent to stop or continue on a stated assumption.
- An empty `message` requires visible assistant text in the same message. Thinking does not count; narration counts only while the narration renderer is active.
- Headers, questions and labels are normalized to plain single lines. Aborting the turn closes the panel.
- Non-TUI calls fail with guidance to state an assumption and continue. Child sessions do not get the tool.

## Keys

| Key | Action |
|---|---|
| ↑↓ | Move between answers |
| Enter | Choose or confirm; an empty text answer skips |
| Space | Toggle a multi-select option |
| Typing | Edit the free-text answer |
| Tab, Shift+Tab, ←→ | Switch question |
| Pi's `app.interrupt` keys (default Esc) | Cancel the panel |

With a vim-mode main editor, text fields use the same editor class and show its mode.
Remapping `app.interrupt` leaves Esc available for NORMAL mode; Enter, Tab and arrows remain panel controls.

## `rig.json` settings

| Key | Default | Meaning |
|---|---|---|
| `askUser.timeoutMinutes` | 20 | Minutes before an unanswered panel times out; 0 = never |

No commands or additional shortcuts.
