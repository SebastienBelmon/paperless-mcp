import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { registerCorrespondentTools } from "./correspondents";
import { registerDocumentTypeTools } from "./documentTypes";
import { registerTagTools } from "./tags";

interface RecordedRequest {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

async function withToolClient(
  run: (client: Client, requests: RecordedRequest[]) => Promise<void>
) {
  const requests: RecordedRequest[] = [];
  const api = Object.assign(new PaperlessAPI("http://paperless.test", "token"), {
    request: async (path: string, options: RequestInit = {}) => {
      requests.push({
        path,
        method: options.method ?? "GET",
        body: JSON.parse(String(options.body)),
      });
      return { id: 1, name: "stored", matching_algorithm: 1 };
    },
  });

  const server = new McpServer({ name: "object-fields-test", version: "1.0.0" });
  registerTagTools(server, api);
  registerCorrespondentTools(server, api);
  registerDocumentTypeTools(server, api);

  const client = new Client({ name: "object-fields-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await run(client, requests);
  } finally {
    await client.close();
    await server.close();
  }
}

const SET_PERMISSIONS = {
  view: { users: [1, 2], groups: [] },
  change: { groups: [3] },
};

const ENTITIES = [
  { tool: "tag", collection: "tags" },
  { tool: "correspondent", collection: "correspondents" },
  { tool: "document_type", collection: "document_types" },
];

describe("update_tag partial update", () => {
  test("id and color only send a PATCH body with only color", async () => {
    await withToolClient(async (client, requests) => {
      await client.callTool({
        name: "update_tag",
        arguments: { id: 5, color: "#ff0000" },
      });

      assert.deepEqual(requests, [
        { path: "/tags/5/", method: "PATCH", body: { color: "#ff0000" } },
      ]);
    });
  });

  test("name is not required", async () => {
    await withToolClient(async (client) => {
      const { tools } = await client.listTools();
      const updateTag = tools.find((tool) => tool.name === "update_tag");

      assert.deepEqual(updateTag?.inputSchema.required, ["id"]);
    });
  });

  test("parent null and owner null are sent, not dropped", async () => {
    await withToolClient(async (client, requests) => {
      await client.callTool({
        name: "update_tag",
        arguments: { id: 5, parent: null, owner: null },
      });

      assert.deepEqual(requests[0].body, { parent: null, owner: null });
    });
  });

  test("all existing fields are still forwarded", async () => {
    await withToolClient(async (client, requests) => {
      await client.callTool({
        name: "update_tag",
        arguments: {
          id: 5,
          name: "Invoices",
          color: "#00ff00",
          match: "invoice",
          matching_algorithm: 1,
          parent: 9,
        },
      });

      assert.deepEqual(requests[0].body, {
        name: "Invoices",
        color: "#00ff00",
        match: "invoice",
        matching_algorithm: 1,
        parent: 9,
      });
    });
  });
});

describe("create_tag parent", () => {
  test("forwards parent", async () => {
    await withToolClient(async (client, requests) => {
      await client.callTool({
        name: "create_tag",
        arguments: { name: "Child", parent: 3 },
      });

      assert.deepEqual(requests, [
        { path: "/tags/", method: "POST", body: { name: "Child", parent: 3 } },
      ]);
    });
  });
});

for (const { tool, collection } of ENTITIES) {
  describe(`${tool} owner and set_permissions`, () => {
    test(`create_${tool} forwards owner and set_permissions untouched`, async () => {
      await withToolClient(async (client, requests) => {
        await client.callTool({
          name: `create_${tool}`,
          arguments: { name: "New", owner: 7, set_permissions: SET_PERMISSIONS },
        });

        assert.deepEqual(requests, [
          {
            path: `/${collection}/`,
            method: "POST",
            body: { name: "New", owner: 7, set_permissions: SET_PERMISSIONS },
          },
        ]);
      });
    });

    test(`update_${tool} sends a PATCH without id and forwards owner null and set_permissions`, async () => {
      await withToolClient(async (client, requests) => {
        await client.callTool({
          name: `update_${tool}`,
          arguments: {
            id: 4,
            name: "Renamed",
            owner: null,
            set_permissions: SET_PERMISSIONS,
          },
        });

        assert.deepEqual(requests, [
          {
            path: `/${collection}/4/`,
            method: "PATCH",
            body: {
              name: "Renamed",
              owner: null,
              set_permissions: SET_PERMISSIONS,
            },
          },
        ]);
        assert.ok(!("id" in requests[0].body));
      });
    });

    test(`create_${tool} omits owner and set_permissions when not given`, async () => {
      await withToolClient(async (client, requests) => {
        await client.callTool({ name: `create_${tool}`, arguments: { name: "Plain" } });

        assert.deepEqual(requests[0].body, { name: "Plain" });
      });
    });

    for (const [label, setPermissions] of [
      ["unknown action key", { read: { users: [1] } }],
      ["unknown subject key", { view: { user: [1] } }],
    ] as const) {
      test(`create_${tool} rejects set_permissions with an ${label}`, async () => {
        await withToolClient(async (client, requests) => {
          const result = await client
            .callTool({
              name: `create_${tool}`,
              arguments: { name: "New", set_permissions: setPermissions },
            })
            .catch((error: Error) => error);

          const message =
            result instanceof Error ? result.message : JSON.stringify(result);
          assert.match(message, /unrecognized key/i);
          assert.deepEqual(requests, []);
        });
      });
    }
  });
}
