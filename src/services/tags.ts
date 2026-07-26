import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { CONFIG } from "../config.js";
import { normalize, resolve, isAbsolute, basename, dirname, join } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { isDiagEnabled, truncateValue, diagLog, diagWarn } from "./logger.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Marker file whose presence pins a directory as the opencode-mem project root.
 *
 * A multi-repo workspace (e.g. a tree managed by Google `repo`, a monorepo,
 * or any layout where several nested git repositories should share one memory
 * store) drops this file at the workspace root. Every session started anywhere
 * underneath then resolves onto that root instead of onto whichever physical
 * git repository the working directory happens to live in.
 *
 * Unlike an environment variable or a config-file value, the marker is found
 * by walking up from the working directory that every code path already passes
 * in (the plugin's `ctx.directory`, the web API's `process.cwd()`), so project
 * identity never depends on which long-lived opencode process happens to own
 * the shared web server.
 */
const PROJECT_MARKER = ".opencode-mem-project";

/**
 * Walk up from `directory` (inclusive) to the filesystem root looking for the
 * {@link PROJECT_MARKER}. Returns the first directory that contains it, or
 * `null` when no marker is found so the caller can fall back to git detection.
 */
export function findMarkerProjectRoot(directory: string): string | null {
  let dir = resolve(directory);
  while (true) {
    if (existsSync(join(dir, PROJECT_MARKER))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

export interface TagInfo {
  tag: string;
  displayName: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

export function getGitEmail(): string | null {
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return email || null;
  } catch (err: unknown) {
    if (isDiagEnabled()) {
      const msg = err instanceof Error ? err.message : String(err);
      diagWarn("tags.ts:getGitEmail", "git command failed", { error: msg.substring(0, 200) });
    }
    return null;
  }
}

export function getGitName(): string | null {
  try {
    const name = execSync("git config user.name", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || null;
  } catch (err: unknown) {
    if (isDiagEnabled()) {
      const msg = err instanceof Error ? err.message : String(err);
      diagWarn("tags.ts:getGitName", "git command failed", { error: msg.substring(0, 200) });
    }
    return null;
  }
}

export function getGitRepoUrl(directory: string): string | null {
  try {
    const url = execSync("git config --get remote.origin.url", {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url || null;
  } catch (err: unknown) {
    if (isDiagEnabled()) {
      const msg = err instanceof Error ? err.message : String(err);
      diagWarn("tags.ts:getGitRepoUrl", "git command failed", { error: msg.substring(0, 200) });
    }
    return null;
  }
}

export function getGitCommonDir(directory: string): string | null {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!commonDir) {
      return null;
    }

    const resolved = isAbsolute(commonDir)
      ? normalize(commonDir)
      : normalize(resolve(directory, commonDir));

    if (existsSync(resolved)) {
      return realpathSync(resolved);
    }

    return resolved;
  } catch (err: unknown) {
    if (isDiagEnabled()) {
      const msg = err instanceof Error ? err.message : String(err);
      diagWarn("tags.ts:getGitCommonDir", "git command failed", { error: msg.substring(0, 200) });
    }
    return null;
  }
}

export function getGitTopLevel(directory: string): string | null {
  try {
    const topLevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return topLevel || null;
  } catch (err: unknown) {
    if (isDiagEnabled()) {
      const msg = err instanceof Error ? err.message : String(err);
      diagWarn("tags.ts:getGitTopLevel", "git command failed", { error: msg.substring(0, 200) });
    }
    return null;
  }
}

// Git-only fallbacks, kept separate so the marker-aware entry points below
// can short-circuit on a marker and reuse these without re-running detection.
function getGitProjectRoot(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir && basename(commonDir) === ".git") {
    return dirname(commonDir);
  }

  const topLevel = getGitTopLevel(directory);
  if (topLevel) {
    return topLevel;
  }

  return directory;
}

function getGitProjectIdentity(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir) {
    return `git-common:${commonDir}`;
  }

  const gitRepoUrl = getGitRepoUrl(directory);
  if (gitRepoUrl) {
    return `remote:${gitRepoUrl}`;
  }

  return `path:${normalize(directory)}`;
}

export function getProjectRoot(directory: string): string {
  return findMarkerProjectRoot(directory) ?? getGitProjectRoot(directory);
}

export function getProjectIdentity(directory: string): string {
  const markerRoot = findMarkerProjectRoot(directory);
  return markerRoot ? `path:${markerRoot}` : getGitProjectIdentity(directory);
}

export function getProjectName(directory: string): string {
  const normalized = normalize(directory).replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  return parts[parts.length - 1] || directory;
}

export function getUserTagInfo(): TagInfo {
  const email = CONFIG.userEmailOverride || getGitEmail();
  const name = CONFIG.userNameOverride || getGitName();

  if (email) {
    const tag = `${CONFIG.containerTagPrefix}_user_${sha256(email)}`;
    if (isDiagEnabled()) {
      diagLog("tags.ts:getUserTagInfo", "generated email-based tag", {
        prefix: CONFIG.containerTagPrefix,
        tag: truncateValue(tag),
        email: email ? truncateValue(email) : "none",
      });
    }
    return {
      tag,
      displayName: name || email,
      userName: name || undefined,
      userEmail: email,
    };
  }

  const fallback = name || process.env.USER || process.env.USERNAME || "anonymous";
  const tag = `${CONFIG.containerTagPrefix}_user_${sha256(fallback)}`;
  if (isDiagEnabled()) {
    diagLog("tags.ts:getUserTagInfo", "generated fallback tag", {
      prefix: CONFIG.containerTagPrefix,
      tag: truncateValue(tag),
      fallback,
    });
  }
  return {
    tag,
    displayName: fallback,
    userName: fallback,
    userEmail: undefined,
  };
}

export function getProjectTagInfo(directory: string): TagInfo {
  // Resolve the marker exactly once and derive root + identity from it, so a
  // single getProjectTagInfo call never walks the ancestry more than once.
  const markerRoot = findMarkerProjectRoot(directory);
  const projectRoot = markerRoot ?? getGitProjectRoot(directory);
  const projectName = getProjectName(projectRoot);
  // When a marker pins the project root, any git remote belongs to a single
  // nested sub-repo and would be misleading for the grouped workspace, so
  // leave it unset.
  const gitRepoUrl = markerRoot ? null : getGitRepoUrl(directory);
  const projectIdentity = markerRoot ? `path:${markerRoot}` : getGitProjectIdentity(projectRoot);

  const tag = `${CONFIG.containerTagPrefix}_project_${sha256(projectIdentity)}`;

  if (isDiagEnabled()) {
    diagLog("tags.ts:getProjectTagInfo", "generated project tag", {
      prefix: CONFIG.containerTagPrefix,
      tag: truncateValue(tag),
      projectRoot,
      markerDetected: !!markerRoot,
    });
  }

  return {
    tag,
    displayName: projectRoot,
    projectPath: projectRoot,
    projectName,
    gitRepoUrl: gitRepoUrl || undefined,
  };
}

export function getTags(directory: string): {
  user: TagInfo;
  project: TagInfo;
} {
  return {
    user: getUserTagInfo(),
    project: getProjectTagInfo(directory),
  };
}
