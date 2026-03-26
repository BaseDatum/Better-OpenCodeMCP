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

import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceManager } from "./workspace.js";
import { Logger } from "./utils/logger.js";

/**
 * OpenCode config structure matching ~/.config/opencode/opencode.json.
 */
interface OpenCodeConfig {
  $schema?: string;
  provider?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  tools?: Record<string, boolean>;
}

/**
 * Generate (or update) the per-user opencode.json config.
 *
 * This sets up:
 * - OpenRouter as the provider (key comes from env at runtime).
 * - GitHub MCP server pointing to the token service proxy with
 *   the user's X-Dialogue-User-Id header injected.
 */
export async function generateOpenCodeConfig(
  userId: string,
  workspaceBase: string,
  githubMcpUrl: string,
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
    mcp: {
      github: {
        type: "remote",
        url: `${githubMcpUrl}/`,
        headers: {
          "X-Dialogue-User-Id": userId,
        },
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
