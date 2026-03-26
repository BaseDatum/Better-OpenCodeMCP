/**
 * Per-user workspace directory management.
 *
 * Each user gets an isolated directory at ``{base}/{userId}/`` where
 * OpenCode processes run.  The directory is created on first access
 * and contains a ``project/`` sub-directory that serves as the actual
 * OpenCode working directory.
 *
 * @module workspace
 */

import { mkdir, stat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Logger } from "./utils/logger.js";

export class WorkspaceManager {
  /**
   * Returns the per-user workspace root path.
   */
  static userDir(base: string, userId: string): string {
    // Sanitize userId — allow only alphanumeric + hyphens.
    const safe = userId.replace(/[^a-f0-9-]/gi, "").slice(0, 36);
    return join(base, safe, "project");
  }

  /**
   * Returns the per-user config directory for opencode.json.
   */
  static configDir(base: string, userId: string): string {
    const safe = userId.replace(/[^a-f0-9-]/gi, "").slice(0, 36);
    return join(base, safe, ".config", "opencode");
  }

  /**
   * Returns the per-user data directory for opencode's database.
   */
  static dataDir(base: string, userId: string): string {
    const safe = userId.replace(/[^a-f0-9-]/gi, "").slice(0, 36);
    return join(base, safe, ".local", "share", "opencode");
  }

  /**
   * Ensure the base workspace directory exists.
   */
  static async ensureBaseDir(base: string): Promise<void> {
    await mkdir(base, { recursive: true });
    Logger.debug(`Workspace base directory ensured: ${base}`);
  }

  /**
   * Ensure a user's workspace directory tree exists.
   */
  static async ensureUserDir(base: string, userId: string): Promise<void> {
    const projectDir = this.userDir(base, userId);
    const configDir = this.configDir(base, userId);
    const dataDir = this.dataDir(base, userId);
    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(configDir, { recursive: true }),
      mkdir(dataDir, { recursive: true }),
    ]);
  }

  /**
   * Check if a user's workspace exists.
   */
  static async exists(base: string, userId: string): Promise<boolean> {
    try {
      await stat(this.userDir(base, userId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up a user's workspace.
   */
  static async cleanup(base: string, userId: string): Promise<void> {
    const safe = userId.replace(/[^a-f0-9-]/gi, "").slice(0, 36);
    const userRoot = join(base, safe);
    try {
      await rm(userRoot, { recursive: true, force: true });
      Logger.info(`Cleaned up workspace for user ${userId}`);
    } catch (err) {
      Logger.error(`Failed to cleanup workspace for user ${userId}:`, err);
    }
  }
}
