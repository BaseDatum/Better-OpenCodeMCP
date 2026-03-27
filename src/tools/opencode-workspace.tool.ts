/**
 * Workspace visibility tools — let the calling agent inspect files
 * that OpenCode has created/modified in its isolated workspace.
 *
 * Without these the agent can only see its own local filesystem and
 * has no way to verify what OpenCode actually did.
 *
 * @module opencode-workspace
 */

import { z } from "zod";
import { readdir, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { spawn } from "node:child_process";
import { UnifiedTool } from "./registry.js";
import { Logger } from "../utils/logger.js";
import { WorkspaceManager } from "../workspace.js";

// ============================================================================
// Helpers
// ============================================================================

/** Resolve the workspace root from per-request env set by server.ts */
function getWorkspaceRoot(): string {
  const ws = process.env.__OPENCODE_WORKSPACE;
  if (!ws) throw new Error("No workspace context — this tool must be called through the MCP server");
  return ws;
}

/**
 * Recursively list files under `dir`, returning paths relative to `root`.
 * Respects depth limit and caps total entries to prevent runaway output.
 */
async function listTree(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  entries: string[],
  maxEntries: number,
): Promise<void> {
  if (depth > maxDepth || entries.length >= maxEntries) return;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // permission denied or missing — skip silently
  }

  // Sort for deterministic output
  names.sort();

  for (const name of names) {
    if (entries.length >= maxEntries) break;

    const fullPath = join(dir, name);
    const relPath = relative(root, fullPath);

    // Skip hidden dirs like .git, .local, .config at the top level
    if (depth === 0 && name.startsWith(".")) continue;

    let itemStat;
    try {
      itemStat = await stat(fullPath);
    } catch {
      continue;
    }
    const item = { isDirectory: () => itemStat.isDirectory() };

    if (item.isDirectory()) {
      entries.push(relPath + "/");
      await listTree(root, fullPath, depth + 1, maxDepth, entries, maxEntries);
    } else {
      entries.push(relPath);
    }
  }
}

// ============================================================================
// opencode_workspace_files
// ============================================================================

const filesSchema = z.object({
  path: z
    .string()
    .optional()
    .default("")
    .describe("Subdirectory to list (relative to workspace root). Empty = root."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(3)
    .describe("Maximum directory depth to recurse (1-10, default 3)"),
  maxEntries: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(200)
    .describe("Maximum file entries to return (1-500, default 200)"),
});

export const opencodeWorkspaceFilesTool: UnifiedTool = {
  name: "opencode_workspace_files",
  description: `List files in the OpenCode workspace. Use this to see what OpenCode has created, cloned, or modified.

The OpenCode workspace is a SEPARATE filesystem from your own — you cannot see its files with your local file_list tool.

USE THIS TOOL when you need to:
- Verify that a git clone or file creation succeeded
- Browse the workspace file tree before asking OpenCode to work on specific files
- Check the structure of a cloned repository
- Confirm OpenCode's work output

INPUTS:
- path: Subdirectory to list (relative to workspace root, default: root)
- depth: Max recursion depth (1-10, default: 3)
- maxEntries: Max entries to return (1-500, default: 200)

RETURNS: JSON with workspace root path and file listing`,
  zodSchema: filesSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const root = getWorkspaceRoot();
    const subPath = (args.path as string) || "";
    const depth = (args.depth as number) || 3;
    const maxEntries = (args.maxEntries as number) || 200;

    // Prevent path traversal
    const targetDir = subPath ? join(root, subPath) : root;
    if (!targetDir.startsWith(root)) {
      throw new Error("Path traversal not allowed");
    }

    // Check if target exists
    try {
      await stat(targetDir);
    } catch {
      return JSON.stringify({
        workspace: root,
        path: subPath || ".",
        error: "Directory not found",
        files: [],
      }, null, 2);
    }

    const entries: string[] = [];
    await listTree(root, targetDir, 0, depth, entries, maxEntries);

    return JSON.stringify({
      workspace: root,
      path: subPath || ".",
      totalFiles: entries.length,
      truncated: entries.length >= maxEntries,
      files: entries,
    }, null, 2);
  },
};

