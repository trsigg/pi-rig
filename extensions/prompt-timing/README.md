# Prompt timing

Opt-in diagnostics for the delay between an interactive prompt submission and Pi starting its user-message display.

Logs one line per displayed prompt to `~/.cache/pi-prompt-timing.log`, with total `enter->shown` latency, aggregate handler time, and handlers taking at least 20 ms. Tracks `input`, `before_agent_start`, `agent_start`, `turn_start`, and `context` handlers. No prompt text, transcripts, credentials, or full extension paths are logged.

## Settings

```json
{ "prompt-timing": { "enabled": true } }
```

Default: `false`. Set in the agent directory's `rig.json` or `/rig`, then `/reload`. No tools, commands, or keys.

## Compatibility

Pi's duration stamp measures completed runs, not submit latency or individual extension handlers, so it is not a replacement for this diagnostic.

Wraps exported `ExtensionRunner` methods and each runner's registered handlers. Clocks are isolated per runner; while any enabled session owns the process-wide patch, interactive submits in other runners are also measured. Programmatic and RPC input do not start the clock.

The last shutdown restores methods and handler registrations where feasible. A wrapper installed later by another extension is retained, with the timing wrapper underneath made inert. No patch or timer is installed merely by importing or loading a disabled extension. Log write failures do not interrupt prompts.
