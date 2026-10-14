---
"@baruchiro/paperless-mcp": patch
---

Clarify the error for unsupported `paperless_filters` keys

The error now explains that Paperless-NGX ignores filters it does not document (which would return every document), and `id__gt`, `id__gte`, `id__lt` and `id__lte` point to the available alternatives: `ordering: "-id"` with `page_size`, `added__date__gt` / `added__date__gte`, or `id__in`. The `query_documents` description says the same.