// ============================================================================
// opencode_workspace_read
// ============================================================================

const readSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path to read (relative to workspace root)"),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(512_000)
    .optional()
    .default(64_000)
    .describe("Maximum bytes to read (1-512000, default: 64000)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Byte offset to start reading from (for large files)"),
});

export const opencodeWorkspaceReadTool: UnifiedTool = {
  name: "opencode_workspace_read",
  description: `Read a file from the OpenCode workspace. Use this to inspect code, configs, or output files that OpenCode created or modified.

The OpenCode workspace is a SEPARATE filesystem — you cannot read its files with your local file_read tool.

USE THIS TOOL when you need to:
- Review code that OpenCode wrote or modified
- Read configuration files in the workspace
- Inspect build output, logs, or generated files
- Verify file contents match expectations

INPUTS:
- path (required): File path relative to workspace root
- maxBytes: Maximum bytes to read (default: 64000)
- offset: Byte offset for reading large files in chunks

RETURNS: JSON with file content, size, and whether it was truncated`,
  zodSchema: readSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const root = getWorkspaceRoot();
    const filePath = args.path as string;
    const maxBytes = (args.maxBytes as number) || 64_000;
    const offset = (args.offset as number) || 0;

    const fullPath = join(root, filePath);

    // Prevent path traversal
    if (!fullPath.startsWith(root)) {
      throw new Error("Path traversal not allowed");
    }

    // Get file info
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch {
      return JSON.stringify({
        workspace: root,
        path: filePath,
        error: "File not found",
      }, null, 2);
    }

    if (fileStat.isDirectory()) {
      return JSON.stringify({
        workspace: root,
        path: filePath,
        error: "Path is a directory — use opencode_workspace_files instead",
      }, null, 2);
    }

    // Read file content
    const fd = await import("node:fs/promises").then(fs =>
      fs.open(fullPath, "r")
    );
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fd.read(buf, 0, maxBytes, offset);
      const content = buf.subarray(0, bytesRead).toString("utf-8");

      return JSON.stringify({
        workspace: root,
        path: filePath,
        size: fileStat.size,
        offset,
        bytesRead,
        truncated: offset + bytesRead < fileStat.size,
        content,
      }, null, 2);
    } finally {
      await fd.close();
    }
  },
};

// ============================================================================
// opencode_workspace_write
// ============================================================================

const writeSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path to write (relative to workspace root). Parent directories are created automatically."),
  content: z
    .string()
    .describe("File content to write"),
  append: z
    .boolean()
    .optional()
    .default(false)
    .describe("Append to file instead of overwriting (default: false)"),
});

export const opencodeWorkspaceWriteTool: UnifiedTool = {
  name: "opencode_workspace_write",
  description: `Write a file into the OpenCode workspace. Use this to seed files before asking OpenCode to work on them.

USE THIS TOOL when you need to:
- Drop a requirements doc, spec, or prompt file into the workspace
- Create a config file for OpenCode to use
- Write a patch file for OpenCode to apply
- Seed initial project files before delegating work

INPUTS:
- path (required): File path relative to workspace root (parent dirs created automatically)
- content (required): File content to write
- append: Append instead of overwrite (default: false)

RETURNS: JSON with path and bytes written`,
  zodSchema: writeSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const root = getWorkspaceRoot();
    const filePath = args.path as string;
    const content = args.content as string;
    const append = (args.append as boolean) || false;

    const fullPath = join(root, filePath);

    // Prevent path traversal
    if (!fullPath.startsWith(root)) {
      throw new Error("Path traversal not allowed");
    }

    // Ensure parent directory exists
    await mkdir(dirname(fullPath), { recursive: true });

    if (append) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(fullPath, content, "utf-8");
    } else {
      await writeFile(fullPath, content, "utf-8");
    }

    return JSON.stringify({
      workspace: root,
      path: filePath,
      bytesWritten: Buffer.byteLength(content, "utf-8"),
      append,
    }, null, 2);
  },
};

// ============================================================================
// opencode_workspace_exec
// ============================================================================

const execSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("Shell command to run in the workspace (e.g. 'git log --oneline -10', 'ls -la', 'npm test')"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .default(30_000)
    .describe("Timeout in milliseconds (1000-120000, default: 30000)"),
});

