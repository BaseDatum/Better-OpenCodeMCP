/**
 * Task events tool — lets the calling agent inspect the raw event
 * stream from an OpenCode task to understand exactly what happened:
 * which tools were called, what commands ran, where errors occurred.
 *
 * @module opencode-task-events
 */

import { z } from "zod";
import { UnifiedTool } from "./registry.js";
import { getPersistence } from "../persistence/sharedPersistence.js";
import { Logger } from "../utils/logger.js";
import type {
  OpenCodeEvent,
  ToolUseEvent,
  TextEvent,
  StepFinishEvent,
  ErrorEvent,
} from "../utils/jsonEventParser.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Summarize an event into a compact representation.
 * Full raw events are too verbose; the agent needs a digest.
 */
function summarizeEvent(event: OpenCodeEvent): Record<string, unknown> {
  switch (event.type) {
    case "step_start":
      return { type: "step_start", timestamp: event.timestamp };

    case "text": {
      const te = event as TextEvent;
      const text = te.part.text;
      return {
        type: "text",
        timestamp: event.timestamp,
        text: text.length > 500 ? text.slice(0, 500) + "..." : text,
      };
    }

    case "tool_use": {
      const tu = event as ToolUseEvent;
      const out = tu.part.state.output;
      return {
        type: "tool_use",
        timestamp: event.timestamp,
        tool: tu.part.tool,
        status: tu.part.state.status,
        input: tu.part.state.input,
        exitCode: tu.part.state.metadata?.exit,
        output: out.length > 1000 ? out.slice(0, 1000) + "..." : out,
      };
    }

    case "step_finish": {
      const sf = event as StepFinishEvent;
      return {
        type: "step_finish",
        timestamp: event.timestamp,
        reason: sf.part.reason,
        cost: sf.part.cost,
        tokens: sf.part.tokens,
      };
    }

    case "error": {
      const ee = event as ErrorEvent;
      return {
        type: "error",
        timestamp: event.timestamp,
        errorName: ee.error?.name,
        errorMessage: ee.error?.data?.message,
      };
    }

    default:
      return { type: (event as any).type, timestamp: (event as any).timestamp };
  }
}

// ============================================================================
// Tool definition
// ============================================================================

const taskEventsSchema = z.object({
  taskId: z
    .string()
    .min(1)
    .describe("Task ID to get events for (from opencode_sessions)"),
  filter: z
    .enum(["all", "tools", "errors", "text"])
    .optional()
    .default("all")
    .describe("Filter events: 'all' (default), 'tools' (tool_use only), 'errors' (errors only), 'text' (text output only)"),
  last: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Return only the last N events (default: 50, max: 200)"),
});

export const opencodeTaskEventsTool: UnifiedTool = {
  name: "opencode_task_events",
  description: `Get the event stream from an OpenCode task. Shows exactly what happened: which tools were called, what commands ran, where errors occurred.

USE THIS TOOL when you need to:
- Debug why a task failed (see the exact error and what led to it)
- Understand what tools/commands OpenCode used
- Review the step-by-step execution of a completed task
- Check what OpenCode was doing when it got stuck

INPUTS:
- taskId (required): Task ID from opencode_sessions
- filter: 'all' (default), 'tools' (tool_use events only), 'errors' (errors only), 'text' (text output only)
- last: Return only the last N events (default: 50)

RETURNS: JSON array of summarized events with timestamps, tool calls, outputs, and errors`,
  zodSchema: taskEventsSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const taskId = args.taskId as string;
    const filter = (args.filter as string) || "all";
    const last = (args.last as number) || 50;

    const persistence = getPersistence();
    if (!persistence) {
      return JSON.stringify({
        taskId,
        error: "Persistence not available — events are only stored when persistence is enabled",
        events: [],
      }, null, 2);
    }

    const rawEvents = await persistence.loadEvents(taskId);

    if (rawEvents.length === 0) {
      return JSON.stringify({
        taskId,
        error: "No events found for this task — it may have been purged or the task ID is wrong",
        events: [],
      }, null, 2);
    }

    // Apply filter
    let filtered = rawEvents;
    switch (filter) {
      case "tools":
        filtered = rawEvents.filter(e => e.type === "tool_use");
        break;
      case "errors":
        filtered = rawEvents.filter(e => e.type === "error");
        break;
      case "text":
        filtered = rawEvents.filter(e => e.type === "text");
        break;
      // "all" — no filter
    }

    // Take last N events
    const sliced = filtered.slice(-last);

    // Summarize each event
    const summaries = sliced.map(summarizeEvent);

    return JSON.stringify({
      taskId,
      totalRawEvents: rawEvents.length,
      filteredCount: filtered.length,
      returnedCount: summaries.length,
      events: summaries,
    }, null, 2);
  },
};
