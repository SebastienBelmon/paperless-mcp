import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type {
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { CustomField } from "../api/types";
import {
  buildBulkEditParameters,
  registerDocumentTools,
  validateFilePath,
} from "./documents";
import {
  buildDocumentQueryString,
  customFieldQuerySchema,
  CustomFieldQuery,
  DOCUMENT_QUERY_PAPERLESS_FILTER_KEYS,
} from "./utils/documentQuery";
import {
  buildDocumentResourceUri,
  buildThumbnailResourceUri,
} from "./utils/resourceUri";

function getQueryParams(queryString: string) {
  return new URLSearchParams(queryString.replace(/^\?/, ""));
}

function getDocumentQueryParamsFromOpenApi() {
  const openApiPath = join(process.cwd(), "Paperless_ngx_REST_API.yaml");
  const text = readFileSync(openApiPath, "utf8");
  const start = text.indexOf("  /api/documents/:");
  const end = text.indexOf("  /api/documents/{id}/:");
  assert.ok(start >= 0, "OpenAPI docs marker '/api/documents/' not found");
  assert.ok(
    end > start,
    "OpenAPI docs marker '/api/documents/{id}/' not found or out of order"
  );
  const section = text.slice(start, end);

  return Array.from(
    section.matchAll(/^\s*-?\s*name:\s+(.+)$/gm),
    (match) => match[1]
  ).sort();
}

// ALLOWED_UPLOAD_PATHS is read from the environment at module load, so the
// allowlist can only be exercised by re-importing the module with the env set.
function loadDocumentsWithAllowlist(
  allowedPaths: string
): typeof import("./documents") {
  const modulePath = require.resolve("./documents");
  const previous = process.env.PAPERLESS_MCP_UPLOAD_PATHS;
  process.env.PAPERLESS_MCP_UPLOAD_PATHS = allowedPaths;
  delete require.cache[modulePath];
  try {
    return require("./documents");
  } finally {
    delete require.cache[modulePath];
    if (previous === undefined) {
      delete process.env.PAPERLESS_MCP_UPLOAD_PATHS;
    } else {
      process.env.PAPERLESS_MCP_UPLOAD_PATHS = previous;
    }
  }
}

function validateFilePathWithAllowlist(
  allowedPaths: string
): typeof validateFilePath {
  return loadDocumentsWithAllowlist(allowedPaths).validateFilePath;
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("buildBulkEditParameters sends Paperless bulk custom fields as id:value map", () => {
  const parameters = buildBulkEditParameters(
    { remove_custom_fields: [] },
    [
      { field: 9, value: "" },
      { field: 10, value: "2026-05-14" },
    ]
  );

  assert.deepEqual(parameters, {
    remove_custom_fields: [],
    add_custom_fields: {
      "9": "",
      "10": "2026-05-14",
    },
  });
  assert.ok(!("assign_custom_fields" in parameters));
  assert.ok(!("assign_custom_fields_values" in parameters));
});

test("buildBulkEditParameters preserves null custom field values", () => {
  const parameters = buildBulkEditParameters({}, [{ field: 9, value: null }]);

  assert.deepEqual(parameters, {
    add_custom_fields: {
      "9": null,
    },
  });
});

test("buildBulkEditParameters includes Paperless-required empty custom field keys", () => {
  const parameters = buildBulkEditParameters({}, undefined, true);

  assert.deepEqual(parameters, {
    add_custom_fields: {},
    remove_custom_fields: [],
  });
});

test("buildBulkEditParameters preserves an empty custom fields array", () => {
  const parameters = buildBulkEditParameters({}, []);

  assert.deepEqual(parameters, {
    add_custom_fields: {},
  });
  assert.ok(!("remove_custom_fields" in parameters));
});

test("buildBulkEditParameters preserves an empty custom fields array with defaults", () => {
  const parameters = buildBulkEditParameters({}, [], true);

  assert.deepEqual(parameters, {
    add_custom_fields: {},
    remove_custom_fields: [],
  });
});

test("buildBulkEditParameters combines base parameters with custom fields", () => {
  const parameters = buildBulkEditParameters(
    { add_tags: [3], remove_tags: [1, 2] },
    [{ field: 9, value: "pending" }]
  );

  assert.deepEqual(parameters, {
    add_tags: [3],
    remove_tags: [1, 2],
    add_custom_fields: {
      "9": "pending",
    },
  });
});

test("buildBulkEditParameters preserves supported custom field value types", () => {
  const parameters = buildBulkEditParameters({}, [
    { field: 1, value: 42 },
    { field: 2, value: true },
    { field: 3, value: "" },
    { field: 4, value: null },
    { field: 5, value: [123, 456] },
  ]);

  assert.deepEqual(parameters.add_custom_fields, {
    "1": 42,
    "2": true,
    "3": "",
    "4": null,
    "5": [123, 456],
  });
});

test("paperless filter allowlist stays in sync with the document OpenAPI section", () => {
  const documentedParams = getDocumentQueryParamsFromOpenApi();
  const allowedParams = [...DOCUMENT_QUERY_PAPERLESS_FILTER_KEYS].sort();

  assert.deepEqual(allowedParams, documentedParams);
});

test("serializes full-text query_documents arguments", () => {
  const query = getQueryParams(
    buildDocumentQueryString({
      query: "invoice 2024",
      search: "jan",
      more_like_id: 42,
    })
  );

  assert.equal(query.get("query"), "invoice 2024");
  assert.equal(query.get("search"), "jan");
  assert.equal(query.get("more_like_id"), "42");
});

test("serializes first-class document filters using Paperless parameter names", () => {
  const query = getQueryParams(
    buildDocumentQueryString({
      page: 2,
      page_size: 50,
      ordering: "-created",
      correspondent: 3,
      document_type: 4,
      tag: 5,
      storage_path: 6,
      created__date__gte: "2024-01-01",
      created__date__lte: "2024-12-31",
      archive_serial_number: 99,
      archive_serial_number__isnull: false,
      custom_fields__icontains: "invoice",
    })
  );

  assert.equal(query.get("page"), "2");
  assert.equal(query.get("page_size"), "50");
  assert.equal(query.get("ordering"), "-created");
  assert.equal(query.get("correspondent__id"), "3");
  assert.equal(query.get("document_type__id"), "4");
  assert.equal(query.get("tags__id"), "5");
  assert.equal(query.get("storage_path__id"), "6");
  assert.equal(query.get("created__date__gte"), "2024-01-01");
  assert.equal(query.get("created__date__lte"), "2024-12-31");
  assert.equal(query.get("archive_serial_number"), "99");
  assert.equal(query.get("archive_serial_number__isnull"), "false");
  assert.equal(query.get("custom_fields__icontains"), "invoice");
});

test("serializes paperless_filters arrays as comma-separated values", () => {
  const query = getQueryParams(
    buildDocumentQueryString({
      paperless_filters: {
        fields: ["title", "tags"],
        id__in: [1, 2, 3],
      },
    })
  );

  assert.equal(query.get("fields"), "title,tags");
  assert.equal(query.get("id__in"), "1,2,3");
});

test("serializes raw list custom_field_query strings without JSON encoding", () => {
  const rawCustomFieldQuery = '[7, "icontains", "value"]';
  const query = getQueryParams(
    buildDocumentQueryString({
      custom_field_query: rawCustomFieldQuery,
    })
  );

  assert.equal(query.get("custom_field_query"), rawCustomFieldQuery);
});

test("serializes leaf custom_field_query values as JSON", () => {
  const query = getQueryParams(
    buildDocumentQueryString({
      custom_field_query: ["Invoice Number", "exact", "12345"],
    })
  );

  assert.equal(
    query.get("custom_field_query"),
    JSON.stringify(["Invoice Number", "exact", "12345"])
  );
});

test("serializes numeric custom_field_query field IDs as JSON", () => {
  const query = getQueryParams(
    buildDocumentQueryString({
      custom_field_query: [7, "exact", "12345"],
    })
  );

  assert.equal(
    query.get("custom_field_query"),
    JSON.stringify([7, "exact", "12345"])
  );
});

test("serializes grouped custom_field_query values as JSON", () => {
  const groupedQuery: CustomFieldQuery = [
    "OR",
    [
      ["Invoice Number", "isnull", true],
      ["Invoice Number", "exact", ""],
    ],
  ];

  const query = getQueryParams(
    buildDocumentQueryString({
      custom_field_query: groupedQuery,
    })
  );

  assert.equal(query.get("custom_field_query"), JSON.stringify(groupedQuery));
});

test("rejects unsupported paperless_filters keys", () => {
  assert.throws(
    () =>
      buildDocumentQueryString({
        paperless_filters: {
          not_a_real_filter: "value",
        },
      }),
    /Unsupported paperless_filters key/
  );
});

test("explains that unknown paperless_filters keys would be silently ignored", () => {
  assert.throws(
    () =>
      buildDocumentQueryString({ paperless_filters: { not_a_real_filter: 1 } }),
    /Unsupported paperless_filters key 'not_a_real_filter'.*silently ignores unknown filters.*return all documents/
  );
});

for (const key of ["id__gt", "id__gte", "id__lt", "id__lte"]) {
  test(`${key} is rejected with a hint about the available alternatives`, () => {
    assert.throws(
      () => buildDocumentQueryString({ paperless_filters: { [key]: 100 } }),
      (error: Error) => {
        assert.ok(error.message.startsWith(`Unsupported paperless_filters key '${key}'`));
        assert.match(error.message, /no id range filter/);
        assert.match(error.message, /ordering '-id' with page_size/);
        assert.match(error.message, /added__date__gt/);
        assert.match(error.message, /added__date__gte/);
        assert.match(error.message, /id__in/);
        return true;
      }
    );
  });
}

test("accepts the documented filters that replace an id range", () => {
  const query = getQueryParams(
    buildDocumentQueryString({
      paperless_filters: {
        added__date__gt: "2026-01-01",
        added__date__gte: "2026-01-02",
        checksum__iexact: "ABC123",
        owner__id: 4,
        id__in: [7, 8],
      },
    })
  );

  assert.equal(query.get("added__date__gt"), "2026-01-01");
  assert.equal(query.get("added__date__gte"), "2026-01-02");
  assert.equal(query.get("checksum__iexact"), "ABC123");
  assert.equal(query.get("owner__id"), "4");
  assert.equal(query.get("id__in"), "7,8");
});

test("rejects duplicate first-class and paperless_filters definitions", () => {
  assert.throws(
    () =>
      buildDocumentQueryString({
        correspondent: 7,
        paperless_filters: {
          correspondent__id: 7,
        },
      }),
    /Duplicate filter 'correspondent__id'/
  );
});

test("rejects fields passed both as an argument and in paperless_filters", () => {
  assert.throws(
    () =>
      buildDocumentQueryString({
        fields: ["id"],
        paperless_filters: {
          fields: ["title"],
        },
      }),
    /Duplicate filter 'fields'/
  );
});

describe("fields argument on document list tools", () => {
  for (const tool of ["list_documents", "query_documents"]) {
    test(`${tool} forwards fields to Paperless as a comma-separated list`, async () => {
      const queries: string[] = [];
      const api = {
        getDocuments: async (query: string) => {
          queries.push(query);
          return { count: 0, next: null, previous: null, all: [], results: [] };
        },
      } as unknown as PaperlessAPI;

      await withDocumentClient(api, async (client) => {
        const result = (await client.callTool({
          name: tool,
          arguments: { fields: ["id", "title"] },
        })) as CallToolResult;
        assert.ok(!result.isError, `${tool} failed`);
      });

      assert.equal(queries.length, 1);
      assert.equal(getQueryParams(queries[0]).get("fields"), "id,title");
    });
  }
});

test("rejects invalid custom_field_query shapes", () => {
  assert.equal(customFieldQuerySchema.safeParse(["field", "exact"]).success, false);
  assert.equal(customFieldQuerySchema.safeParse(["AND", []]).success, false);
  assert.equal(
    customFieldQuerySchema.safeParse(["AND", [["field"]]]).success,
    false
  );
  assert.equal(
    customFieldQuerySchema.safeParse(["AND", "iexact", "foo"]).success,
    false
  );
});

describe("validateFilePath", () => {
  let testDir: string;
  let testFile: string;
  let emptyFile: string;
  let symlinkPath: string;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), "paperless-mcp-test-"));
    testFile = join(testDir, "test.pdf");
    writeFileSync(testFile, "%PDF-1.4\ntest content");
    emptyFile = join(testDir, "empty.pdf");
    writeFileSync(emptyFile, "");
    symlinkPath = join(testDir, "link.pdf");
    try {
      symlinkSync(testFile, symlinkPath);
    } catch {
      // Skip if unsupported.
    }
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("accepts a valid absolute file path", async () => {
    await assert.doesNotReject(() => validateFilePath(testFile));
  });

  test("rejects relative paths", async () => {
    await assert.rejects(() => validateFilePath("relative/path.pdf"), {
      message: "file_path must be an absolute path",
    });
  });

  test("rejects non-existent files", async () => {
    const missing = join(testDir, "missing.pdf");
    await assert.rejects(() => validateFilePath(missing), (error: Error) => {
      assert.ok(error.message.startsWith(`File not found: ${missing} `));
      return true;
    });
  });

  test("rejects directories", async () => {
    await assert.rejects(() => validateFilePath(testDir), {
      message: "Path must point to a regular file",
    });
  });

  test("rejects empty files", async () => {
    await assert.rejects(() => validateFilePath(emptyFile), {
      message: "File is empty",
    });
  });

  test("resolves symlinks to the real file", async () => {
    try {
      await assert.doesNotReject(() => validateFilePath(symlinkPath));
    } catch {
      // Skip on systems without symlink support.
    }
  });

  test("rejects files exceeding the maximum size", async () => {
    const largeFile = join(testDir, "large.pdf");
    writeFileSync(largeFile, "%PDF-1.4\n");
    truncateSync(largeFile, 101 * 1024 * 1024);
    await assert.rejects(() => validateFilePath(largeFile), {
      message: /exceeds maximum allowed size/,
    });
  });

  test("returns the resolved real path, following symlinks", async () => {
    assert.equal(await validateFilePath(testFile), realpathSync(testFile));
    if (!existsSync(symlinkPath)) return;
    assert.equal(await validateFilePath(symlinkPath), realpathSync(testFile));
  });

  test("finds a file whose accents are normalized differently from the disk", async () => {
    const dir = join(testDir, "Manuels é");
    mkdirSync(dir.normalize("NFD"));
    const onDisk = join(dir.normalize("NFD"), "Sché.pdf".normalize("NFD"));
    writeFileSync(onDisk, "%PDF-1.4\naccents");

    const resolved = await validateFilePath(join(dir, "Sché.pdf").normalize("NFC"));
    assert.equal(resolved, realpathSync(onDisk));
  });

  test("rejects a file over a lowered PAPERLESS_MCP_MAX_UPLOAD_MB", async () => {
    const file = join(testDir, "two-mb.pdf");
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));

    await withEnv("PAPERLESS_MCP_MAX_UPLOAD_MB", "1", async () => {
      await assert.rejects(() => validateFilePath(file), {
        message:
          "File size (2MB) exceeds maximum allowed size (1MB). Set PAPERLESS_MCP_MAX_UPLOAD_MB to change the limit (0 = unlimited).",
      });
    });
  });

  test("PAPERLESS_MCP_MAX_UPLOAD_MB=0 and larger values accept files over 100MB", async () => {
    const file = join(testDir, "huge.pdf");
    writeFileSync(file, "%PDF-1.4\n");
    truncateSync(file, 150 * 1024 * 1024);

    for (const value of ["0", "500"]) {
      await withEnv("PAPERLESS_MCP_MAX_UPLOAD_MB", value, async () => {
        await assert.doesNotReject(() => validateFilePath(file), value);
      });
    }
  });

  test("an invalid PAPERLESS_MCP_MAX_UPLOAD_MB falls back to the 100MB default", async () => {
    const file = join(testDir, "over-default.pdf");
    writeFileSync(file, "%PDF-1.4\n");
    truncateSync(file, 101 * 1024 * 1024);

    for (const value of ["abc", "-5", "", "Infinity"]) {
      await withEnv("PAPERLESS_MCP_MAX_UPLOAD_MB", value, async () => {
        await assert.rejects(() => validateFilePath(file), {
          message: /maximum allowed size \(100MB\)/,
        });
      });
    }
  });

  test("accepts files within allowed upload paths", async () => {
    const validate = validateFilePathWithAllowlist(realpathSync(testDir));
    await assert.doesNotReject(() => validate(testFile));
  });

  test("rejects files outside allowed upload paths", async () => {
    const validate = validateFilePathWithAllowlist("/some/other/path");
    await assert.rejects(() => validate(testFile), {
      message: /outside allowed upload directories/,
    });
  });

  test("applies the allowlist to the resolved path, including accent normalization", async () => {
    const allowed = join(testDir, "Autorisé");
    const elsewhere = join(testDir, "Ailleurs");
    mkdirSync(allowed.normalize("NFD"));
    mkdirSync(elsewhere);
    const inside = join(allowed.normalize("NFD"), "ok.pdf");
    const outside = join(elsewhere, "no.pdf");
    writeFileSync(inside, "%PDF-1.4\nok");
    writeFileSync(outside, "%PDF-1.4\nno");

    const validate = validateFilePathWithAllowlist(allowed.normalize("NFC"));
    assert.equal(
      await validate(join(allowed, "ok.pdf").normalize("NFC")),
      realpathSync(inside)
    );
    await assert.rejects(() => validate(outside), {
      message: /outside allowed upload directories/,
    });
  });

  test("rejects a symlink inside an allowed directory that points outside it", async () => {
    const allowed = join(testDir, "allowed-links");
    mkdirSync(allowed);
    const link = join(allowed, "escape.pdf");
    try {
      symlinkSync(testFile, link);
    } catch {
      return;
    }

    const validate = validateFilePathWithAllowlist(allowed);
    await assert.rejects(() => validate(link), {
      message: /outside allowed upload directories/,
    });
  });
});


