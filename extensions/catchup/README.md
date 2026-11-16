# Catchup

Shows a footer estimate while you catch up by quoting earlier assistant replies: `⏱ ~20m (8–45) · 9k unread`. A pause marker appears after a longer gap.

## Settings

In the agent directory's `rig.json`:

```json
{ "catchup": { "enabled": true } }
```

Default: `false`. Change through `/rig` or edit the file, then `/reload`.

## Behavior

- Matches `>` quote blocks against normalized assistant text, including `ask_user` questions.
- Rebuilds from session entries at startup; refreshes on messages and every 30 seconds.
- Uses fitted numeric rate parameters in `model.json`. This is a rough reading estimate, not a measured reading position.
- Keeps the original file-order replay semantics, including entries from abandoned branches. It does not reset on `/tree` navigation.
- Clears its timer and footer status on shutdown. No tools, commands, or keys.

Tests use synthetic conversations only; no session files or credentials are needed.
