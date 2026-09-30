---
"@baruchiro/paperless-mcp": minor
---

Add a `fields` argument to `list_documents` and `query_documents`

Pass a list of document fields (for example `["id","title","correspondent","tags","created"]`) to get only those fields from Paperless and keep results small. Without it, the response is unchanged.
