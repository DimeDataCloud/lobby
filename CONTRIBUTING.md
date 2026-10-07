# Contributing

## Adding a New Producer

1. Create a directory under `producers/<your-system>/`
2. Write a script that sends events to `http://localhost:4000/events`
3. Include a `--test` flag that sends synthetic events for verification
4. Auto-detect `user_id` from `OBSERVABILITY_USER_ID` env var or OS username
5. Auto-detect `workspace_id` from `OBSERVABILITY_WORKSPACE_ID` env var, git remote, or cwd

## Event Type Convention

Use lowercase snake_case for event types. Common types:

| Event Type | When to emit |
|-----------|-------------|
| `session_start` | Agent starts a new session |
| `session_end` | Agent session ends |
| `turn_start` | A conversation turn begins |
| `turn_end` | A conversation turn ends |
| `tool_call` | Before a tool is invoked |
| `tool_result` | After a tool completes |
| `tool_failure` | Tool execution failed |
| `delegation_start` | A delegation/batch begins |
| `delegation_complete` | A delegation finishes |
| `subagent_start` | A subagent spawns |
| `subagent_stop` | A subagent finishes |
| `model_switch` | Model changed mid-session |
| `compression` | Context window compressed |
| `error` | Any error condition |
| `user_prompt` | User submitted a prompt |

## Adding Dashboard Features

- Vue components go in `apps/client/src/components/`
- Use `useWebSocket` composable for data
- Use `useEventColors` for source colors and event emojis
- All filters from the header apply to all views

## Running Tests

```bash
node ops/test-all.mjs               # every suite needing no browser and no second person
node ops/test-all.mjs --with-live   # also the two that need a server already up
node ops/browser-check.mjs          # the product in a real browser, desktop and phone
```

`TESTING.md` lists the individual commands, what each suite covers, and — more
usefully — what is **not** covered and why.

One rule worth stating: **`ops/test-all.mjs` is the list.** Four documents used to
carry their own copy of the test commands and they drifted, so newly added suites
were missing from three of them. Add a suite there and it is in the one place that
actually runs.

Most integration suites start their own server. The two that do not need
`.\start.ps1` (or `./start.sh`) running first, which is what `--with-live` adds.

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Run `node ops/test-all.mjs` and `node ops/browser-check.mjs`
4. Submit a PR with a description of what you added

If you touched anything a user sees, the browser check is not optional — every
UI bug this project has shipped was invisible to the server-side suites and
obvious on screen.