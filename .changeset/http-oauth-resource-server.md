---
"@baruchiro/paperless-mcp": major
---

HTTP mode is now an OAuth 2.0 protected resource

Requests to `/mcp`, `/sse` and `/messages` must carry a JWT access token (`Authorization: Bearer`) from the authorization server set with `OAUTH_ISSUER` and `OAUTH_JWKS_URL`, with `MCP_RESOURCE` in its audience. The server then calls Paperless-NGX with its own `PAPERLESS_API_KEY`. The resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.

**Breaking:** a Paperless-NGX API token is no longer accepted as the `Bearer` token, the `--no-auth` flag is removed, and HTTP mode does not start without `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, `MCP_RESOURCE` and `PAPERLESS_API_KEY`. Stdio mode does not change.
