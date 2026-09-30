---
"@baruchiro/paperless-mcp": minor
---

Add `offset` and `max_length` to `get_document_content`

Long documents can now be read in slices. When either parameter is passed, the response also includes `total_length` and `next_offset` (`null` at the end of the text). Without them, the response is unchanged.
