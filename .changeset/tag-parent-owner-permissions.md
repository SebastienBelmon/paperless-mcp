---
"@baruchiro/paperless-mcp": minor
---

Set a tag's parent, owner, and permissions when creating or updating tags, correspondents, and document types

`create_tag` and `update_tag` accept `parent` (the ID of the parent tag; `null` on update detaches the tag from its parent). `create_*` and `update_*` for tags, correspondents, and document types accept `owner` (defaults to the API user on create; `null` removes the owner) and `set_permissions` to set which users and groups can view and change the object (an empty list clears it). A misspelled key inside `set_permissions` is rejected instead of being ignored.

`update_tag` is now a partial update: only `id` is required, and omitted fields keep their current value.
