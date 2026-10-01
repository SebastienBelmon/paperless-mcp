import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { registerWorkflowTools } from "./workflows";

function parseToolText(result: CallToolResult) {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text tool response");
  }
  return JSON.parse(item.text);
}

async function withWorkflowClient(
  api: PaperlessAPI,
  run: (client: Client) => Promise<void>
) {
  const server = new McpServer({ name: "paperless-workflow-test", version: "1.0.0" });
  registerWorkflowTools(server, api);

  const client = new Client({ name: "paperless-workflow-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function isRejected(client: Client, name: string, args: Record<string, unknown>) {
  return client
    .callTool({ name, arguments: args })
    .then((result) => (result as CallToolResult).isError === true)
    .catch(() => true);
}

test("workflow tools are registered and there is no delete tool", async () => {
  await withWorkflowClient({} as PaperlessAPI, async (client) => {
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "create_workflow",
      "get_workflow",
      "list_workflows",
      "update_workflow",
    ]);
  });
});

test("list_workflows and get_workflow forward their arguments", async () => {
  const calls: unknown[] = [];
  const api = {
    getWorkflows: async (queryString: string) => {
      calls.push(["list", queryString]);
      return { count: 0, next: null, previous: null, results: [] };
    },
    getWorkflow: async (id: number) => {
      calls.push(["get", id]);
      return { id, name: "Assign owner", order: 1, enabled: true, triggers: [], actions: [] };
    },
  } as unknown as PaperlessAPI;

  await withWorkflowClient(api, async (client) => {
    await client.callTool({
      name: "list_workflows",
      arguments: { page: 2, page_size: 10 },
    });
    const result = (await client.callTool({
      name: "get_workflow",
      arguments: { id: 4 },
    })) as CallToolResult;

    assert.equal(parseToolText(result).id, 4);
  });

  assert.deepEqual(calls, [["list", "page=2&page_size=10"], ["get", 4]]);
});

test("create_workflow forwards nested triggers and actions unchanged", async () => {
  const calls: unknown[] = [];
  const api = {
    createWorkflow: async (data: object) => {
      calls.push(data);
      return { id: 11, ...data };
    },
  } as unknown as PaperlessAPI;
  const workflow = {
    name: "Assign owner and permissions",
    order: 1,
    enabled: true,
    triggers: [{ type: 2, sources: [1, 2, 3, 4] }],
    actions: [
      {
        type: 1,
        assign_owner: 3,
        assign_view_users: [4, 5],
        assign_change_users: [4],
      },
    ],
  };

  await withWorkflowClient(api, async (client) => {
    const result = (await client.callTool({
      name: "create_workflow",
      arguments: workflow,
    })) as CallToolResult;

    assert.equal(parseToolText(result).id, 11);
  });

  assert.deepEqual(calls, [workflow]);
});

test("create_workflow forwards filters, schedule, email and webhook fields", async () => {
  const calls: unknown[] = [];
  const api = {
    createWorkflow: async (data: object) => {
      calls.push(data);
      return { id: 12, ...data };
    },
  } as unknown as PaperlessAPI;
  const workflow = {
    name: "Notify",
    triggers: [
      {
        type: 4,
        schedule_date_field: "created",
        schedule_offset_days: -7,
        matching_algorithm: 5,
        match: "invoice",
        filter_has_correspondent: null,
        filter_has_tags: [2],
      },
    ],
    actions: [
      {
        type: 3,
        email: { subject: "Due", body: "Soon", to: "a@example.test", include_document: true },
      },
      {
        type: 4,
        webhook: { url: "https://hook.example.test", as_json: true, params: { k: "v" } },
      },
    ],
  };

  await withWorkflowClient(api, async (client) => {
    await client.callTool({ name: "create_workflow", arguments: workflow });
  });

  assert.deepEqual(calls, [workflow]);
});

test("update_workflow does not send the id in the body and leaves omitted keys out", async () => {
  const calls: unknown[] = [];
  const api = {
    updateWorkflow: async (id: number, data: object) => {
      calls.push([id, data]);
      return { id, ...data };
    },
  } as unknown as PaperlessAPI;

  await withWorkflowClient(api, async (client) => {
    await client.callTool({
      name: "update_workflow",
      arguments: { id: 9, enabled: false },
    });
    await client.callTool({
      name: "update_workflow",
      arguments: {
        id: 9,
        triggers: [{ id: 12, type: 2 }],
        actions: [{ id: 5, type: 1, assign_owner: null }, { type: 1, assign_view_users: [4] }],
      },
    });
  });

  assert.deepEqual(calls, [
    [9, { enabled: false }],
    [
      9,
      {
        triggers: [{ id: 12, type: 2 }],
        actions: [{ id: 5, type: 1, assign_owner: null }, { type: 1, assign_view_users: [4] }],
      },
    ],
  ]);
});

test("create_workflow rejects out-of-range enums and missing parts without calling the API", async () => {
  const calls: unknown[] = [];
  const api = {
    createWorkflow: async (data: object) => {
      calls.push(data);
      return data;
    },
  } as unknown as PaperlessAPI;
  const action = { type: 1, assign_owner: 3 };
  const invalidWorkflows = [
    { name: "bad type", triggers: [{ type: 5 }], actions: [action] },
    { name: "bad type", triggers: [{ type: 0 }], actions: [action] },
    { name: "bad source", triggers: [{ type: 2, sources: [5] }], actions: [action] },
    { name: "bad algorithm", triggers: [{ type: 2, matching_algorithm: 6 }], actions: [action] },
    { name: "bad action", triggers: [{ type: 2 }], actions: [{ type: 5 }] },
    { name: "bad date field", triggers: [{ type: 4, schedule_date_field: "deleted" }], actions: [action] },
    { name: "no actions", triggers: [{ type: 2 }] },
  ];

  await withWorkflowClient(api, async (client) => {
    for (const workflow of invalidWorkflows) {
      assert.equal(
        await isRejected(client, "create_workflow", workflow),
        true,
        JSON.stringify(workflow)
      );
    }
  });

  assert.deepEqual(calls, []);
});
