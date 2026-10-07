---
name: status
description: Show whether this Claude Code session is broadcasting to a Lobby, which room, and as whom. Use when the user asks if they are sharing, live, or connected.
---

# /lobby:status

Report whether this session is broadcasting.

## What to do

```
node "${CLAUDE_PLUGIN_ROOT}/bin/lobby.mjs" status
```

Relay the answer directly. The important line is the first one: broadcasting, or
not. A user should never have to guess whether their session is being shared —
if the output says it is not, say that plainly rather than hedging.

The output also reports how many *other* sessions or directories on this machine
have bindings. That number is not this session; it is there so the user can tell
that other terminals are streaming even when this one is not.