class TestTransport implements Transport {
  peer?: TestTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function createTransportPair() {
  const clientTransport = new TestTransport();
  const serverTransport = new TestTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  return { clientTransport, serverTransport };
}

function parseToolText(result: CallToolResult) {
  const item = result.content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text tool response");
  }
  return JSON.parse(item.text);
}

async function withDocumentClient(
  api: PaperlessAPI,
  run: (client: Client) => Promise<void>,
  register: typeof registerDocumentTools = registerDocumentTools
) {
  const server = new McpServer({ name: "paperless-doc-test", version: "1.0.0" });
  register(server, api);

  const client = new Client({
    name: "paperless-doc-test-client",
    version: "1.0.0",
  });
  const { clientTransport, serverTransport } = createTransportPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

interface DocumentApiCalls {
  updateDocument: Array<[number, Record<string, unknown>]>;
  bulkEditDocuments: Array<[number[], string, Record<string, unknown>]>;
  getCustomField: number[];
}

function createDocumentApi(fields: CustomField[]) {
  const calls: DocumentApiCalls = {
    updateDocument: [],
    bulkEditDocuments: [],
    getCustomField: [],
  };
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const api = {
    getCustomField: async (id: number) => {
      calls.getCustomField.push(id);
      const field = fieldMap.get(id);
      if (!field) throw new Error(`custom field ${id} not found`);
      return field;
    },
    updateDocument: async (id: number, data: Record<string, unknown>) => {
      calls.updateDocument.push([id, data]);
      return { id, custom_fields: data.custom_fields ?? [] };
    },
    bulkEditDocuments: async (
      documents: number[],
      method: string,
      parameters: Record<string, unknown>
    ) => {
      calls.bulkEditDocuments.push([documents, method, parameters]);
      return { result: "OK" };
    },
    getCorrespondents: async () => ({ results: [] }),
    getDocumentTypes: async () => ({ results: [] }),
    getTags: async () => ({ results: [] }),
    getCustomFields: async () => ({ results: [] }),
  } as unknown as PaperlessAPI;
  return { api, calls };
}

const LEGACY_SELECT_FIELD: CustomField = {
  id: 2,
  name: "Retention period",
  data_type: "select",
  extra_data: { select_options: ["1 year", "7 years", "2 years"], default_currency: null },
  document_count: 10,
};

const OBJECT_SELECT_FIELD: CustomField = {
  id: 3,
  name: "Priority",
  data_type: "select",
  extra_data: {
    select_options: [
      { id: "abc123", label: "Low" },
      { id: "def456", label: "High" },
    ],
  },
  document_count: 5,
};

describe("select custom field value resolution in document handlers", () => {
  test("update_document translates a select label to its zero-based index", async () => {
    const { api, calls } = createDocumentApi([LEGACY_SELECT_FIELD]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "update_document",
        arguments: { id: 42, custom_fields: [{ field: 2, value: "1 year" }] },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    assert.equal(calls.updateDocument.length, 1);
    const [, data] = calls.updateDocument[0];
    assert.deepEqual(data.custom_fields, [{ field: 2, value: 0 }]);
  });

  test("update_document sends the option id for 2.17+ select fields (stored form)", async () => {
    const { api, calls } = createDocumentApi([OBJECT_SELECT_FIELD]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "update_document",
        arguments: { id: 7, custom_fields: [{ field: 3, value: "High" }] },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    const [, data] = calls.updateDocument[0];
    assert.deepEqual(data.custom_fields, [{ field: 3, value: "def456" }]);
  });

  test("bulk_edit_documents translates a select label in add_custom_fields", async () => {
    const { api, calls } = createDocumentApi([LEGACY_SELECT_FIELD]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "bulk_edit_documents",
        arguments: {
          documents: [1, 2],
          method: "modify_custom_fields",
          add_custom_fields: [{ field: 2, value: "7 years" }],
        },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    assert.equal(calls.bulkEditDocuments.length, 1);
    const [, , parameters] = calls.bulkEditDocuments[0];
    assert.deepEqual(parameters.add_custom_fields, { "2": 1 });
  });

  test("bulk_edit_documents sends the option id for 2.17+ select fields (stored form)", async () => {
    const { api, calls } = createDocumentApi([OBJECT_SELECT_FIELD]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "bulk_edit_documents",
        arguments: {
          documents: [1],
          method: "modify_custom_fields",
          add_custom_fields: [{ field: 3, value: "High" }],
        },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    const [, , parameters] = calls.bulkEditDocuments[0];
    assert.deepEqual(parameters.add_custom_fields, { "3": "def456" });
  });

  test("update_document rejects an unknown select option with a helpful error", async () => {
    const { api, calls } = createDocumentApi([LEGACY_SELECT_FIELD]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "update_document",
        arguments: { id: 42, custom_fields: [{ field: 2, value: "forever" }] },
      })) as CallToolResult;
      assert.ok(result.isError, "expected an error for an unknown select option");
      const message = parseToolText(result)?.error ?? "";
      assert.match(message, /forever/);
      assert.match(message, /1 year/);
    });

    assert.equal(
      calls.updateDocument.length,
      0,
      "no document update should be sent when the option is invalid"
    );
  });
});

describe("get_document_content offset and max_length", () => {
  const api = {
    getDocument: async (id: number) => ({
      id,
      title: "Manual",
      content: "0123456789",
    }),
  } as unknown as PaperlessAPI;

  async function readContent(args: Record<string, unknown>) {
    let result: CallToolResult | undefined;
    await withDocumentClient(api, async (client) => {
      result = (await client.callTool({
        name: "get_document_content",
        arguments: { id: 1, ...args },
      })) as CallToolResult;
    });
    assert.ok(result && !result.isError, "get_document_content failed");
    return parseToolText(result);
  }

  test("without offset or max_length the response is unchanged", async () => {
    assert.deepEqual(await readContent({}), {
      id: 1,
      title: "Manual",
      content: "0123456789",
    });
  });

  test("returns the requested slice and the offset of the next one", async () => {
    assert.deepEqual(await readContent({ offset: 2, max_length: 3 }), {
      id: 1,
      title: "Manual",
      content: "234",
      total_length: 10,
      next_offset: 5,
    });
  });

  test("next_offset is null on the last slice", async () => {
    const result = await readContent({ offset: 8, max_length: 5 });
    assert.equal(result.content, "89");
    assert.equal(result.next_offset, null);
  });
});

describe("document resource reference tools", () => {
  // Expected URIs come from the builders rather than literals: their exact
  // format is already pinned by utils/resourceUri.test.ts, and what matters
  // here is that the handler surfaces that URI in both content blocks.
  const cases = [
    {
      tool: "download_document",
      args: { id: 4 },
      uri: buildDocumentResourceUri(4),
      mimeType: "application/octet-stream",
    },
    {
      tool: "download_document",
      args: { id: 4, original: true },
      uri: buildDocumentResourceUri(4, { original: true }),
      mimeType: "application/octet-stream",
    },
    {
      tool: "get_document_thumbnail",
      args: { id: 123 },
      uri: buildThumbnailResourceUri(123),
      mimeType: "image/webp",
    },
  ];

  for (const { tool, args, uri, mimeType } of cases) {
    test(`${tool} ${JSON.stringify(args)} returns the URI as text beside the resource`, async () => {
      const { api } = createDocumentApi([]);
      let result: CallToolResult | undefined;
      await withDocumentClient(api, async (client) => {
        result = (await client.callTool({
          name: tool,
          arguments: args,
        })) as CallToolResult;
      });

      assert.ok(result && !result.isError, `${tool} failed`);
      const [text, embedded] = result.content;

      // Legacy clients read only content[].text (issue #134).
      assert.equal(text.type, "text");
      assert.equal(text.text, uri);

      assert.equal(embedded.type, "resource");
      const { resource } = embedded as {
        resource: { uri: string; mimeType: string };
      };
      assert.equal(resource.uri, uri, "both blocks must reference the same URI");
      assert.equal(resource.mimeType, mimeType);
    });
  }
});

describe("bulk_edit_documents set_permissions", () => {
  test("sends set_permissions, owner and merge at the top level of parameters", async () => {
    const { api, calls } = createDocumentApi([]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "bulk_edit_documents",
        arguments: {
          documents: [4103],
          method: "set_permissions",
          set_permissions: {
            view: { users: [], groups: [10] },
            change: { users: [], groups: [10] },
          },
          owner: 3,
          merge: true,
        },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    assert.equal(calls.bulkEditDocuments.length, 1);
    const [documents, method, parameters] = calls.bulkEditDocuments[0];
    assert.deepEqual(documents, [4103]);
    assert.equal(method, "set_permissions");
    // Paperless reads parameters["set_permissions"] directly; nesting it under
    // another key makes the server crash with a KeyError (HTTP 500).
    assert.deepEqual(parameters, {
      set_permissions: {
        view: { users: [], groups: [10] },
        change: { users: [], groups: [10] },
      },
      owner: 3,
      merge: true,
    });
  });

  test("forwards partial permissions without filling in omitted actions or lists", async () => {
    const { api, calls } = createDocumentApi([]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "bulk_edit_documents",
        arguments: {
          documents: [1],
          method: "set_permissions",
          set_permissions: { view: { groups: [10] } },
        },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    // Paperless only touches the actions/lists that are present, and clears
    // the owner when it is omitted without merge — so nothing may be added.
    const [, , parameters] = calls.bulkEditDocuments[0];
    assert.deepEqual(parameters, { set_permissions: { view: { groups: [10] } } });
  });

  test("owner-only changes send an empty set_permissions object", async () => {
    const { api, calls } = createDocumentApi([]);

    await withDocumentClient(api, async (client) => {
      for (const owner of [3, null]) {
        const result = (await client.callTool({
          name: "bulk_edit_documents",
          arguments: { documents: [1], method: "set_permissions", owner },
        })) as CallToolResult;
        assert.ok(!result.isError, parseToolText(result)?.error);
      }
    });

    assert.deepEqual(
      calls.bulkEditDocuments.map(([, , parameters]) => parameters),
      [
        { set_permissions: {}, owner: 3 },
        { set_permissions: {}, owner: null },
      ]
    );
  });

  test("rejects method set_permissions with neither set_permissions nor owner", async () => {
    const { api, calls } = createDocumentApi([]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "bulk_edit_documents",
        arguments: { documents: [1], method: "set_permissions", merge: true },
      })) as CallToolResult;
      assert.ok(result.isError, "expected an error when both are missing");
      assert.match(parseToolText(result)?.error ?? "", /set_permissions and\/or owner/);
    });

    assert.equal(calls.bulkEditDocuments.length, 0);
  });

  test("rejects malformed set_permissions input before calling Paperless", async () => {
    const { api, calls } = createDocumentApi([]);

    await withDocumentClient(api, async (client) => {
      for (const set_permissions of [
        { view: { groups: ["ai-agents"] } },
        { read: { groups: [10] } },
        { view: [10] },
      ]) {
        // Depending on the installed MCP SDK version, an input-schema (zod)
        // violation either rejects with a protocol error (-32602) or resolves
        // with a CallToolResult carrying isError: true.
        let rejected = false;
        let result: CallToolResult | undefined;
        try {
          result = (await client.callTool({
            name: "bulk_edit_documents",
            arguments: { documents: [1], method: "set_permissions", set_permissions },
          })) as CallToolResult;
        } catch {
          rejected = true;
        }
        assert.ok(
          rejected || result?.isError,
          `expected ${JSON.stringify(set_permissions)} to be rejected`
        );
      }
    });

    assert.equal(calls.bulkEditDocuments.length, 0);
  });
});

