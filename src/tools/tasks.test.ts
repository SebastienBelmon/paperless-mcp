import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { PaperlessTask } from "../api/types";
import { registerTaskTools } from "./tasks";

function parseToolText(result: CallToolResult) {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text tool response");
  }
  return JSON.parse(item.text);
}

async function withTaskClient(
  api: PaperlessAPI,
  run: (client: Client) => Promise<void>
) {
  const server = new McpServer({ name: "paperless-task-test", version: "1.0.0" });
  registerTaskTools(server, api);

  const client = new Client({ name: "paperless-task-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function task(overrides: Partial<PaperlessTask> & { task_id: string }): PaperlessTask {
  return {
    id: 1,
    task_name: "consume_file",
    task_file_name: "invoice.pdf",
    date_created: "2026-01-01T10:00:00Z",
    date_done: null,
    type: "manual_task",
    status: "PENDING",
    result: null,
    acknowledged: false,
    related_document: null,
    owner: null,
    ...overrides,
  };
}

// Each call to getTasks(id) returns the next scripted response for that id; the last one repeats.
function scriptedApi(script: Record<string, PaperlessTask[][]>) {
  const calls: string[] = [];
  const position: Record<string, number> = {};
  const api = {
    getTasks: async (taskId: string) => {
      calls.push(taskId);
      const responses = script[taskId];
      const index = Math.min(position[taskId] ?? 0, responses.length - 1);
      position[taskId] = index + 1;
      return responses[index];
    },
  } as unknown as PaperlessAPI;
  return { api, calls };
}

test("get_task maps the task and converts related_document to a number", async () => {
  const { api, calls } = scriptedApi({
    "uuid-1": [
      [
        task({
          task_id: "uuid-1",
          status: "SUCCESS",
          result: "Success. New document id 42 created",
          related_document: "42",
          date_done: "2026-01-01T10:00:05Z",
        }),
      ],
    ],
  });

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool({
      name: "get_task",
      arguments: { task_id: "uuid-1" },
    })) as CallToolResult;

    assert.deepEqual(parseToolText(result), {
      task_id: "uuid-1",
      status: "SUCCESS",
      result: "Success. New document id 42 created",
      related_document: 42,
      task_file_name: "invoice.pdf",
      date_created: "2026-01-01T10:00:00Z",
      date_done: "2026-01-01T10:00:05Z",
    });
  });

  assert.deepEqual(calls, ["uuid-1"]);
});

test("get_task reports the error message of a failed task", async () => {
  const { api } = scriptedApi({
    "uuid-2": [
      [
        task({
          task_id: "uuid-2",
          status: "FAILURE",
          result: "invoice.pdf: Not consuming invoice.pdf: It is a duplicate of other.pdf (#3)",
        }),
      ],
    ],
  });

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool({
      name: "get_task",
      arguments: { task_id: "uuid-2" },
    })) as CallToolResult;
    const response = parseToolText(result);

    assert.equal(response.status, "FAILURE");
    assert.equal(
      response.result,
      "invoice.pdf: Not consuming invoice.pdf: It is a duplicate of other.pdf (#3)"
    );
    assert.equal(response.related_document, null);
  });
});

test("get_task returns NOT_FOUND instead of failing when the task is unknown", async () => {
  const { api } = scriptedApi({ "uuid-3": [[]] });

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool({
      name: "get_task",
      arguments: { task_id: "uuid-3" },
    })) as CallToolResult;

    assert.notEqual(result.isError, true);
    assert.deepEqual(parseToolText(result), {
      task_id: "uuid-3",
      status: "NOT_FOUND",
    });
  });
});

test("get_task uses the first row when several are returned", async () => {
  const { api } = scriptedApi({
    "uuid-4": [
      [
        task({ task_id: "uuid-4", status: "STARTED" }),
        task({ task_id: "uuid-4", status: "SUCCESS", related_document: "9" }),
      ],
    ],
  });

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool({
      name: "get_task",
      arguments: { task_id: "uuid-4" },
    })) as CallToolResult;

    assert.equal(parseToolText(result).status, "STARTED");
  });
});

