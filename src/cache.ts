import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ConversationSnippet } from "./types.js";

const CACHE_VERSION = 1;
const CACHE_DIR_NAME = ".brag-cache";

/**
 * Returns the cache directory path (`.brag-cache` under cwd), creating it if it does not exist.
 * @returns Absolute path to the cache directory.
 */
function getCacheDir(): string {
  const dir = join(process.cwd(), CACHE_DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Builds a stable cache key for a fetch request so the same week + user + options always hits the same cache entry.
 * @param userId - Slack user ID.
 * @param since - Start of the date range.
 * @param until - End of the date range.
 * @param maxSnippets - Optional cap on snippets (included in key so different caps don't share cache).
 * @returns SHA-256 hex string suitable as a cache filename.
 */
export function getCacheKey(
  userId: string,
  since: Date,
  until: Date,
  maxSnippets?: number
): string {
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = until.toISOString().slice(0, 10);
  const max = maxSnippets ?? "default";
  const raw = `${userId}:${sinceStr}:${untilStr}:${max}:v${CACHE_VERSION}`;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Resolves the filesystem path for a cache entry.
 * @param key - Cache key (e.g. from getCacheKey).
 * @returns Absolute path to the JSON cache file.
 */
function getCachePath(key: string): string {
  return join(getCacheDir(), `${key}.json`);
}

/**
 * Reads cached conversation snippets from disk if present and version-compatible.
 * @param key - Cache key (e.g. from getCacheKey).
 * @returns Cached snippets array, or null if missing, invalid, or wrong version.
 */
export function readSnippetsFromCache(key: string): ConversationSnippet[] | null {
  try {
    const path = getCachePath(key);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as {
      version?: number;
      cachedAt?: string;
      snippets?: unknown;
    };
    if (data.version !== CACHE_VERSION || !Array.isArray(data.snippets)) {
      return null;
    }
    return data.snippets as ConversationSnippet[];
  } catch {
    return null;
  }
}

/**
 * Writes conversation snippets to the cache directory with current version and timestamp.
 * @param key - Cache key (e.g. from getCacheKey).
 * @param snippets - Array of snippets to store.
 */
export function writeSnippetsToCache(key: string, snippets: ConversationSnippet[]): void {
  const path = getCachePath(key);
  const data = {
    version: CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    snippets,
  };
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

/**
 * Whether snippet caching is enabled (env BRAG_CACHE=1 or true) and not overridden.
 * @param skipCache - If true, caching is disabled (e.g. --no-cache).
 * @returns True if cache should be read from / written to.
 */
export function isCacheEnabled(skipCache: boolean): boolean {
  if (skipCache) return false;
  return process.env.BRAG_CACHE === "1" || process.env.BRAG_CACHE === "true";
}
