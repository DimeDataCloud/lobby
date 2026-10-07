---
name: join
description: Join a Lobby room and start sharing THIS Claude Code session onto the shared canvas. Use when the user gives an invite code or asks to join/share a lobby.
---

# /lobby:join

Bind this session to a Lobby room and begin broadcasting its work onto the
shared board.

## What to do

Run, with the code the user gave you:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/lobby.mjs" join <CODE>
```

Then report the outcome back plainly — which lobby, and that only this session
is broadcasting.

If the user did not give a code, ask for it. Codes are six characters, letters
and digits, e.g. `7QK4DS`.

If the server is unreachable, say so and mention `LOBBY_SERVER_URL` (it defaults
to `http://localhost:4000`). Do not retry in a loop.

## What joining actually does

- **Only this session streams.** The binding is keyed on this session's id, so
  other Claude Code terminals on the same machine — including ones in this same
  folder — send nothing.
- **What is shared:** your prompts, which tools ran and with what arguments,
  file paths you edited, and turn boundaries.
- **What is never shared:** the `Read` tool is not hooked at all, tool result
  bodies are not sent, and secrets (API keys, tokens, private keys, `KEY=`-style
  assignments) are redacted on this machine *before* anything is transmitted.
  Paths like `.env`, `.ssh/`, `.aws/` and `*.pem` are dropped entirely.
- Stop at any time with `/lobby:leave`.

Tell the user this if they ask what is being shared. Do not overstate the
protection: redaction is best-effort, so they should not stream work they are
not authorized to share.
