import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { connectMcpClient } from "./client";
import { generateSigningKey, startTestIssuer, TestIssuer } from "./oauth";

const MCP_PORT = 3002;
const MCP_RESOURCE = `http://localhost:${MCP_PORT}/mcp`;
const METADATA_URL = `http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource`;
const CHALLENGE = `Bearer resource_metadata="${METADATA_URL}/mcp"`;
// Only tools/list is exercised, so Paperless itself is never called.
const PAPERLESS_ENV = {
  PAPERLESS_URL: "http://127.0.0.1:9",
  PAPERLESS_API_KEY: randomBytes(20).toString("hex"),
};

let issuer: TestIssuer;
let mcpProcess: ChildProcess;
let logs = "";
const sentTokens: string[] = [];

function oauthEnv(): Record<string, string> {
  return {
    OAUTH_ISSUER: issuer.issuer,
    OAUTH_JWKS_URL: issuer.jwksUrl,
    MCP_RESOURCE,
  };
}

function spawnServer(env: Record<string, string>, port: number): ChildProcess {
  const baseEnv = { ...process.env };
  delete baseEnv.OAUTH_ISSUER;
  delete baseEnv.OAUTH_JWKS_URL;
  delete baseEnv.MCP_RESOURCE;
  return spawn("node", ["build/index.js", "--http", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...baseEnv, ...PAPERLESS_ENV, ...env },
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(METADATA_URL)).status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MCP server did not start in time. Logs:\n${logs}`);
}

function postMcp(token?: string, scheme = "Bearer"): Promise<Response> {
  if (token) sentTokens.push(token);
  return fetch(MCP_RESOURCE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `${scheme} ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function assertRejected(res: Response): Promise<void> {
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("www-authenticate"), CHALLENGE);
  await res.body?.cancel();
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Reuses the claims of a valid token under another header and signature. */
async function resignedToken(
  header: object,
  signature: (signingInput: string) => string
): Promise<string> {
  const [, payload] = (await issuer.sign(MCP_RESOURCE)).split(".");
  const signingInput = `${base64url(header)}.${payload}`;
  return `${signingInput}.${signature(signingInput)}`;
}

before(async () => {
  issuer = await startTestIssuer();
  mcpProcess = spawnServer(oauthEnv(), MCP_PORT);
  mcpProcess.stdout?.on("data", (d) => (logs += d));
  mcpProcess.stderr?.on("data", (d) => (logs += d));
  await waitForServer();
});

after(async () => {
  mcpProcess?.kill("SIGTERM");
  await issuer?.close();
});

describe("OAuth protected resource (HTTP mode)", () => {
  it("serves the protected resource metadata on both well-known paths", async () => {
    for (const url of [METADATA_URL, `${METADATA_URL}/mcp`]) {
      const res = await fetch(url);
      assert.strictEqual(res.status, 200, url);
      const metadata = (await res.json()) as Record<string, unknown>;
      assert.strictEqual(metadata.resource, MCP_RESOURCE);
      assert.deepStrictEqual(metadata.authorization_servers, [issuer.issuer]);
      assert.deepStrictEqual(metadata.bearer_methods_supported, ["header"]);
    }
  });

  it("answers a request without a token with 401 and the resource_metadata challenge", async () => {
    await assertRejected(await postMcp());
  });

  it("rejects an opaque token and a Paperless API token", async () => {
    await assertRejected(await postMcp(randomBytes(32).toString("base64url")));
    await assertRejected(await postMcp(PAPERLESS_ENV.PAPERLESS_API_KEY));
    await assertRejected(await postMcp(PAPERLESS_ENV.PAPERLESS_API_KEY, "Token"));
  });

  it("rejects an expired token", async () => {
    const token = await issuer.sign(MCP_RESOURCE, {
      claims: { exp: Math.floor(Date.now() / 1000) - 120 },
    });
    await assertRejected(await postMcp(token));
  });

  it("rejects a token whose audience does not contain the resource", async () => {
    const token = await issuer.sign(MCP_RESOURCE, {
      claims: { aud: [`${issuer.issuer}/oauth2/userinfo`, "http://localhost:9/mcp"] },
    });
    await assertRejected(await postMcp(token));
  });

  it("rejects a token whose typ is not at+jwt", async () => {
    const token = await issuer.sign(MCP_RESOURCE, { header: { typ: "JWT" } });
    await assertRejected(await postMcp(token));
  });

  it("rejects a token from another issuer and a token signed by another key", async () => {
    const otherIssuer = await issuer.sign(MCP_RESOURCE, {
      claims: { iss: "http://localhost:9/other-issuer" },
    });
    await assertRejected(await postMcp(otherIssuer));

    const otherKey = await issuer.sign(MCP_RESOURCE, {
      privateKey: await generateSigningKey(),
    });
    await assertRejected(await postMcp(otherKey));
  });

  it("rejects an HS256 token and an alg none token", async () => {
    const hs256 = await resignedToken(
      { alg: "HS256", typ: "at+jwt", kid: issuer.kid },
      (input) => createHmac("sha256", "e2e-shared-secret").update(input).digest("base64url")
    );
    await assertRejected(await postMcp(hs256));

    const none = await resignedToken({ alg: "none", typ: "at+jwt" }, () => "");
    await assertRejected(await postMcp(none));
  });

  it("protects the SSE endpoints too", async () => {
    for (const [method, path] of [
      ["GET", "/sse"],
      ["POST", "/messages?sessionId=unknown"],
    ]) {
      const res = await fetch(`http://localhost:${MCP_PORT}${path}`, { method });
      await assertRejected(res);
    }
  });

  it("lists the tools with a valid token", async () => {
    const token = await issuer.sign(MCP_RESOURCE);
    sentTokens.push(token);
    const client = await connectMcpClient(MCP_RESOURCE, token);
    try {
      const { tools } = await client.listTools();
      assert.ok(
        tools.some((t) => t.name === "get_document_content"),
        `expected get_document_content in ${tools.map((t) => t.name).join(", ")}`
      );
    } finally {
      await client.close();
    }
  });

  it("logs sub and jti of accepted tokens and never a token", async () => {
    assert.match(logs, /sub=e2e-user client_id=e2e-client jti=[0-9a-f-]{36}/);
    assert.ok(sentTokens.length > 0);
    for (const token of sentTokens) {
      assert.ok(!logs.includes(token), `a token appears in the server logs:\n${logs}`);
    }
  });
});

describe("HTTP mode startup", () => {
  for (const missing of ["OAUTH_ISSUER", "OAUTH_JWKS_URL", "MCP_RESOURCE"]) {
    it(`exits with code 1 without ${missing}`, async () => {
      const env = oauthEnv();
      delete env[missing];
      const proc = spawnServer(env, MCP_PORT + 1);
      let stderr = "";
      proc.stderr?.on("data", (d) => (stderr += d));
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(null);
        }, 10000);
        proc.on("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      assert.strictEqual(code, 1);
      assert.match(stderr, /OAUTH_ISSUER, OAUTH_JWKS_URL and MCP_RESOURCE/);
    });
  }
});
