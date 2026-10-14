---
"@baruchiro/paperless-mcp": minor
---

Stream `file_path` uploads and make the upload size limit configurable

`post_document` with `file_path` now streams the file to Paperless-NGX instead of reading it into memory, so large files no longer need as much memory as their size. The 100MB limit is unchanged by default; set `PAPERLESS_MCP_MAX_UPLOAD_MB` to change it (`0` removes it). Streamed uploads do not follow redirects: a redirect (for example `http://` to `https://`) is now reported as an error asking you to set `PAPERLESS_URL` to the final URL. The `post_document` description also states that the result is the import task UUID.