describe("nullable foreign keys can still be cleared (#138)", () => {
  test("update_document forwards an explicit null so a foreign key can be cleared", async () => {
    const { api, calls } = createDocumentApi([]);

    await withDocumentClient(api, async (client) => {
      const result = (await client.callTool({
        name: "update_document",
        arguments: { id: 42, correspondent: null, owner: null },
      })) as CallToolResult;
      assert.ok(!result.isError, parseToolText(result)?.error);
    });

    assert.equal(calls.updateDocument.length, 1);
    const [, data] = calls.updateDocument[0];
    assert.equal(data.correspondent, null);
    assert.equal(data.owner, null);
  });

});

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const md5 = (data: Buffer | string) =>
  createHash("md5").update(data).digest("hex");

interface UploadedDocument {
  document: Buffer | Readable;
  content?: Buffer;
  filename: string;
  metadata: Record<string, unknown>;
  knownLength?: number;
}

interface ExistingDocument {
  id: number;
  title: string;
  checksum: string;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createUploadApi(
  documents: ExistingDocument[] = [],
  { checksumInList = true, taskId = "task-uuid-1" } = {}
) {
  const calls = {
    getDocuments: [] as string[],
    request: [] as string[],
    postDocument: [] as UploadedDocument[],
  };
  const emptyPage = { count: 0, next: null, previous: null, all: [] };
  const api = {
    getDocuments: async (query: string) => {
      calls.getDocuments.push(query);
      const wanted = getQueryParams(query).get("checksum__iexact");
      if (wanted !== null) {
        const hit = documents.find(
          (doc) => doc.checksum.toLowerCase() === wanted.toLowerCase()
        );
        return {
          ...emptyPage,
          results: hit ? [{ id: hit.id, title: hit.title }] : [],
        };
      }
      const newest = documents[documents.length - 1];
      return {
        ...emptyPage,
        results: newest
          ? [
              checksumInList
                ? { id: newest.id, checksum: newest.checksum }
                : { id: newest.id },
            ]
          : [],
      };
    },
    request: async (path: string) => {
      calls.request.push(path);
      return { original_checksum: documents[documents.length - 1]?.checksum };
    },
    postDocument: async (
      document: Buffer | Readable,
      filename: string,
      metadata: Record<string, unknown>,
      knownLength?: number
    ) => {
      const content = Buffer.isBuffer(document)
        ? undefined
        : await readAll(document);
      calls.postDocument.push({ document, content, filename, metadata, knownLength });
      return taskId;
    },
  } as unknown as PaperlessAPI;
  return { api, calls };
}

describe("duplicate detection", () => {
  let testDir: string;
  const scanContent = Buffer.from("%PDF-1.4\nscan of a manual");
  const otherContent = Buffer.from("%PDF-1.4\nsomething new");
  let scanFile: string;
  let otherFile: string;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), "paperless-mcp-dup-"));
    scanFile = join(testDir, "scan.pdf");
    otherFile = join(testDir, "other.pdf");
    writeFileSync(scanFile, scanContent);
    writeFileSync(otherFile, otherContent);
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  async function checkDuplicates(
    api: PaperlessAPI,
    file_paths: string[],
    register: typeof registerDocumentTools = registerDocumentTools
  ) {
    let result: CallToolResult | undefined;
    await withDocumentClient(
      api,
      async (client) => {
        result = (await client.callTool({
          name: "check_duplicates",
          arguments: { file_paths },
        })) as CallToolResult;
      },
      register
    );
    assert.ok(result && !result.isError, "check_duplicates failed");
    return parseToolText(result);
  }

  test("check_duplicates reports duplicates, new files and per-file errors", async () => {
    const { api, calls } = createUploadApi([
      { id: 11, title: "Old scan", checksum: sha256(scanContent) },
    ]);
    const missing = join(testDir, "missing.pdf");

    const { results } = await checkDuplicates(api, [scanFile, otherFile, missing]);

    assert.deepEqual(results.slice(0, 2), [
      {
        file_path: scanFile,
        checksum: sha256(scanContent),
        duplicate: true,
        document: { id: 11, title: "Old scan" },
      },
      {
        file_path: otherFile,
        checksum: sha256(otherContent),
        duplicate: false,
        document: null,
      },
    ]);
    assert.equal(results[2].file_path, missing);
    assert.match(results[2].error, /^File not found: /);
    assert.equal(
      calls.getDocuments.filter((q) => !q.includes("checksum__iexact")).length,
      1,
      "the checksum algorithm must be detected once per call"
    );
    assert.deepEqual(
      calls.getDocuments.filter((q) => q.includes("checksum__iexact")).map((q) => {
        const params = getQueryParams(q);
        return [params.get("checksum__iexact"), params.get("page_size")];
      }),
      [
        [sha256(scanContent), "1"],
        [sha256(otherContent), "1"],
      ]
    );
  });

  test("check_duplicates uses MD5 when the instance still stores 32-character checksums", async () => {
    const { api } = createUploadApi([
      { id: 3, title: "Legacy", checksum: md5(scanContent) },
    ]);

    const { results } = await checkDuplicates(api, [scanFile]);

    assert.deepEqual(results, [
      {
        file_path: scanFile,
        checksum: md5(scanContent),
        duplicate: true,
        document: { id: 3, title: "Legacy" },
      },
    ]);
  });

  test("falls back to the metadata endpoint when the list has no checksum field", async () => {
    const { api, calls } = createUploadApi(
      [{ id: 9, title: "Legacy", checksum: md5(scanContent) }],
      { checksumInList: false }
    );

    const { results } = await checkDuplicates(api, [scanFile]);

    assert.deepEqual(calls.request, ["/documents/9/metadata/"]);
    assert.equal(results[0].checksum, md5(scanContent));
    assert.equal(results[0].duplicate, true);
  });

  test("uses SHA-256 and finds nothing when the instance has no document", async () => {
    const { api } = createUploadApi([]);

    const { results } = await checkDuplicates(api, [scanFile]);

    assert.deepEqual(results, [
      {
        file_path: scanFile,
        checksum: sha256(scanContent),
        duplicate: false,
        document: null,
      },
    ]);
  });

  test("check_duplicates reports files outside the allowed upload directories per entry", async () => {
    const allowedDir = join(testDir, "allowed");
    mkdirSync(allowedDir);
    const allowedFile = join(allowedDir, "in.pdf");
    writeFileSync(allowedFile, scanContent);
    const { registerDocumentTools: registerWithAllowlist } =
      loadDocumentsWithAllowlist(realpathSync(allowedDir));
    const { api } = createUploadApi([]);

    const { results } = await checkDuplicates(
      api,
      [allowedFile, otherFile],
      registerWithAllowlist
    );

    assert.equal(results[0].checksum, sha256(scanContent));
    assert.deepEqual(results[1], {
      file_path: otherFile,
      error: results[1].error,
    });
    assert.match(results[1].error, /outside allowed upload directories/);
  });

  test("check_duplicates rejects empty lists and relative paths in the schema", async () => {
    const { api, calls } = createUploadApi([]);

    await withDocumentClient(api, async (client) => {
      for (const file_paths of [[], ["relative/scan.pdf"]]) {
        let rejected = false;
        let result: CallToolResult | undefined;
        try {
          result = (await client.callTool({
            name: "check_duplicates",
            arguments: { file_paths },
          })) as CallToolResult;
        } catch {
          rejected = true;
        }
        assert.ok(
          rejected || result?.isError,
          `expected ${JSON.stringify(file_paths)} to be rejected`
        );
      }
    });

    assert.equal(calls.getDocuments.length, 0);
  });

  async function postDocument(api: PaperlessAPI, args: Record<string, unknown>) {
    let result: CallToolResult | undefined;
    await withDocumentClient(api, async (client) => {
      result = (await client.callTool({
        name: "post_document",
        arguments: args,
      })) as CallToolResult;
    });
    assert.ok(result && !result.isError, "post_document failed");
    return parseToolText(result);
  }

  test("post_document skip_if_duplicate returns the existing document without uploading (file_path)", async () => {
    const { api, calls } = createUploadApi([
      { id: 11, title: "Old scan", checksum: sha256(scanContent) },
    ]);

    const result = await postDocument(api, {
      file_path: scanFile,
      title: "Again",
      skip_if_duplicate: true,
    });

    assert.deepEqual(result, {
      duplicate: true,
      document: { id: 11, title: "Old scan" },
    });
    assert.equal(calls.postDocument.length, 0);
  });

  test("post_document skip_if_duplicate hashes the decoded content (file)", async () => {
    const { api, calls } = createUploadApi([
      { id: 12, title: "Old scan", checksum: sha256(scanContent) },
    ]);

    const result = await postDocument(api, {
      file: scanContent.toString("base64"),
      filename: "scan.pdf",
      skip_if_duplicate: true,
    });

    assert.deepEqual(result, {
      duplicate: true,
      document: { id: 12, title: "Old scan" },
    });
    assert.equal(calls.postDocument.length, 0);
  });

  test("post_document skip_if_duplicate uploads new content without leaking the flag into the metadata", async () => {
    const { api, calls } = createUploadApi([
      { id: 11, title: "Old scan", checksum: sha256(scanContent) },
    ]);

    const result = await postDocument(api, {
      file_path: otherFile,
      title: "Fresh",
      tags: [2],
      skip_if_duplicate: true,
    });

    assert.deepEqual(result, { status: "task-uuid-1" });
    assert.equal(calls.postDocument.length, 1);
    assert.deepEqual(calls.postDocument[0].metadata, { title: "Fresh", tags: [2] });
  });

  test("post_document does not look anything up unless skip_if_duplicate is set", async () => {
    const { api, calls } = createUploadApi([
      { id: 11, title: "Old scan", checksum: sha256(scanContent) },
    ]);

    await postDocument(api, { file_path: scanFile, title: "Again" });
    await postDocument(api, { file_path: scanFile, skip_if_duplicate: false });

    assert.equal(calls.getDocuments.length, 0);
    assert.equal(calls.postDocument.length, 2);
  });

  test("post_document streams file_path uploads with their known length", async () => {
    const { api, calls } = createUploadApi();

    const result = await postDocument(api, { file_path: scanFile, title: "Scan" });

    assert.deepEqual(result, { status: "task-uuid-1" });
    const [upload] = calls.postDocument;
    assert.ok(!Buffer.isBuffer(upload.document), "file_path uploads must be streamed");
    assert.deepEqual(upload.content, scanContent);
    assert.equal(upload.knownLength, scanContent.length);
    assert.equal(upload.filename, basename(scanFile));
    assert.deepEqual(upload.metadata, { title: "Scan" });
  });

  test("post_document sends base64 uploads as a buffer", async () => {
    const { api, calls } = createUploadApi();

    await postDocument(api, {
      file: scanContent.toString("base64"),
      filename: "scan.pdf",
    });

    const [upload] = calls.postDocument;
    assert.ok(Buffer.isBuffer(upload.document));
    assert.deepEqual(upload.document, scanContent);
    assert.equal(upload.knownLength, undefined);
  });

  test("post_document still reports a numeric task result as an id", async () => {
    const { api } = createUploadApi([], { taskId: "42" });

    assert.deepEqual(await postDocument(api, { file_path: scanFile }), { id: 42 });
  });

  test("post_document applies PAPERLESS_MCP_MAX_UPLOAD_MB to base64 content", async () => {
    const { api, calls } = createUploadApi();
    const big = Buffer.alloc(2 * 1024 * 1024, 1);

    await withEnv("PAPERLESS_MCP_MAX_UPLOAD_MB", "1", async () => {
      await withDocumentClient(api, async (client) => {
        const result = (await client.callTool({
          name: "post_document",
          arguments: { file: big.toString("base64"), filename: "big.pdf" },
        })) as CallToolResult;
        assert.ok(result.isError);
        assert.match(
          parseToolText(result).error,
          /File size \(2MB\) exceeds maximum allowed size \(1MB\).*PAPERLESS_MCP_MAX_UPLOAD_MB/
        );
      });
    });

    assert.equal(calls.postDocument.length, 0);
  });
});

