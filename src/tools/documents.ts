import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { access, stat } from "fs/promises";
import { constants, createReadStream } from "fs";
import { basename, isAbsolute } from "path";
import { convertDocsWithNames } from "../api/documentEnhancer";
import { PaperlessAPI } from "../api/PaperlessAPI";
import {
  bufferChecksum,
  detectChecksumAlgorithm,
  DuplicateDocument,
  fileChecksum,
  findDocumentByChecksum,
} from "./utils/duplicates";
import { arrayNotEmpty } from "./utils/empty";
import {
  BuildDocumentQueryArgs,
  buildDocumentQueryString,
  LIST_DOCUMENTS_ARGS_SHAPE,
  QUERY_DOCUMENTS_ARGS_SHAPE,
  SEARCH_DOCUMENTS_ARGS_SHAPE,
} from "./utils/documentQuery";
import {
  assertAbsolutePath,
  assertWithinUploadLimit,
  isPathAllowed,
  parseUploadPaths,
  resolveAllowedDirs,
  resolveExistingPath,
} from "./utils/filePath";
import { withErrorHandling } from "./utils/middlewares";
import { validateCustomFields } from "./utils/monetary";
import { resolveSelectCustomFieldValues } from "./utils/selectFields";
import { CUSTOM_FIELD_VALUE_DESCRIPTION } from "./utils/descriptions";
import {
  buildDocumentResourceUri,
  buildThumbnailResourceUri,
} from "./utils/resourceUri";

export type BulkCustomFieldValue = string | number | boolean | number[] | null;

export type BulkCustomFieldUpdate = {
  field: number;
  value: BulkCustomFieldValue;
};

export type BulkCustomFieldParameters = {
  add_custom_fields?: Record<string, BulkCustomFieldValue>;
  remove_custom_fields?: number[];
};

const ALLOWED_UPLOAD_PATHS = parseUploadPaths(
  process.env.PAPERLESS_MCP_UPLOAD_PATHS
);

/**
 * Validates that a file path is safe to read for document upload.
 * @returns The resolved real path of the file, which callers must read.
 */
export async function validateFilePath(filePath: string): Promise<string> {
  assertAbsolutePath(filePath);

  const realPath = await resolveExistingPath(filePath);

  if (ALLOWED_UPLOAD_PATHS.length > 0) {
    const allowedDirs = await resolveAllowedDirs(ALLOWED_UPLOAD_PATHS);
    if (!isPathAllowed(realPath, allowedDirs)) {
      throw new Error(
        "file_path is outside allowed upload directories. " +
        "Configure PAPERLESS_MCP_UPLOAD_PATHS environment variable to specify allowed paths."
      );
    }
  }

  const stats = await stat(realPath);

  if (!stats.isFile()) {
    throw new Error("Path must point to a regular file");
  }

  assertWithinUploadLimit(stats.size);

  if (stats.size === 0) {
    throw new Error("File is empty");
  }

  return realPath;
}

/**
 * Builds Paperless-NGX bulk edit parameters from base parameters plus optional
 * custom field updates.
 *
 * Paperless-NGX expects custom field bulk updates as an `add_custom_fields`
 * record keyed by custom field id. `addCustomFields` is accepted as an array for
 * the MCP tool schema and transformed into that id-to-value record while
 * preserving supported value types, including `number[]` document links and
 * `null` resets. Passing an empty `addCustomFields` array intentionally produces
 * an empty `add_custom_fields` record.
 *
 * When `includeCustomFieldDefaults` is true, the function also initializes
 * `add_custom_fields` and `remove_custom_fields` with empty defaults using
 * nullish coalescing (`??=`). This keeps the `modify_custom_fields` method's
 * payload shape acceptable to Paperless even when no field values are supplied.
 *
 * @param parameters - Base bulk edit parameters to include in the result.
 * @param addCustomFields - Optional custom field updates to map by field id.
 * @param includeCustomFieldDefaults - Whether to include empty custom field
 * defaults required by `modify_custom_fields`.
 * @returns The merged API parameters with custom field updates transformed into
 * Paperless-NGX's `add_custom_fields` record shape.
 */
