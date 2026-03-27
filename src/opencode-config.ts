/**
 * Per-user OpenCode configuration generator.
 *
 * Generates an ``opencode.json`` config file in each user's workspace
 * that configures OpenCode to use the GitHub MCP server (via the
 * github-token-service credential-injecting proxy) with the user's
 * identity.
 *
 * @module opencode-config
 */

import { writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceManager } from "./workspace.js";
import { Logger } from "./utils/logger.js";

/**
 * OpenCode config structure matching ~/.config/opencode/opencode.json.
 */
interface OpenCodeConfig {
  $schema?: string;
  provider?: Record<string, unknown>;
  permission?: Record<string, string> | string;
  mcp?: Record<string, unknown>;
  tools?: Record<string, boolean>;
}

/**
 * Generate (or update) the per-user opencode.json config.
 *
 * This sets up:
 * - OpenRouter as the provider (key comes from env at runtime).
 * - GitHub MCP server pointing to the token service proxy with
 *   the user's Vault token for authentication.
 *
 * @param vaultToken - Optional OpenBao Vault token.  When provided the
 *   GitHub MCP header uses ``Authorization: Bearer <token>`` so that
 *   github-token-service can validate the caller cryptographically.
 *   Omitted during startup refresh (no active request); the config is
 *   regenerated with a fresh token on every tool invocation.
 */
export async function generateOpenCodeConfig(
  userId: string,
  workspaceBase: string,
  githubMcpUrl: string,
  vaultToken?: string,
): Promise<void> {
  const configDir = WorkspaceManager.configDir(workspaceBase, userId);
  const configPath = join(configDir, "opencode.json");

  const config: OpenCodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      openrouter: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenRouter",
        options: {
          baseURL: "https://openrouter.ai/api/v1",
          timeout: 600000,
        },
      },
    },
    // Fully headless — no human to approve or answer questions.
    // Allow all tool operations without prompting, and deny the
    // question tool (it would hang waiting for user input).
    permission: {
      "*": "allow",
      doom_loop: "allow",
      external_directory: "allow",
      question: "deny",
    },
    mcp: {
      github: {
        type: "remote",
        url: `${githubMcpUrl}/`,
        headers: vaultToken
          ? { Authorization: `Bearer ${vaultToken}` }
          : {},
      },
    },
    // Restrict tool access for security — disable write operations by
    // default so the agent must explicitly opt in.
    tools: {
      "github_search*": true,
      "github_get_file*": true,
      "github_get_iss*": true,
      "github_list_*": true,
      "github_create*": true,
      "github_push*": true,
      "github_fork*": true,
    },
  };

  try {
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    Logger.debug(`Wrote opencode.json for user ${userId}`);
  } catch (err) {
    Logger.error(`Failed to write opencode.json for user ${userId}:`, err);
  }
}

/**
 * Refresh opencode.json for all existing user workspaces.
 *
 * Called at server startup so that config changes (e.g. new permission
 * rules) take effect immediately, even for workspaces created by a
 * previous server version.
 */
export async function refreshAllConfigs(
  workspaceBase: string,
  githubMcpUrl: string,
): Promise<void> {
  try {
    const entries = await readdir(workspaceBase, { withFileTypes: true });
    const userDirs = entries.filter((e) => e.isDirectory() && /^[a-f0-9-]{8,36}$/i.test(e.name));

    let count = 0;
    for (const dir of userDirs) {
      try {
        // Ensure config directory exists (idempotent).
        await WorkspaceManager.ensureUserDir(workspaceBase, dir.name);
        await generateOpenCodeConfig(dir.name, workspaceBase, githubMcpUrl);
        count++;
      } catch (err) {
        Logger.error(`Failed to refresh config for workspace ${dir.name}:`, err);
      }
    }
    Logger.info(`Refreshed opencode.json for ${count} existing workspace(s)`);
  } catch (err) {
    // workspaceBase might not exist yet — that's fine.
    Logger.debug(`No existing workspaces to refresh: ${err}`);
  }
}
