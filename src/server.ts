/**
 * HTTP server entry point for multi-tenant deployment.
 *
 * Runs as a shared MCP server in the Dialogue cluster.  Agent pods
 * connect via Streamable HTTP on port 8027.  Each request must include
 * an ``X-Dialogue-User-Id`` header; the server creates isolated
 * per-user workspaces and spawns OpenCode processes scoped to each
 * user's directory.
 *
 * Uses the **stateless per-request** pattern: every POST creates a
 * fresh MCP Server + Transport pair, handles the request, then tears
 * down.  No in-memory sessions, no stale session IDs, survives pod
 * restarts without client-side changes.
 *
 * @module server
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { generateOpenCodeConfig, refreshAllConfigs } from "./opencode-config.js";
import { McpAuthValidator, AuthError } from "shared-bao-auth";

// ============================================================================
// Environment configuration
// ============================================================================

const HOST = process.env.OPENCODE_MCP_HOST ?? "0.0.0.0";
const MCP_PORT = parseInt(process.env.OPENCODE_MCP_PORT ?? "8027", 10);
const HEALTH_PORT = parseInt(process.env.OPENCODE_MCP_HEALTH_PORT ?? "8028", 10);
const LOG_LEVEL = (process.env.OPENCODE_MCP_LOG_LEVEL ?? "info") as LogLevel;
const MAX_CONCURRENT_PER_USER = parseInt(process.env.OPENCODE_MCP_MAX_CONCURRENT_PER_USER ?? "3", 10);
const WORKSPACE_BASE = process.env.OPENCODE_MCP_WORKSPACE_BASE ?? "/workspaces";
const SHARD_MANAGER_URL = process.env.OPENCODE_MCP_SHARD_MANAGER_URL ?? "http://agent-shard-manager:8010";
const GITHUB_MCP_URL = process.env.OPENCODE_MCP_GITHUB_MCP_URL ?? "http://github-token-service:8013";

// ============================================================================
// Per-user concurrency tracking (survives across stateless requests)
// ============================================================================

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
// MCP Server factory — one per request (stateless)
// ============================================================================

function createMcpServer(userId: string, vaultToken: string): Server {
  const server = new Server(
    { name: "opencode-mcp", version: "2.1.0" },
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
      process.env.__OPENCODE_VAULT_TOKEN = vaultToken;
      process.env.__OPENCODE_WORKSPACE = WorkspaceManager.userDir(WORKSPACE_BASE, userId);

      // Resolve the user's OpenRouter key (cached).
      const orKey = await resolveOpenRouterKey(userId, SHARD_MANAGER_URL);
      if (orKey) {
        process.env.__OPENCODE_API_KEY = orKey;
      }

      // Ensure the per-user opencode.json config is up to date.
      // Pass the current Vault token so the GitHub MCP header is always fresh.
      await generateOpenCodeConfig(userId, WORKSPACE_BASE, GITHUB_MCP_URL, vaultToken);

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

// Module-level auth validator — initialized lazily.
let mcpValidator: McpAuthValidator | null = null;

function getValidator(): McpAuthValidator {
  if (!mcpValidator) {
    mcpValidator = new McpAuthValidator();
  }
  return mcpValidator;
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only accept POST — stateless mode has no GET SSE or DELETE session.
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
    return;
  }

  // Authenticate via OpenBao Vault token.
  let userId: string;
  const authHeader = req.headers["authorization"] as string | undefined;
  try {
    userId = await getValidator().extractUserId(authHeader);
  } catch (err) {
    const msg = err instanceof AuthError ? err.message : "Authentication failed";
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // Capture the raw Vault token so child processes (git credential helper,
  // OpenCode CLI) can authenticate to github-token-service with it.
  const vaultToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  // Ensure workspace exists.
  await WorkspaceManager.ensureUserDir(WORKSPACE_BASE, userId);

  // Stateless per-request pattern: fresh Server + Transport for every POST.
  // No session tracking — survives pod restarts, no stale session IDs.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // stateless mode
  });
  const mcpServer = createMcpServer(userId, vaultToken);

  await mcpServer.connect(transport);

  try {
    await transport.handleRequest(req, res);
  } finally {
    // Tear down the ephemeral server + transport after response completes.
    // Use res.on('close') so SSE streams can finish if the SDK uses them.
    res.on("close", () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });
  }
}

function handleHealthRequest(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "opencode-mcp",
    mode: "stateless",
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

  // Refresh opencode.json for all existing workspaces so config changes
  // (e.g. new permission rules) take effect immediately on deploy.
  await refreshAllConfigs(WORKSPACE_BASE, GITHUB_MCP_URL);

  // ── MCP server (Streamable HTTP — stateless) ───────────────────
  const httpServer = createServer(async (req, res) => {
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

  httpServer.listen(MCP_PORT, HOST, () => {
    Logger.info(`opencode-mcp MCP server listening on ${HOST}:${MCP_PORT} (stateless mode)`);
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

    httpServer.close();
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