export function buildBulkEditParameters<T extends Record<string, unknown>>(
  parameters: T,
  addCustomFields?: BulkCustomFieldUpdate[],
  includeCustomFieldDefaults = false,
  includeTagDefaults = false
): T & BulkCustomFieldParameters {
  const apiParameters: T & BulkCustomFieldParameters = {
    ...parameters,
  };

  if (addCustomFields) {
    apiParameters.add_custom_fields = Object.fromEntries(
      addCustomFields.map((customField) => [
        String(customField.field),
        customField.value,
      ])
    );
  }

  if (includeCustomFieldDefaults) {
    apiParameters.add_custom_fields ??= {};
    apiParameters.remove_custom_fields ??= [];
  }

  if (includeTagDefaults) {
    (apiParameters as Record<string, unknown>).add_tags ??= [];
    (apiParameters as Record<string, unknown>).remove_tags ??= [];
  }

  return apiParameters;
}

type UploadSource =
  | { kind: "buffer"; data: Buffer }
  | { kind: "file"; path: string; size: number };

type DuplicateCheckResult =
  | {
      file_path: string;
      checksum: string;
      duplicate: boolean;
      document: DuplicateDocument | null;
    }
  | { file_path: string; error: string };

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function executeDocumentQuery(
  api: PaperlessAPI,
  args: BuildDocumentQueryArgs
) {
  const docsResponse = await api.getDocuments(buildDocumentQueryString(args));
  return convertDocsWithNames(docsResponse, api);
}

