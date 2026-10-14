import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { generateKeyPair, SignJWT } from "jose";
import { registerOAuth } from "./auth";

const issuer = "http://localhost:3001/api/auth";
const resource = "https://paperless-mcp.dev.invalid/mcp";

let server: Server;
let baseUrl: string;
let sign: (
  overrides?: { audience?: string[]; expiresIn?: number; typ?: string }
) => Promise<string>;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  sign = ({
    audience = [resource, `${issuer}/oauth2/userinfo`],
    expiresIn = 3600,
    typ = "at+jwt",
  } = {}) =>
    new SignJWT({ client_id: "claude", scope: "openid" })
      .setProtectedHeader({ alg: "EdDSA", typ })
      .setIssuer(issuer)
      .setSubject("user-1")
      .setAudience(audience)
      .setJti("jti-1")
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
      .sign(privateKey);

  const app = express();
  registerOAuth(
    app,
    { issuer, jwksUrl: `${issuer}/jwks`, resource },
    async () => publicKey
  );
  app.all(["/mcp", "/sse", "/messages"], (req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

function post(path: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test("serves the protected resource metadata on both well-known paths", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["openid", "profile", "email", "offline_access"],
    });
  }
});

test("rejects a request without a token and points to the metadata", async () => {
  for (const path of ["/mcp", "/sse", "/messages"]) {
    const res = await post(path);
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get("www-authenticate"),
      'Bearer resource_metadata="https://paperless-mcp.dev.invalid/.well-known/oauth-protected-resource/mcp"'
    );
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
});

test("rejects an opaque token", async () => {
  assert.equal((await post("/mcp", "paperless-api-token")).status, 401);
});

test("rejects a JWT for another audience", async () => {
  const token = await sign({ audience: ["https://other.dev.invalid/mcp"] });
  assert.equal((await post("/mcp", token)).status, 401);
});

test("rejects an expired JWT", async () => {
  const token = await sign({ expiresIn: -3600 });
  assert.equal((await post("/mcp", token)).status, 401);
});

test("rejects a JWT that is not an access token", async () => {
  const token = await sign({ typ: "JWT" });
  assert.equal((await post("/mcp", token)).status, 401);
});

test("accepts a valid access token", async () => {
  const res = await post("/mcp", await sign());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
