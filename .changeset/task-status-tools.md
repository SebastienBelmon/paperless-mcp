---
"@baruchiro/paperless-mcp": minor
---

Add `get_task` and `wait_for_tasks` tools to follow an import started by `post_document`

`post_document` returns a task UUID. `get_task` returns the status of that task, the created document ID (as a number) on success and the error message on failure. `wait_for_tasks` polls several tasks until they are all finished (default 55 seconds, so that it stays below the timeout of most MCP clients) and reports `timed_out` so that the call can be repeated.
