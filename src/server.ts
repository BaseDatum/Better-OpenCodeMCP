/**
 * HTTP server entry point for multi-tenant deployment.
 *
 * Runs as a shared MCP server in the Dialogue cluster.  Agent pods
 * connect via Streamable HTTP on port 8027.  Each request must include
 * an ``X-Dialogue-User-Id`` header; the server creates isolated
 * per-user sessions and spawns OpenCode processes scoped to each
 * user's workspace directory.
 *
 * @module server
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolRequest,
  ListToolsRequest,
  ListPromptsRequest,
  GetPromptRequest,
  Tool,
  Prompt,
  GetPromptResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { Logger } from "./utils/logger.js";
import { type ToolArguments } from "./constants.js";
import type { LogLevel } from "./constants.js";
import {
  getToolDefinitions,
  getPromptDefinitions,
  executeTool,
  toolExists,
  getPromptMessage,
} from "./tools/index.js";
import { cleanupActiveProcesses } from "./tools/opencode.tool.js";
import { cleanupActiveRespondProcesses } from "./tools/opencode-respond.tool.js";
import { getTaskManager, resetTaskManager } from "./tasks/sharedTaskManager.js";
import { initPersistence, getPersistence } from "./persistence/index.js";
import { PROCESS } from "./constants.js";
import { setServerConfig } from "./config.js";
import { WorkspaceManager } from "./workspace.js";
import { resolveOpenRouterKey } from "./auth.js";
import { generateOpenCodeConfig } from "./opencode-config.js";

// ============================================================================
// Environment configuration
// ============================================================================

const HOST = process.env.OPENCODE_MCP_HOST ?? "0.0.0.0";
const MCP_PORT = parseInt(process.env.OPENCODE_MCP_PORT ?? "8027", 10);
const HEALTH_PORT = parseInt(process.env.OPENCODE_MCP_HEALTH_PORT ?? "8028", 10);
const USER_ID_HEADER = (process.env.OPENCODE_MCP_USER_ID_HEADER ?? "x-dialogue-user-id").toLowerCase();
const LOG_LEVEL = (process.env.OPENCODE_MCP_LOG_LEVEL ?? "info") as LogLevel;
const MAX_CONCURRENT_PER_USER = parseInt(process.env.OPENCODE_MCP_MAX_CONCURRENT_PER_USER ?? "3", 10);
const WORKSPACE_BASE = process.env.OPENCODE_MCP_WORKSPACE_BASE ?? "/workspaces";
const SHARD_MANAGER_URL = process.env.OPENCODE_MCP_SHARD_MANAGER_URL ?? "http://agent-shard-manager:8010";
const GITHUB_MCP_URL = process.env.OPENCODE_MCP_GITHUB_MCP_URL ?? "http://github-token-service:8013";

// ============================================================================
// Per-user session tracking
// ============================================================================

/**
 * Map of active MCP transports keyed by session ID.
 * Each transport is tied to a specific user.
 */
const activeSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server; userId: string }>();

/**
 * Tracks per-user concurrent process count.
 */
const userProcessCounts = new Map<string, number>();

function incrUserProcessCount(userId: string): boolean {
  const current = userProcessCounts.get(userId) ?? 0;
  if (current >= MAX_CONCURRENT_PER_USER) return false;
  userProcessCounts.set(userId, current + 1);
  return true;
}

function decrUserProcessCount(userId: string): void {
  const current = userProcessCounts.get(userId) ?? 0;
  if (current > 0) userProcessCounts.set(userId, current - 1);
}

// ============================================================================
// MCP Server factory — one per session
// ============================================================================

