---
name: leave
description: Stop sharing this Claude Code session to its Lobby room. Use when the user wants to stop broadcasting, leave the lobby, or go private again.
---

# /lobby:leave

Stop broadcasting this session.

## What to do

```
node "${CLAUDE_PLUGIN_ROOT}/bin/lobby.mjs" leave
```

Confirm which lobby was left, or say plainly that the session was not in one.

Nothing further is transmitted from this session after this runs. Work already
on the board stays there — leaving stops the stream, it does not retract
history. Say so if the user seems to expect otherwise.
