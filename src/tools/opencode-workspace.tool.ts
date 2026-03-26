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
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { UnifiedTool } from "./registry.js";
import { Logger } from "../utils/logger.js";

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