test("wait_for_tasks polls only unfinished tasks until all are final and reports progress", async () => {
  const { api, calls } = scriptedApi({
    done: [[task({ task_id: "done", status: "SUCCESS", related_document: "1" })]],
    slow: [
      [task({ task_id: "slow", status: "PENDING" })],
      [task({ task_id: "slow", status: "STARTED" })],
      [task({ task_id: "slow", status: "SUCCESS", related_document: "7" })],
    ],
  });
  const progress: unknown[] = [];

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool(
      {
        name: "wait_for_tasks",
        arguments: { task_ids: ["done", "slow"], interval_seconds: 1 },
      },
      undefined,
      { onprogress: (update) => progress.push(update) }
    )) as CallToolResult;
    const response = parseToolText(result);

    assert.equal(response.all_done, true);
    assert.equal(response.timed_out, false);
    assert.deepEqual(
      response.tasks.map((t: { task_id: string; status: string; related_document: number }) => [
        t.task_id,
        t.status,
        t.related_document,
      ]),
      [
        ["done", "SUCCESS", 1],
        ["slow", "SUCCESS", 7],
      ]
    );
  });

  assert.deepEqual(calls, ["done", "slow", "slow", "slow"]);
  assert.deepEqual(progress, [
    { progress: 1, total: 2, message: "1/2 tasks finished" },
  ]);
});

test("wait_for_tasks returns timed_out with the last states, NOT_FOUND counting as not final", async () => {
  const { api, calls } = scriptedApi({
    running: [[task({ task_id: "running", status: "STARTED" })]],
    unknown: [[]],
  });

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool({
      name: "wait_for_tasks",
      arguments: {
        task_ids: ["running", "unknown"],
        interval_seconds: 1,
        timeout_seconds: 1,
      },
    })) as CallToolResult;
    const response = parseToolText(result);

    assert.equal(response.all_done, false);
    assert.equal(response.timed_out, true);
    assert.deepEqual(
      response.tasks.map((t: { task_id: string; status: string }) => [t.task_id, t.status]),
      [
        ["running", "STARTED"],
        ["unknown", "NOT_FOUND"],
      ]
    );
  });

  assert.ok(calls.filter((id) => id === "running").length >= 2);
});

test("wait_for_tasks treats FAILURE and REVOKED as final and returns without waiting", async () => {
  const { api, calls } = scriptedApi({
    failed: [[task({ task_id: "failed", status: "FAILURE", result: "boom" })]],
    revoked: [[task({ task_id: "revoked", status: "REVOKED" })]],
  });

  await withTaskClient(api, async (client) => {
    const result = (await client.callTool({
      name: "wait_for_tasks",
      arguments: { task_ids: ["failed", "revoked"] },
    })) as CallToolResult;
    const response = parseToolText(result);

    assert.equal(response.all_done, true);
    assert.equal(response.timed_out, false);
    assert.equal(response.tasks[0].result, "boom");
  });

  assert.deepEqual(calls, ["failed", "revoked"]);
});

test("wait_for_tasks stops polling when the client cancels the call", async () => {
  const { api, calls } = scriptedApi({
    pending: [[task({ task_id: "pending", status: "PENDING" })]],
  });

  await withTaskClient(api, async (client) => {
    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "wait_for_tasks",
        arguments: { task_ids: ["pending"], interval_seconds: 1, timeout_seconds: 60 },
      },
      undefined,
      { signal: controller.signal }
    );
    while (calls.length === 0) {
      await sleep(5);
    }
    controller.abort();
    await assert.rejects(call);

    await sleep(1300);
    assert.equal(calls.length, 1);
  });
});

test("wait_for_tasks rejects an empty task list and an out-of-range timeout", async () => {
  const { api, calls } = scriptedApi({});

  await withTaskClient(api, async (client) => {
    for (const args of [
      { task_ids: [] },
      { task_ids: ["a"], timeout_seconds: 601 },
      { task_ids: ["a"], interval_seconds: 0 },
    ]) {
      const outcome = await client
        .callTool({ name: "wait_for_tasks", arguments: args })
        .then((result) => (result as CallToolResult).isError === true)
        .catch(() => true);
      assert.equal(outcome, true, JSON.stringify(args));
    }
  });

  assert.deepEqual(calls, []);
});