interface ReceivedUpload {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

async function withUploadServer(
  respond: (
    req: IncomingMessage,
    res: ServerResponse,
    received: Promise<ReceivedUpload>
  ) => void,
  run: (baseUrl: string) => Promise<void>
) {
  const server = createServer((req, res) => {
    const received = new Promise<ReceivedUpload>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () =>
        resolve({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      );
      req.on("error", reject);
    });
    respond(req, res, received);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("post_document file_path streaming over HTTP", () => {
  let testDir: string;
  let bigFile: string;
  let content: Buffer;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), "paperless-mcp-stream-"));
    bigFile = join(testDir, "manual.pdf");
    content = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(6 * 1024 * 1024)]);
    writeFileSync(bigFile, content);
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function callPostDocument(baseUrl: string) {
    return withDocumentResult(
      new PaperlessAPI(baseUrl, "test-token"),
      { file_path: bigFile, title: "Manual" }
    );
  }

  async function withDocumentResult(api: PaperlessAPI, args: Record<string, unknown>) {
    let result: CallToolResult | undefined;
    await withDocumentClient(api, async (client) => {
      result = (await client.callTool({
        name: "post_document",
        arguments: args,
      })) as CallToolResult;
    });
    assert.ok(result);
    return result;
  }

  test("sends every byte with a Content-Length instead of chunked encoding", async () => {
    let upload: ReceivedUpload | undefined;
    await withUploadServer(
      (req, res, received) => {
        received.then((value) => {
          upload = value;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify("7b6a3c1e-task"));
        });
      },
      async (baseUrl) => {
        const result = await callPostDocument(baseUrl);
        assert.ok(!result.isError, JSON.stringify(result.content));
        assert.deepEqual(parseToolText(result), { status: "7b6a3c1e-task" });
      }
    );

    assert.ok(upload);
    assert.equal(upload.url, "/api/documents/post_document/");
    assert.equal(upload.headers["transfer-encoding"], undefined);
    assert.equal(Number(upload.headers["content-length"]), upload.body.length);
    assert.ok(
      upload.body.length > content.length &&
        upload.body.length < content.length + 2048,
      "the body is the file plus multipart framing"
    );
    assert.ok(upload.body.includes(content), "the file must arrive unchanged");
  });

  for (const [name, answerAfterBody] of [
    ["after reading the body", true],
    ["before reading the body", false],
  ] as const) {
    test(`reports a redirect answered ${name} as an error pointing at PAPERLESS_URL`, async () => {
      const redirects: string[] = [];
      await withUploadServer(
        (req, res, received) => {
          const redirect = () => {
            redirects.push(req.url ?? "");
            res.writeHead(301, {
              Location: "https://paperless.example.test/api/documents/post_document/",
            });
            res.end();
          };
          if (answerAfterBody) {
            received.then(redirect);
          } else {
            redirect();
          }
        },
        async (baseUrl) => {
          const result = await callPostDocument(baseUrl);
          assert.ok(result.isError, "a redirected upload must fail");
          const { error } = parseToolText(result);
          assert.match(error, /HTTP 301/);
          assert.match(error, /redirected the upload to https:\/\/paperless\.example\.test/);
          assert.match(error, /PAPERLESS_URL/);
        }
      );

      assert.deepEqual(redirects, ["/api/documents/post_document/"]);
    });
  }
});