function createMcpServer(userId: string): Server {
  const server = new Server(
    { name: "opencode-mcp", version: "2.0.0" },
    { capabilities: { tools: {}, prompts: {}, logging: {} } },
  );

  // tools/list
  server.setRequestHandler(ListToolsRequestSchema, async (_req: ListToolsRequest): Promise<{ tools: Tool[] }> => {
    return { tools: getToolDefinitions() as unknown as Tool[] };
  });

  // tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
    const toolName = request.params.name;
    if (!toolExists(toolName)) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const args: ToolArguments = (request.params.arguments as ToolArguments) || {};
    Logger.info(`[user=${userId}] tool=${toolName}`);

    try {
      // Inject per-user context into the environment before execution.
      // The opencode tool reads these from the environment.
      process.env.__OPENCODE_USER_ID = userId;
      process.env.__OPENCODE_WORKSPACE = WorkspaceManager.userDir(WORKSPACE_BASE, userId);

      // Resolve the user's OpenRouter key (cached).
      const orKey = await resolveOpenRouterKey(userId, SHARD_MANAGER_URL);
      if (orKey) {
        process.env.__OPENCODE_API_KEY = orKey;
      }

      // Ensure the per-user opencode.json config exists.
      await generateOpenCodeConfig(userId, WORKSPACE_BASE, GITHUB_MCP_URL);

      const result = await executeTool(toolName, args);

      return {
        content: [{ type: "text", text: result }],
        isError: false,
      };
    } catch (error) {
      Logger.error(`[user=${userId}] Error in tool '${toolName}':`, error);
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error executing ${toolName}: ${msg}` }],
        isError: true,
      };
    }
  });

  // prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async (_req: ListPromptsRequest): Promise<{ prompts: Prompt[] }> => {
    return { prompts: getPromptDefinitions() as unknown as Prompt[] };
  });

  // prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (request: GetPromptRequest): Promise<GetPromptResult> => {
    const promptMessage = getPromptMessage(request.params.name, request.params.arguments || {});
    if (!promptMessage) throw new Error(`Unknown prompt: ${request.params.name}`);
    return { messages: [{ role: "user", content: { type: "text", text: promptMessage } }] };
  });

  return server;
}

// ============================================================================
// HTTP handlers
// ============================================================================

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Extract user ID from header.
  const userId = req.headers[USER_ID_HEADER] as string | undefined;
  if (!userId) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Missing ${USER_ID_HEADER} header` }));
    return;
  }

  // Validate user ID format (expect UUID prefix or full UUID).
  if (!/^[a-f0-9-]{8,36}$/i.test(userId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid user ID format" }));
    return;
  }

  // Ensure workspace exists.
  await WorkspaceManager.ensureUserDir(WORKSPACE_BASE, userId);

  // Look up or create a session.
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST" && !sessionId) {
    // New session — create transport + server.
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        Logger.debug(`[user=${userId}] MCP session initialized: ${sid}`);
      },
    });
    const mcpServer = createMcpServer(userId);
    await mcpServer.connect(transport);
    activeSessions.set(newSessionId, { transport, server: mcpServer, userId });

    await transport.handleRequest(req, res);
    return;
  }

  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId)!;
    // Verify user matches session owner.
    if (session.userId !== userId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session does not belong to this user" }));
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  if (req.method === "DELETE" && sessionId) {
    // Session cleanup.
    const session = activeSessions.get(sessionId!);
    if (session) {
      await session.transport.close();
      await session.server.close();
      activeSessions.delete(sessionId!);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Unknown session or method — instruct client to start fresh.
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Invalid or expired session. Start a new session with POST." }));
}

function handleHealthRequest(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "opencode-mcp",
    activeSessions: activeSessions.size,
    uptime: process.uptime(),
  }));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  Logger.setLevel(LOG_LEVEL);

  // Store a default server config — per-user model is injected per-request.
  setServerConfig({
    primaryModel: process.env.OPENCODE_MCP_DEFAULT_MODEL ?? "openrouter/anthropic/claude-sonnet-4",
  });

  // Initialize persistence (non-fatal).
  await initPersistence();

  // Start periodic task purge.
  const purgeInterval = setInterval(() => {
    getTaskManager().purgeCompletedTasks(PROCESS.COMPLETED_TASK_MAX_AGE_MS);
  }, PROCESS.PURGE_INTERVAL_MS);

  // Ensure base workspace directory exists.
  await WorkspaceManager.ensureBaseDir(WORKSPACE_BASE);

  // ── MCP server (Streamable HTTP) ────────────────────────────────
  const mcpServer = createServer(async (req, res) => {
    try {
      await handleMcpRequest(req, res);
    } catch (err) {
      Logger.error("MCP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  mcpServer.listen(MCP_PORT, HOST, () => {
    Logger.info(`opencode-mcp MCP server listening on ${HOST}:${MCP_PORT}`);
  });

  // ── Health server ───────────────────────────────────────────────
  const healthServer = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      handleHealthRequest(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.listen(HEALTH_PORT, HOST, () => {
    Logger.info(`opencode-mcp health server listening on ${HOST}:${HEALTH_PORT}`);
  });

  // ── Graceful shutdown ───────────────────────────────────────────
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    Logger.info(`Received ${signal}, shutting down...`);

    clearInterval(purgeInterval);

    // Close all active sessions.
    for (const [sid, session] of activeSessions) {
      session.transport.close().catch(() => {});
      session.server.close().catch(() => {});
      activeSessions.delete(sid);
    }

    cleanupActiveProcesses();
    cleanupActiveRespondProcesses();

    // Persist active tasks as failed.
    const persistence = getPersistence();
    if (persistence) {
      const tasks = getTaskManager().listActiveTasks();
      for (const task of tasks) {
        persistence.saveTaskMetadata(task.taskId, task, "failed", `Server shutdown (${signal})`).catch(() => {});
      }
    }
    resetTaskManager();

    mcpServer.close();
    healthServer.close();

    Logger.info("Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  Logger.error("Fatal error:", err);
  process.exit(1);
});
