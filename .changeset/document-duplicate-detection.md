---
"@baruchiro/paperless-mcp": minor
---

Add `check_duplicates` and `skip_if_duplicate` to detect documents already in Paperless

`check_duplicates` takes a list of absolute `file_paths`, hashes each file and reports whether a document with the same checksum exists, without uploading anything. `post_document` accepts `skip_if_duplicate: true` to return the existing document instead of uploading a duplicate. The hash algorithm (SHA-256, or MD5 on older instances) is detected automatically. Files whose checksum matches only an existing archive file are not detected.
