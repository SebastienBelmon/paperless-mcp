import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from "jose";

export interface TokenOptions {
  /** Claims merged over the defaults (iss, aud, sub, client_id, jti, exp). */
  claims?: JWTPayload;
  /** Header fields merged over { alg: "EdDSA", typ: "at+jwt", kid }. */
  header?: { typ?: string; kid?: string };
  /** Signs with this key instead of the published one. */
  privateKey?: CryptoKey;
}

export interface TestIssuer {
  issuer: string;
  jwksUrl: string;
  kid: string;
  sign(resource: string, options?: TokenOptions): Promise<string>;
  close(): Promise<void>;
}

export function generateSigningKey(): Promise<CryptoKey> {
  return generateKeyPair("EdDSA").then(({ privateKey }) => privateKey);
}

/**
 * Starts a fake OAuth issuer that publishes the JWKS of a fresh Ed25519 key at
 * `<issuer>/jwks` and signs access tokens shaped like the real SSO ones.
 */
export async function startTestIssuer(port = 0): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const kid = randomUUID();
  const jwks = JSON.stringify({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" }],
  });

  const server: Server = createServer((req, res) => {
    if (req.url === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(jwks);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const issuer = `http://localhost:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    jwksUrl: `${issuer}/jwks`,
    kid,
    sign: (resource, options = {}) =>
      new SignJWT({
        iss: issuer,
        aud: [resource, `${issuer}/oauth2/userinfo`],
        sub: "e2e-user",
        client_id: "e2e-client",
        jti: randomUUID(),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...options.claims,
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid, ...options.header })
        .sign(options.privateKey ?? privateKey),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
