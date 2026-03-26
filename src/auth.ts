/**
 * Authentication and key resolution for multi-tenant OpenCode MCP.
 *
 * Resolves a user's OpenRouter API key by calling the agent-shard-manager's
 * internal API.  Keys are cached in-memory for 5 minutes to avoid
 * hammering the shard manager on every tool call.
 *
 * @module auth
 */

import { Logger } from "./utils/logger.js";

// ============================================================================
// In-memory key cache
// ============================================================================

interface CachedKey {
  key: string;
  expiresAt: number;
}

const KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const keyCache = new Map<string, CachedKey>();

/**
 * Resolve the OpenRouter API key for a user.
 *
 * First checks the in-memory cache, then falls back to querying the
 * agent-shard-manager's internal resolve endpoint.
 *
 * Returns the plaintext API key or null if the user has no key.
 */
export async function resolveOpenRouterKey(
  userId: string,
  shardManagerUrl: string,
): Promise<string | null> {
  // Check cache first.
  const cached = keyCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  try {
    // The shard manager exposes an internal endpoint that returns the
    // decrypted OpenRouter API key for a user.  This endpoint is
    // cluster-only (ClusterIP on port 8010, no Ingress).
    const resp = await fetch(
      `${shardManagerUrl}/internal/openrouter-key/${encodeURIComponent(userId)}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      if (resp.status === 404) {
        Logger.debug(`No OpenRouter key found for user ${userId}`);
        return null;
      }
      Logger.error(`Shard manager returned ${resp.status} for user ${userId}`);
      return null;
    }

    const data = (await resp.json()) as { api_key?: string };
    if (!data.api_key) {
      return null;
    }

    // Cache the key.
    keyCache.set(userId, {
      key: data.api_key,
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    });

    return data.api_key;
  } catch (err) {
    Logger.error(`Failed to resolve OpenRouter key for user ${userId}:`, err);
    return null;
  }
}

/**
 * Invalidate a cached key (e.g. on rotation).
 */
export function invalidateKeyCache(userId: string): void {
  keyCache.delete(userId);
}

/**
 * Clear the entire key cache (for testing or shutdown).
 */
export function clearKeyCache(): void {
  keyCache.clear();
}
