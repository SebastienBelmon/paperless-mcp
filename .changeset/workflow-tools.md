---
"@baruchiro/paperless-mcp": minor
---

Add `list_workflows`, `get_workflow`, `create_workflow` and `update_workflow` tools

Workflows run actions (for example assigning an owner and view/change permissions) when a trigger such as "Document Added" matches. `update_workflow` replaces the whole list of triggers or actions when it is given one. There is no delete tool: a workflow can be switched off with `enabled: false`.
