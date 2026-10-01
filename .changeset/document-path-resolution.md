---
"@baruchiro/paperless-mcp": patch
---

Fix `file_path` uploads with accented names and Windows paths

Files whose name or folders use a different Unicode normalization (NFC or NFD) than the one on disk are now found instead of failing with "File not found", and the error now names the requested path. `PAPERLESS_MCP_UPLOAD_PATHS` is split on `;` on Windows (so `Z:\Manuels` stays intact) and `:` elsewhere, allowed directories are resolved like the uploaded file, and matching works with backslashes, drive letters, UNC paths and case-insensitively on Windows.
