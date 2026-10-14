---
"@baruchiro/paperless-mcp": patch
---

Stop adding `correspondent: null` and `document_type: null` to document results when Paperless did not return those fields (for example with `fields`). A document without a correspondent or document type still shows `null`.
