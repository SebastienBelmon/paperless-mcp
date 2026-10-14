import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

const idList = z.array(z.number().int()).optional();
const nullableId = z.number().int().nullable().optional();

const triggerSchema = z.object({
  id: z
    .number()
    .int()
    .optional()
    .describe("ID of an existing trigger to keep; omit for a new trigger"),
  type: z
    .literal([1, 2, 3, 4])
    .describe(
      "Trigger type: 1=Consumption Started, 2=Document Added, 3=Document Updated, 4=Scheduled"
    ),
  sources: z
    .array(z.literal([1, 2, 3, 4]))
    .optional()
    .describe(
      "Document sources: 1=Consume Folder, 2=Api Upload, 3=Mail Fetch, 4=Web UI. Paperless defaults to [1, 2, 3]"
    ),
  filter_path: z.string().max(256).nullable().optional(),
  filter_filename: z.string().max(256).nullable().optional(),
  filter_mailrule: nullableId,
  matching_algorithm: z
    .literal([0, 1, 2, 3, 4, 5])
    .optional()
    .describe(
      "Matching algorithm for `match`: 0=None, 1=Any word, 2=All words, 3=Exact match, 4=Regular expression, 5=Fuzzy word"
    ),
  match: z.string().max(256).optional(),
  is_insensitive: z.boolean().optional(),
  filter_has_tags: idList,
  filter_has_all_tags: idList,
  filter_has_not_tags: idList,
  filter_has_not_correspondents: idList,
  filter_has_not_document_types: idList,
  filter_has_not_storage_paths: idList,
  filter_custom_field_query: z
    .string()
    .nullable()
    .optional()
    .describe("JSON-encoded custom field query expression"),
  filter_has_correspondent: nullableId,
  filter_has_document_type: nullableId,
  filter_has_storage_path: nullableId,
  schedule_offset_days: z.number().int().optional(),
  schedule_is_recurring: z.boolean().optional(),
  schedule_recurring_interval_days: z.number().int().min(1).optional(),
  schedule_date_field: z
    .enum(["added", "created", "modified", "custom_field"])
    .optional(),
  schedule_date_custom_field: nullableId,
});

const emailSchema = z.object({
  id: z.number().int().optional(),
  subject: z.string().min(1).max(256),
  body: z.string().min(1),
  to: z.string().min(1).describe("Destination addresses, comma separated"),
  include_document: z.boolean().optional(),
});

const webhookSchema = z.object({
  id: z.number().int().optional(),
  url: z.string().min(1).max(256),
  use_params: z.boolean().optional(),
  as_json: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).nullable().optional(),
  body: z.string().nullable().optional(),
  headers: z.record(z.string(), z.unknown()).nullable().optional(),
  include_document: z.boolean().optional(),
});

const actionSchema = z.object({
  id: z
    .number()
    .int()
    .optional()
    .describe("ID of an existing action to keep; omit for a new action"),
  type: z
    .literal([1, 2, 3, 4])
    .optional()
    .describe(
      "Action type: 1=Assignment (assign_* fields), 2=Removal (remove_* fields), 3=Email (email), 4=Webhook (webhook)"
    ),
  assign_title: z
    .string()
    .nullable()
    .optional()
    .describe("Document title, a Jinja2 template"),
  assign_tags: idList,
  assign_correspondent: nullableId,
  assign_document_type: nullableId,
  assign_storage_path: nullableId,
  assign_owner: nullableId.describe("User ID that becomes the document owner"),
  assign_view_users: idList.describe("User IDs granted view permission"),
  assign_view_groups: idList.describe("Group IDs granted view permission"),
  assign_change_users: idList.describe("User IDs granted change permission"),
  assign_change_groups: idList.describe("Group IDs granted change permission"),
  assign_custom_fields: idList,
  assign_custom_fields_values: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("Custom field ID to value, for fields in assign_custom_fields"),
  remove_all_tags: z.boolean().optional(),
  remove_all_correspondents: z.boolean().optional(),
  remove_all_document_types: z.boolean().optional(),
  remove_all_storage_paths: z.boolean().optional(),
  remove_all_custom_fields: z.boolean().optional(),
  remove_all_owners: z.boolean().optional(),
  remove_all_permissions: z.boolean().optional(),
  remove_tags: idList,
  remove_correspondents: idList,
  remove_document_types: idList,
  remove_storage_paths: idList,
  remove_custom_fields: idList,
  remove_owners: idList,
  remove_view_users: idList,
  remove_view_groups: idList,
  remove_change_users: idList,
  remove_change_groups: idList,
  email: emailSchema.nullable().optional(),
  webhook: webhookSchema.nullable().optional(),
});

const workflowFields = {
  name: z.string().min(1).max(256).optional(),
  order: z.number().int().optional(),
  enabled: z.boolean().optional(),
  triggers: z.array(triggerSchema).optional(),
  actions: z.array(actionSchema).optional(),
} as const;

export function registerWorkflowTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "list_workflows",
    "List Paperless workflows with their triggers and actions, with optional pagination.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
    },
    withErrorHandling(async (args) => {
      const response = await api.getWorkflows(buildQueryString(args));
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.tool(
    "get_workflow",
    "Get one Paperless workflow by ID, with its triggers and actions.",
    { id: z.number().int() },
    withErrorHandling(async (args) => {
      const response = await api.getWorkflow(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.tool(
    "create_workflow",
    "Create a Paperless workflow: when a trigger matches a document, its actions run. " +
      "Example that sets the owner and grants view/change permissions on every document that is added: " +
      'triggers=[{"type":2,"sources":[1,2,3,4]}], ' +
      'actions=[{"type":1,"assign_owner":3,"assign_view_users":[4,5],"assign_change_users":[4]}]. ' +
      "There is no tool to delete a workflow: to switch one off, call update_workflow with enabled=false.",
    {
      ...workflowFields,
      name: z.string().min(1).max(256),
      triggers: z.array(triggerSchema),
      actions: z.array(actionSchema),
    },
    withErrorHandling(async (args) => {
      const response = await api.createWorkflow(args);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.tool(
    "update_workflow",
    "Patch a Paperless workflow: only the supplied fields are changed. " +
      "WARNING: `triggers` and `actions`, when provided, replace the workflow's WHOLE list, so existing items that are not sent are removed. " +
      "To keep an existing trigger or action, send it again with its `id` (see get_workflow). " +
      "There is no tool to delete a workflow: to switch one off, set enabled=false.",
    {
      id: z.number().int(),
      ...workflowFields,
    },
    withErrorHandling(async (args) => {
      const { id, ...data } = args;
      const response = await api.updateWorkflow(id, data);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );
}
