/**
 * OpenCode Sessions Tool - List and monitor active and recent OpenCode sessions.
 * @module opencodeSessions
 */

import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import { getTaskManager } from "../tasks/sharedTaskManager.js";
import { TaskStatus } from "../tasks/taskManager.js";

/**
 * Session information returned by the tool.
 */
interface SessionInfo {
  taskId: string;
  sessionId: string;
  title: string;
  status: TaskStatus;
  statusMessage?: string;
  model: string;
  agent?: string;
  createdAt: string;
  lastEventAt: string;
  /** Final text output from OpenCode (for completed/failed tasks) */
  output?: string;
}

/**
 * Output schema for the sessions tool.
 */
interface SessionsOutput {
  sessions: SessionInfo[];
  total: number;
}

/**
 * Zod schema for input validation.
 */
const opencodeSessionsArgsSchema = z.object({
  status: z
    .enum(["active", "all"])
    .optional()
    .default("active")
    .describe("Filter by status: 'active' for running tasks only, 'all' for all tasks including completed"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10)
    .describe("Maximum number of sessions to return"),
  includeOutput: z
    .union([z.boolean(), z.number().int().min(1).max(65536)])
    .optional()
    .default(false)
    .describe("Include text output from completed/failed tasks. false=omit (default), true=last 4KB, or a number (bytes, 1-65536) for custom tail size."),
});

/**
 * OpenCode Sessions Tool Definition
 *
 * Lists all active and recent OpenCode sessions for monitoring and management.
 */
export const opencodeSessionsTool: UnifiedTool = {
  name: "opencode_sessions",
  description: `List and monitor OpenCode tasks. Essential for tracking async task progress and finding tasks that need attention.

USE THIS TOOL when you need to:
- Check if a delegated task has completed
- Find tasks waiting for input (status: "input_required")
- Monitor multiple concurrent tasks
- Review recent task history

POLLING PATTERN:
After starting a task with opencode, periodically call this tool to check progress:
1. Call opencode_sessions with status: "active"
2. Check each task's status field
3. Handle based on status:
   - "working": Task still running, check again later
   - "input_required": Use opencode_respond to provide input
   - "completed": Task finished successfully, review results
   - "failed": Task encountered an error

STATUS MEANINGS:
- working: Task is actively executing
- input_required: Task paused, waiting for user input via opencode_respond
- completed: Task finished successfully
- failed: Task encountered an error and stopped

INPUTS:
- status: "active" (running tasks only) or "all" (includes completed/failed)
- limit: Maximum sessions to return (default: 10)
- includeOutput: Set to true to include the text output from completed/failed tasks (last 4KB). Off by default.

RETURNS: { sessions: [...], total: number }

Each session contains: taskId, sessionId, title, status, statusMessage, model, agent, createdAt, lastEventAt, output (if requested)`,
  zodSchema: opencodeSessionsArgsSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const status = (args.status as "active" | "all") || "active";
    const limit = (args.limit as number) || 10;
    const rawInclude = args.includeOutput;
    const includeOutput = rawInclude === true || (typeof rawInclude === "number" && rawInclude > 0);
    const maxOutput = typeof rawInclude === "number" ? rawInclude : 4096;

    const taskManager = getTaskManager();

    // Get tasks based on status filter
    const tasks = status === "active"
      ? taskManager.listActiveTasks()
      : taskManager.listAllTasks();

    // Sort by lastEventAt descending (most recent first)
    const sortedTasks = tasks.sort((a, b) => {
      return b.lastEventAt.getTime() - a.lastEventAt.getTime();
    });

    // Apply limit
    const limitedTasks = sortedTasks.slice(0, limit);

    // Get full state for each task and format output
    const sessions: SessionInfo[] = limitedTasks.map((metadata) => {
      const state = taskManager.getTaskState(metadata.taskId);
      const taskStatus = state?.status || "working";

      const info: SessionInfo = {
        taskId: metadata.taskId,
        sessionId: metadata.sessionId,
        title: metadata.title,
        status: taskStatus,
        model: metadata.model,
        agent: metadata.agent,
        createdAt: metadata.createdAt.toISOString(),
        lastEventAt: metadata.lastEventAt.toISOString(),
      };

      // Include statusMessage if present (e.g. error messages for failed tasks)
      if (state?.statusMessage) {
        info.statusMessage = state.statusMessage;
      }

      // Include accumulated text output only when explicitly requested.
      // Returns the LAST 4KB (most recent output) since that's what
      // matters for understanding the final result.
      if (includeOutput && state?.accumulatedText && (taskStatus === "completed" || taskStatus === "failed")) {
        const text = state.accumulatedText;
        info.output = text.length > maxOutput
          ? "(truncated) ...\n" + text.slice(-maxOutput)
          : text;
      }

      return info;
    });

    const output: SessionsOutput = {
      sessions,
      total: tasks.length,
    };

    return JSON.stringify(output, null, 2);
  },
};
