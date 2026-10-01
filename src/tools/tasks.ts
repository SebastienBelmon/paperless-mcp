import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { PaperlessTask, TaskStatus } from "../api/types";
import { withErrorHandling } from "./utils/middlewares";

type ReportedStatus = TaskStatus | "NOT_FOUND";

interface TaskReport {
  task_id: string;
  status: ReportedStatus;
  result?: string | null;
  related_document?: number | null;
  task_file_name?: string | null;
  date_created?: string | null;
  date_done?: string | null;
}

const FINAL_STATUSES: ReportedStatus[] = ["SUCCESS", "FAILURE", "REVOKED"];

const STATUS_DESCRIPTION =
  "Statuses: PENDING, RECEIVED, STARTED, RETRY (not finished), SUCCESS, FAILURE, REVOKED (final). " +
  "related_document is the ID of the created document and is only set on SUCCESS; on FAILURE, result holds the error message. " +
  "NOT_FOUND means Paperless does not know the task (yet).";

const isFinal = (report: TaskReport) => FINAL_STATUSES.includes(report.status);

function toTaskReport(taskId: string, tasks: PaperlessTask[]): TaskReport {
  const task = tasks[0];
  if (!task) {
    return { task_id: taskId, status: "NOT_FOUND" };
  }
  return {
    task_id: task.task_id,
    status: task.status,
    result: task.result,
    related_document: task.related_document
      ? Number(task.related_document)
      : null,
    task_file_name: task.task_file_name,
    date_created: task.date_created,
    date_done: task.date_done,
  };
}

export function registerTaskTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "get_task",
    `Get the status of the import started by post_document. The "status" string that post_document returns is the task UUID: pass it as task_id. ${STATUS_DESCRIPTION}`,
    {
      task_id: z
        .string()
        .min(1)
        .describe("Task UUID, as returned by post_document"),
    },
    withErrorHandling(async ({ task_id }) => {
      const report = toTaskReport(task_id, await api.getTasks(task_id));
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
      };
    })
  );

  server.tool(
    "wait_for_tasks",
    `Wait until the imports started by post_document are finished. Polls every interval_seconds until every task is final (SUCCESS, FAILURE or REVOKED) or timeout_seconds elapse. The default timeout is 55 seconds because many MCP clients abort a tool call after about 60 seconds: if timed_out is true, call wait_for_tasks again with the tasks that are not final. Returns { tasks, all_done, timed_out }, where each task has the same shape as get_task. ${STATUS_DESCRIPTION}`,
    {
      task_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe("Task UUIDs, as returned by post_document"),
      interval_seconds: z
        .number()
        .int()
        .min(1)
        .default(5)
        .describe("Seconds between two polls"),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .default(55)
        .describe("Maximum seconds to wait before returning"),
    },
    withErrorHandling(
      async ({ task_ids, interval_seconds, timeout_seconds }, extra) => {
        const deadline = Date.now() + timeout_seconds * 1000;
        const progressToken = extra._meta?.progressToken;
        const reports: TaskReport[] = task_ids.map((task_id) => ({
          task_id,
          status: "NOT_FOUND",
        }));
        let reportedFinished = 0;

        while (true) {
          await Promise.all(
            reports.map(async (report, i) => {
              if (!isFinal(report)) {
                reports[i] = toTaskReport(
                  report.task_id,
                  await api.getTasks(report.task_id)
                );
              }
            })
          );

          const finished = reports.filter(isFinal).length;
          const allDone = finished === reports.length;
          const remainingMs = deadline - Date.now();
          if (allDone || remainingMs <= 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    tasks: reports,
                    all_done: allDone,
                    timed_out: !allDone,
                  }),
                },
              ],
            };
          }

          if (progressToken !== undefined && finished > reportedFinished) {
            reportedFinished = finished;
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: finished,
                total: reports.length,
                message: `${finished}/${reports.length} tasks finished`,
              },
            });
          }

          await sleep(
            Math.min(interval_seconds * 1000, remainingMs),
            undefined,
            { signal: extra.signal }
          );
        }
      }
    )
  );
}
