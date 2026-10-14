import type express from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OAuthConfig {
  issuer: string;
  jwksUrl: string;
  /** Public URL of the MCP endpoint, which is also the expected token audience. */
  resource: string;
}

const metadataPath = "/.well-known/oauth-protected-resource";

/**
 * Makes the HTTP transport an OAuth 2.0 protected resource: serves the RFC 9728
 * metadata and rejects any request on the MCP endpoints that has no valid
 * access token from the configured issuer.
 */
export function registerOAuth(
  app: express.Express,
  config: OAuthConfig,
  getKey: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl))
): void {
  const resourceUrl = new URL(config.resource);
  const resourcePath = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname;
  const challenge = `Bearer resource_metadata="${resourceUrl.origin}${metadataPath}${resourcePath}"`;

  // Clients try the path-specific document first, then the root one.
  app.get([metadataPath, `${metadataPath}${resourcePath}`], (req, res) => {
    res.json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
    });
  });

  app.use(["/mcp", "/sse", "/messages"], async (req, res, next) => {
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    try {
      if (!token) {
        throw new Error("no Bearer token");
      }
      const { payload } = await jwtVerify(token, getKey, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ["EdDSA"],
        typ: "at+jwt",
        clockTolerance: 30,
      });
      console.log(
        `[paperless-mcp] ${req.method} ${req.baseUrl} sub=${payload.sub} client_id=${payload.client_id} jti=${payload.jti}`
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[paperless-mcp] Rejected ${req.method} ${req.baseUrl}: ${reason}`
      );
      res
        .status(401)
        .set("WWW-Authenticate", challenge)
        .json({ error: "unauthorized" });
      return;
    }
    next();
  });
}