export function registerDocumentTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "bulk_edit_documents",
    "Perform bulk operations on multiple documents. Note: 'remove_tag' removes a tag from specific documents (tag remains in system), while 'delete_tag' permanently deletes a tag from the entire system. ⚠️ WARNING: 'delete' method permanently deletes documents and requires confirmation.",
    {
      documents: z.array(z.number()),
      method: z.enum([
        "set_correspondent",
        "set_document_type",
        "set_storage_path",
        "add_tag",
        "remove_tag",
        "modify_tags",
        "modify_custom_fields",
        "delete",
        "reprocess",
        "set_permissions",
        "merge",
        "split",
        "rotate",
        "delete_pages",
      ]),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      storage_path: z.number().optional(),
      tag: z.number().optional(),
      add_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      remove_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      add_custom_fields: z
        .array(
          z.object({
            field: z.number(),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.number()),
              z.null(),
            ]).describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .transform(arrayNotEmpty),
      remove_custom_fields: z
        .array(z.number())
        .optional()
        .transform(arrayNotEmpty),
      set_permissions: z
        .object({
          view: z
            .object({
              users: z.array(z.number()).optional(),
              groups: z.array(z.number()).optional(),
            })
            .strict()
            .optional(),
          change: z
            .object({
              users: z.array(z.number()).optional(),
              groups: z.array(z.number()).optional(),
            })
            .strict()
            .optional(),
        })
        // strict: a misspelled action ("read") must not silently collapse
        // into {} and clear permissions/ownership.
        .strict()
        .optional()
        .describe(
          "For set_permissions: view/change permissions to apply. Omitted actions (view/change) and omitted users/groups lists are left untouched; an empty list [] removes all (unless merge is true). Omit entirely for owner-only changes."
        ),
      owner: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "For set_permissions: new owner user ID, or null to remove the owner. Unless merge is true, omitting owner also clears the current owner."
        ),
      merge: z
        .boolean()
        .optional()
        .describe(
          "For set_permissions: true adds to existing permissions and keeps the current owner; false (default) replaces the listed users/groups"
        ),
      metadata_document_id: z.number().optional(),
      delete_originals: z.boolean().optional(),
      pages: z.string().optional(),
      degrees: z.number().optional(),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Must be true when method is 'delete' to confirm destructive operation"
        ),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      if (args.method === "delete" && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      if (
        args.method === "set_permissions" &&
        !args.set_permissions &&
        args.owner === undefined
      ) {
        throw new Error(
          "Method 'set_permissions' requires set_permissions and/or owner."
        );
      }
      const { documents, method, add_custom_fields, confirm, ...parameters } = args;
      if (method === "set_permissions") {
        // Paperless rejects (Paperless <= 3.0.5: crashes with a 500 on) a missing
        // set_permissions key even for owner-only changes.
        parameters.set_permissions ??= {};
      }

      validateCustomFields(add_custom_fields);
      const resolvedCustomFields = await resolveSelectCustomFieldValues(
        api,
        add_custom_fields,
        "stored"
      );

      const response = await api.bulkEditDocuments(
        documents,
        method,
        method === "delete"
          ? {}
          : buildBulkEditParameters(
              parameters,
              resolvedCustomFields,
              method === "modify_custom_fields",
              method === "modify_tags"
            )
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: response.result || response }),
          },
        ],
      };
    })
  );

  const postDocumentBaseSchema = z.object({
    file: z.string().optional().describe("Base64-encoded file content. Either 'file' or 'file_path' must be provided. The whole file is held in memory: use 'file_path' for large files."),
    file_path: z.string().optional().describe("Absolute path to a file on the server's filesystem. Either 'file' or 'file_path' must be provided. The filename is derived from the path unless 'filename' is also specified. For security, configure PAPERLESS_MCP_UPLOAD_PATHS to restrict allowed directories."),
    filename: z.string().optional().describe("Filename for the uploaded document. Required when using 'file', optional when using 'file_path' (defaults to the basename of the path)."),
    title: z.string().optional(),
    created: z.string().optional(),
    correspondent: z.number().optional(),
    document_type: z.number().optional(),
    storage_path: z.number().optional(),
    tags: z.array(z.number()).optional(),
    archive_serial_number: z.number().optional(),
    custom_fields: z.array(z.number()).optional(),
    skip_if_duplicate: z
      .boolean()
      .optional()
      .describe(
        "When true, look the file's checksum up first and, if a document with the same checksum already exists, return { duplicate: true, document: { id, title } } without uploading. Default false. Paperless also rejects a file whose checksum equals an existing document's archive file checksum, which this lookup cannot find."
      ),
  });

  const postDocumentSchema = postDocumentBaseSchema.superRefine((data, ctx) => {
    const hasFile = data.file !== undefined;
    const hasFilePath = data.file_path !== undefined;

    if (!hasFile && !hasFilePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'file' (base64) or 'file_path' must be provided.",
        path: ["file"],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'file' (base64) or 'file_path' must be provided.",
        path: ["file_path"],
      });
    }

    if (hasFile && hasFilePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only one of 'file' or 'file_path' should be provided, not both.",
        path: ["file"],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only one of 'file' or 'file_path' should be provided, not both.",
        path: ["file_path"],
      });
    }

    if (hasFile && !data.filename) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'filename' is required when using 'file' (base64 mode).",
        path: ["filename"],
      });
    }

    if (hasFilePath && data.file_path && !isAbsolute(data.file_path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "file_path must be an absolute path",
        path: ["file_path"],
      });
    }
  });

  server.tool(
    "post_document",
    "Upload a new document to Paperless-NGX with optional metadata like title, correspondent, document type, tags, and custom fields. Provide either 'file' (base64-encoded content) or 'file_path' (absolute path to a file on the server's filesystem). Using file_path avoids base64 encoding overhead for large files: it is streamed to Paperless-NGX instead of being loaded in memory, whereas 'file' is held in memory. The maximum file size is 100MB unless PAPERLESS_MCP_MAX_UPLOAD_MB is set (0 = unlimited). Paperless-NGX imports the document asynchronously: the returned value is not a document id, 'status' is the import task UUID. Follow it with 'get_task' or 'wait_for_tasks' to get the outcome. Pass skip_if_duplicate: true to skip the upload when a document with the same checksum already exists, or use 'check_duplicates' to check files beforehand. SECURITY: When using file_path, set PAPERLESS_MCP_UPLOAD_PATHS environment variable to restrict uploads to specific directories (separated by ':' on Linux/macOS, ';' on Windows).",
    postDocumentBaseSchema.shape,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");

      const validationResult = postDocumentSchema.safeParse(args);
      if (!validationResult.success) {
        throw new Error(validationResult.error.issues.map(e => e.message).join("; "));
      }

      let source: UploadSource;
      let filename: string;

      if (args.file_path) {
        const realPath = await validateFilePath(args.file_path);

        try {
          await access(realPath, constants.R_OK);
        } catch {
          throw new Error("Failed to read file");
        }

        filename = args.filename || basename(args.file_path);
        if (!filename) {
          throw new Error("Could not derive filename from file_path");
        }
        source = { kind: "file", path: realPath, size: (await stat(realPath)).size };
      } else if (args.file) {
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        if (!base64Regex.test(args.file)) {
          throw new Error(
            "Invalid base64-encoded file data. Please provide a valid base64 string."
          );
        }

        const data = Buffer.from(args.file, "base64");

        assertWithinUploadLimit(data.length);
        if (data.length === 0) {
          throw new Error("File is empty");
        }

        filename = args.filename!;
        source = { kind: "buffer", data };
      } else {
        // This should never happen due to schema validation, but TypeScript needs it
        throw new Error("Either 'file' (base64) or 'file_path' must be provided.");
      }

      if (args.skip_if_duplicate) {
        const algorithm = await detectChecksumAlgorithm(api);
        const checksum =
          source.kind === "file"
            ? await fileChecksum(source.path, algorithm)
            : bufferChecksum(source.data, algorithm);
        const duplicate = await findDocumentByChecksum(api, checksum);
        if (duplicate) {
          return jsonResult({ duplicate: true, document: duplicate });
        }
      }

      const { file, file_path, filename: _fn, skip_if_duplicate, ...metadata } = args;

      const response =
        source.kind === "file"
          ? await api.postDocument(
              createReadStream(source.path),
              filename,
              metadata,
              source.size
            )
          : await api.postDocument(source.data, filename, metadata);
      let result;
      if (typeof response === "string" && /^\d+$/.test(response)) {
        result = { id: Number(response) };
      } else {
        result = { status: response };
      }
      return jsonResult(result);
    })
  );

  server.tool(
    "check_duplicates",
    "Check whether files on the server's filesystem already exist in Paperless-NGX before uploading them. Read-only: nothing is uploaded or modified. Each file is hashed (SHA-256, or MD5 on older Paperless-NGX instances; detected automatically) and looked up by checksum, which matches the original file of a document. Only documents visible to the API token are found. Paperless-NGX also rejects a file whose checksum equals an existing document's archive (processed) file checksum, which this lookup cannot find. Paths follow the same rules as post_document's file_path (absolute, PAPERLESS_MCP_UPLOAD_PATHS allowlist). One unreadable or disallowed file does not fail the batch: its entry carries an 'error' instead. Returns { results: [{ file_path, checksum, duplicate, document: { id, title } | null } | { file_path, error }] }.",
    {
      file_paths: z
        .array(
          z
            .string()
            .refine((filePath) => isAbsolute(filePath), {
              message: "file_paths entries must be absolute paths",
            })
        )
        .min(1)
        .describe("Absolute paths of the files to check."),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");

      const algorithm = await detectChecksumAlgorithm(api);
      const results: DuplicateCheckResult[] = [];
      for (const file_path of args.file_paths) {
        try {
          const realPath = await validateFilePath(file_path);
          const checksum = await fileChecksum(realPath, algorithm);
          const document = await findDocumentByChecksum(api, checksum);
          results.push({ file_path, checksum, duplicate: document !== null, document });
        } catch (err) {
          results.push({
            file_path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return jsonResult({ results });
    })
  );

  server.tool(
    "list_documents",
    "List and filter documents with pagination and common Paperless filters such as title search, correspondent, document type, tag, storage path, creation date, archive serial number, and simple custom field filters. Use 'query_documents' for full-text query, structured custom field conditions, or advanced documented /api/documents/ query parameters. IMPORTANT: For queries like 'the last 3 contributions' or when searching by tag, correspondent, document type, or storage path, first use the relevant lookup tool to find the correct ID. Note: Document content is excluded from results by default. Use 'get_document_content' when you need the document text. Pass 'fields' to return only the fields you need and keep results small.",
    LIST_DOCUMENTS_ARGS_SHAPE,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return executeDocumentQuery(api, args);
    })
  );

  server.tool(
    "query_documents",
    "Query documents using the full-text query engine plus structured Paperless filters. Use this for complex filtering, custom field conditions, or any documented /api/documents/ query parameters that are not exposed as first-class arguments. Prefer the dedicated top-level arguments where available. paperless_filters accepts only the keys documented by /api/documents/ (Paperless-NGX silently ignores unknown filters and would return every document), so id__gt/id__lt do not exist: use ordering '-id' with page_size, added__date__gt/added__date__gte, or id__in. custom_field_query supports [field_name_or_id, operator, value] leaves or ['AND'|'OR', [clause1, clause2]] groups. Note: Document content is excluded from results by default. Use 'get_document_content' when you need the document text. Pass 'fields' to return only the fields you need and keep results small.",
    QUERY_DOCUMENTS_ARGS_SHAPE,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return executeDocumentQuery(api, args);
    })
  );

  server.tool(
    "get_document",
    "Get a specific document by ID with full details including correspondent, document type, tags, and custom fields. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    {
      id: z.number(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      return convertDocsWithNames(doc, api);
    })
  );

  server.tool(
    "get_document_content",
    "Get the text content of a specific document by ID. Use this when you need to read or analyze the actual document text. For long documents, always pass max_length (e.g. 20000) and follow next_offset until it is null. With offset or max_length, the response also includes total_length and next_offset (the offset for the next call, or null at the end of the text).",
    {
      id: z.number(),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character position to start reading from (default 0)"),
      max_length: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of characters to return"),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const doc = await api.getDocument(args.id);
      if (args.offset !== undefined || args.max_length !== undefined) {
        const text = doc.content ?? "";
        const offset = args.offset ?? 0;
        const end = Math.min(offset + (args.max_length ?? text.length), text.length);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: doc.id,
                title: doc.title,
                content: text.slice(offset, end),
                total_length: text.length,
                next_offset: end < text.length ? end : null,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              content: doc.content,
            }),
          },
        ],
      };
    })
  );

  server.tool(
    "search_documents",
    "Deprecated compatibility wrapper for full-text document search. Use 'query_documents' with the 'query' argument for new integrations. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed.",
    SEARCH_DOCUMENTS_ARGS_SHAPE,
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      return executeDocumentQuery(api, args);
    })
  );

  server.tool(
    "download_document",
    "Download a document file by ID. Returns a paperless:// resource URI; read the resource to fetch the file content.",
    {
      id: z.number().int().positive(),
      original: z.boolean().optional(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const uri = buildDocumentResourceUri(args.id, {
        original: args.original,
      });
      return {
        content: [
          // Legacy clients surface only content[].text and drop resource blocks
          // entirely, so the URI is repeated here to stay reachable (issue #134).
          { type: "text", text: uri },
          {
            type: "resource",
            resource: {
              uri,
              // MCP SDK 1.11 embedded resources require text or blob. Keep the
              // existing resource-shaped tool result while making resources/read
              // the canonical place for the large binary payload.
              text: "",
              mimeType: "application/octet-stream",
            },
          },
        ],
      };
    })
  );

  server.tool(
    "get_document_thumbnail",
    "Get a document thumbnail (image preview) by ID. Returns a paperless:// resource URI; read the resource to fetch the image content.",
    {
      id: z.number().int().positive(),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const uri = buildThumbnailResourceUri(args.id);
      return {
        content: [
          // See download_document above: the URI is repeated as text for legacy
          // clients that drop resource blocks.
          { type: "text", text: uri },
          {
            type: "resource",
            resource: {
              uri,
              // See download_document above: the binary thumbnail is fetched
              // lazily through resources/read instead of embedded here.
              text: "",
              mimeType: "image/webp",
            },
          },
        ],
      };
    })
  );

  server.tool(
    "update_document",
    "Update a specific document with new values (title, correspondent, document type, storage path, tags, custom fields, and more). Top-level fields you omit are left unchanged. IMPORTANT: custom_fields is the exception — see its parameter description; it replaces the document's entire custom-field set.",
    {
      id: z.number().describe("The ID of the document to update"),
      title: z
        .string()
        .max(128)
        .optional()
        .describe("The new title for the document (max 128 characters)"),
      correspondent: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the correspondent to assign"),
      document_type: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the document type to assign"),
      storage_path: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the storage path to assign"),
      tags: z
        .array(z.number())
        .optional()
        .describe("Array of tag IDs to assign to the document"),
      content: z
        .string()
        .optional()
        .describe("The raw text content of the document (used for searching)"),
      created: z
        .string()
        .optional()
        .describe("The creation date in YYYY-MM-DD format"),
      archive_serial_number: z
        .number()
        .optional()
        .describe("The archive serial number (0-4294967295)"),
      owner: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the user who owns the document"),
      custom_fields: z
        .array(
          z.object({
            field: z.number().describe("The custom field ID"),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.number()),
                z.null(),
              ])
              .describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .describe(
          "Custom field values for the document. ⚠️ REPLACES the document's entire custom-field set — any field not included here will be CLEARED. To update or add a single field without losing the others, first call get_document to read the existing custom_fields, then pass the full merged array. To add/set fields additively without fetching, use bulk_edit_documents with method 'modify_custom_fields' instead."
        ),
    },
    withErrorHandling(async (args, extra) => {
      if (!api) throw new Error("Please configure API connection first");
      const { id, ...updateData } = args;

      validateCustomFields(updateData.custom_fields);
      updateData.custom_fields = await resolveSelectCustomFieldValues(
        api,
        updateData.custom_fields,
        "stored"
      );

      const response = await api.updateDocument(id, updateData);

      return convertDocsWithNames(response, api);
    })
  );
}