export const opencodeWorkspaceExecTool: UnifiedTool = {
  name: "opencode_workspace_exec",
  description: `Run a shell command directly in the OpenCode workspace. Much faster than spawning a full OpenCode LLM session for simple operations.

USE THIS TOOL when you need to:
- Run git commands (git log, git status, git diff)
- Check build output (npm test, npm run build)
- Inspect files (ls, find, wc)
- Run any quick command without LLM overhead

This runs directly in the workspace shell — no LLM round-trip, no token cost, instant results.

INPUTS:
- command (required): Shell command to execute
- timeout: Max execution time in ms (default: 30000)

RETURNS: JSON with stdout, stderr, exit code`,
  zodSchema: execSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const root = getWorkspaceRoot();
    const command = args.command as string;
    const timeout = (args.timeout as number) || 30_000;

    return new Promise((resolve) => {
      // Build child environment with git credential helper support.
      const childEnv: Record<string, string | undefined> = { ...process.env, HOME: root };
      const userId = process.env.__OPENCODE_USER_ID;
      if (userId) {
        const githubTokenUrl = process.env.OPENCODE_MCP_GITHUB_MCP_URL ?? "http://github-token-service:8013";
        childEnv.__OPENCODE_USER_ID = userId;
        childEnv.__OPENCODE_GITHUB_TOKEN_URL = githubTokenUrl;
        childEnv.GIT_TERMINAL_PROMPT = "0";
        const existingCount = parseInt(childEnv.GIT_CONFIG_COUNT ?? "0", 10);
        childEnv.GIT_CONFIG_COUNT = String(existingCount + 1);
        childEnv[`GIT_CONFIG_KEY_${existingCount}`] = "credential.helper";
        childEnv[`GIT_CONFIG_VALUE_${existingCount}`] = "/app/scripts/git-credential-dialogue.sh";
      }

      const proc = spawn("sh", ["-c", command], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        timeout,
      });

      let stdout = "";
      let stderr = "";
      const maxOutput = 64_000; // Cap output to prevent huge responses

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutput) {
          stdout += chunk.toString();
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutput) {
          stderr += chunk.toString();
        }
      });

      proc.on("error", (err) => {
        resolve(JSON.stringify({
          workspace: root,
          command,
          error: err.message,
          exitCode: null,
          stdout: stdout.slice(0, maxOutput),
          stderr: stderr.slice(0, maxOutput),
        }, null, 2));
      });

      proc.on("close", (code) => {
        resolve(JSON.stringify({
          workspace: root,
          command,
          exitCode: code,
          stdout: stdout.length > maxOutput ? stdout.slice(0, maxOutput) + "\n... (truncated)" : stdout,
          stderr: stderr.length > maxOutput ? stderr.slice(0, maxOutput) + "\n... (truncated)" : stderr,
        }, null, 2));
      });
    });
  },
};

// ============================================================================
// opencode_workspace_reset
// ============================================================================

const resetSchema = z.object({
  confirm: z
    .literal(true)
    .describe("Must be true to confirm the destructive reset"),
});

export const opencodeWorkspaceResetTool: UnifiedTool = {
  name: "opencode_workspace_reset",
  description: `Reset the OpenCode workspace to a clean state. Deletes ALL files in the workspace project directory.

USE THIS TOOL when you need to:
- Start fresh after a failed or dirty previous task
- Clean up before cloning a different repo
- Remove broken build artifacts or half-completed work

WARNING: This is destructive — all files in the workspace are permanently deleted.

INPUTS:
- confirm (required): Must be true to confirm the reset

RETURNS: JSON confirmation`,
  zodSchema: resetSchema,
  category: "utility",

  execute: async (args): Promise<string> => {
    const root = getWorkspaceRoot();

    if (args.confirm !== true) {
      throw new Error("confirm must be true to reset the workspace");
    }

    // Remove and recreate the project directory
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    Logger.info(`Workspace reset: ${root}`);

    return JSON.stringify({
      workspace: root,
      status: "reset",
      message: "Workspace has been cleared. All files deleted.",
    }, null, 2);
  },
};
