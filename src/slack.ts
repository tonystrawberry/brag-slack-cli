import { WebClient } from "@slack/web-api";
import type { ConversationMessage, ConversationSnippet, SlackFetchOptions } from "./types.js";

const MAX_MESSAGES_PER_THREAD = 200; // max messages per thread reply page; larger = fewer replies calls per thread
const MAX_MESSAGE_LENGTH = 2000;
const DELAY_BETWEEN_SNIPPET_FETCHES_MS = 250; // used only when concurrency is 1
const DEFAULT_FETCH_CONCURRENCY = 8; // max in-flight snippet fetches when running in parallel
const DEFAULT_MAX_SNIPPETS = 200; // cap conversations we fetch context for (most recent first)
const TRIVIAL_MESSAGE_MAX_LENGTH = 2; // skip search matches where message text is this short or empty (e.g. "ok", "👍")

/**
 * Reads the Slack token from SLACK_USER_TOKEN or SLACK_BOT_TOKEN.
 * @returns The token string.
 * @throws Error if neither env var is set.
 */
function getToken(): string {
  const token = process.env.SLACK_USER_TOKEN ?? process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "Missing Slack token. Set SLACK_USER_TOKEN or SLACK_BOT_TOKEN in .env"
    );
  }
  return token;
}

/**
 * Creates a Slack Web API client using the token from the environment.
 * @returns Configured WebClient instance.
 */
export function createSlackClient(): WebClient {
  return new WebClient(getToken());
}

/**
 * Resolves the current user ID, display name, and optional workspace URL (auth.test, or users.lookupByEmail if BRAG_SLACK_EMAIL is set).
 * @param client - Slack Web client.
 * @returns Object with user_id, user_name, and optional workspace_url (with trailing slash).
 * @throws Error if auth.test fails and BRAG_SLACK_EMAIL is not set or lookup fails.
 */
export async function resolveCurrentUser(
  client: WebClient
): Promise<{ user_id: string; user_name: string; workspace_url?: string }> {
  const auth = await client.auth.test();
  if (auth.ok && auth.user_id) {
    const url = (auth as { url?: string }).url;
    const workspaceUrl = url ? (url.endsWith("/") ? url : `${url}/`) : undefined;
    return {
      user_id: auth.user_id,
      user_name: auth.user ?? auth.user_id,
      workspace_url: workspaceUrl,
    };
  }
  const email = process.env.BRAG_SLACK_EMAIL;
  if (!email) {
    throw new Error(
      "Could not resolve current user (auth.test failed). Set BRAG_SLACK_EMAIL in .env to identify yourself."
    );
  }
  const lookup = await client.users.lookupByEmail({ email });
  const user = (lookup as { user?: { id?: string; real_name?: string; name?: string } }).user;
  if (!user?.id) {
    throw new Error(`No Slack user found for email: ${email}`);
  }
  const name = user.real_name ?? user.name ?? user.id;
  return { user_id: user.id, user_name: name };
}

/**
 * Formats a date as YYYY-MM-DD for Slack search queries.
 * @param d - Date to format.
 * @returns ISO date string (date part only).
 */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the Slack search.messages query string for the user and date range.
 * @param userId - Slack user ID (e.g. U12345).
 * @param since - Start date (inclusive).
 * @param until - End date (exclusive in query).
 * @returns Query string (e.g. "from:<@U123> after:2026-01-01 before:2026-03-15").
 */
function buildSearchQuery(userId: string, since: Date, until: Date): string {
  const parts = [
    `from:<@${userId}>`,
    `after:${formatDate(since)}`,
    `before:${formatDate(until)}`,
  ];
  return parts.join(" ");
}

/**
 * Fetches all search.messages matches with page-based pagination (Slack search does not use cursor). Drops matches with message text length <= 2.
 * @param client - Slack Web client.
 * @param query - search.messages query string (e.g. from buildSearchQuery).
 * @returns Array of matches with channel_id, channel_name, ts, optional thread_ts, optional user.
 */
async function fetchAllSearchMatches(
  client: WebClient,
  query: string
): Promise<
  Array<{
    channel_id: string;
    channel_name: string;
    ts: string;
    thread_ts?: string;
    user?: string;
  }>
> {
  const results: Array<{
    channel_id: string;
    channel_name: string;
    ts: string;
    thread_ts?: string;
    user?: string;
  }> = [];
  let page = 1;
  let pageCount = 1;

  do {
    const res = await client.search.messages({
      query,
      count: 100,
      sort: "timestamp",
      sort_dir: "asc",
      page,
    });

    const messages = (res as { messages?: { matches?: unknown[]; pagination?: { page_count?: number } } }).messages;
    const matches = messages?.matches ?? [];
    pageCount = messages?.pagination?.page_count ?? 1;
    console.error(`  Search page ${page}/${pageCount} (${matches.length} matches)`);

    for (const m of matches as Array<{
      channel?: { id?: string; name?: string };
      ts?: string;
      thread_ts?: string;
      user?: string;
      text?: string;
    }>) {
      const channelId = m.channel?.id;
      const ts = m.ts;
      const text = (m.text ?? "").trim();
      if (channelId && ts && text.length > TRIVIAL_MESSAGE_MAX_LENGTH) {
        results.push({
          channel_id: channelId,
          channel_name: m.channel?.name ?? channelId,
          ts,
          thread_ts: m.thread_ts ?? undefined,
          user: m.user,
        });
      }
    }

    page++;
    if (page <= pageCount && matches.length > 0) {
      await new Promise((r) => setTimeout(r, 150));
    }
  } while (page <= pageCount);

  console.error(`Fetched ${results.length} messages from search (${page - 1} page(s)), excluding very short/empty.`);
  return results;
}

/** Bucket size in seconds for grouping channel (non-thread) messages. 1 hour = one snippet per channel per hour. */
const CHANNEL_MESSAGE_BUCKET_SECONDS = 3600;

/**
 * Deduplicates search matches: one entry per thread (channel_id + thread_ts), or per channel per 1-hour bucket for non-thread messages.
 * @param matches - Raw search matches with channel_id, ts, optional thread_ts.
 * @returns Deduplicated array with thread_ts normalized to string | null.
 */
function dedupeMatches(
  matches: Array<{ channel_id: string; ts: string; thread_ts?: string }>
): Array<{ channel_id: string; ts: string; thread_ts: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ channel_id: string; ts: string; thread_ts: string | null }> = [];
  for (const m of matches) {
    const isThread = m.thread_ts != null && m.thread_ts !== "";
    const key = isThread
      ? `${m.channel_id}:t:${m.thread_ts}`
      : `${m.channel_id}:ch:${Math.floor(parseFloat(m.ts) / CHANNEL_MESSAGE_BUCKET_SECONDS)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      channel_id: m.channel_id,
      ts: m.ts,
      thread_ts: m.thread_ts ?? null,
    });
  }
  return out;
}

/**
 * Sorts matches by timestamp descending (most recent first). Does not mutate the input array.
 * @param list - Array of items with ts.
 * @returns New sorted array.
 */
function sortByTsDesc(
  list: Array<{ channel_id: string; ts: string; thread_ts: string | null }>
): Array<{ channel_id: string; ts: string; thread_ts: string | null }> {
  return [...list].sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));
}

/**
 * Truncates text to a maximum length, appending "..." if truncated.
 * @param text - Input string (trimmed before length check).
 * @param maxLen - Maximum character length.
 * @returns Trimmed string or truncated string + "...".
 */
function truncate(text: string, maxLen: number): string {
  const t = (text || "").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "...";
}

/**
 * Fetches all messages in a thread via conversations.replies (paginated).
 * @param client - Slack Web client.
 * @param channelId - Channel ID containing the thread.
 * @param threadTs - Thread root message ts.
 * @param evaluatedUserId - User ID to mark as the evaluated user (is_evaluated_user).
 * @param userNames - Map of user ID to display name.
 * @param maxMessages - Max messages per API request (limit).
 * @returns Sorted array of ConversationMessage (by ts).
 */
async function fetchThreadReplies(
  client: WebClient,
  channelId: string,
  threadTs: string,
  evaluatedUserId: string,
  userNames: Map<string, string>,
  maxMessages: number
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  let cursor: string | undefined;

  do {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: maxMessages,
      ...(cursor ? { cursor } : {}),
    });

    const list = (res as { messages?: Array<{ user?: string; text?: string; ts?: string }>; response_metadata?: { next_cursor?: string } }).messages ?? [];
    const meta = (res as { response_metadata?: { next_cursor?: string } }).response_metadata;

    for (const msg of list) {
      const uid = msg.user ?? "unknown";
      const name = userNames.get(uid) ?? uid;
      messages.push({
        user_id: uid,
        display_name: name,
        ts: msg.ts ?? "",
        text: truncate(msg.text ?? "", MAX_MESSAGE_LENGTH),
        is_evaluated_user: uid === evaluatedUserId,
      });
    }

    cursor = meta?.next_cursor;
  } while (cursor);

  return messages;
}

/**
 * Fetches a channel history window around a message timestamp (±2 hours), excluding bots and subtypes.
 * @param client - Slack Web client.
 * @param channelId - Channel ID.
 * @param messageTs - Message ts to center the window on.
 * @param evaluatedUserId - User ID to mark as the evaluated user.
 * @param userNames - Map of user ID to display name.
 * @returns Sorted array of ConversationMessage (by ts).
 */
async function fetchChannelContext(
  client: WebClient,
  channelId: string,
  messageTs: string,
  evaluatedUserId: string,
  userNames: Map<string, string>
): Promise<ConversationMessage[]> {
  const tsNum = parseFloat(messageTs);
  const oldest = Math.floor(tsNum) - 3600 * 2; // 2 hours before
  const latest = Math.ceil(tsNum) + 3600 * 2; // 2 hours after

  const res = await client.conversations.history({
    channel: channelId,
    oldest: String(oldest),
    latest: String(latest),
    limit: 200,
  });

  const list = res.messages ?? [];
  const out: ConversationMessage[] = [];

  for (const msg of list) {
    if (msg.bot_id || msg.subtype) continue;
    const uid = msg.user ?? "unknown";
    const name = userNames.get(uid) ?? uid;
    out.push({
      user_id: uid,
      display_name: name,
      ts: msg.ts ?? "",
      text: truncate(msg.text ?? "", MAX_MESSAGE_LENGTH),
      is_evaluated_user: uid === evaluatedUserId,
    });
  }

  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/**
 * Resolves display names for a set of user IDs via users.info. Falls back to the ID if the call fails.
 * @param client - Slack Web client.
 * @param userIds - Set of user IDs to resolve.
 * @returns Map from user ID to display name (real_name or name, or ID).
 */
async function resolveUserNames(
  client: WebClient,
  userIds: Set<string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of userIds) {
    try {
      const u = await client.users.info({ user: id });
      const user = (u as { user?: { real_name?: string; name?: string } }).user;
      const name = user?.real_name ?? user?.name ?? id;
      map.set(id, name);
    } catch {
      map.set(id, id);
    }
  }
  return map;
}

type UniqueMatch = { channel_id: string; ts: string; thread_ts: string | null };

/**
 * Fetches context for one conversation (thread or channel) and builds a single snippet.
 * @param client - Slack Web client.
 * @param u - Unique match (channel_id, ts, thread_ts).
 * @param userId - Evaluated user ID.
 * @param userNames - Map of user ID to display name.
 * @param channelNameById - Map of channel ID to display name (with # if needed).
 * @param workspaceUrl - Optional workspace URL for permalinks.
 * @param maxMessagesPerSnippet - Max messages to fetch per thread.
 * @returns ConversationSnippet or null if the conversation has no messages.
 */
async function fetchOneSnippet(
  client: WebClient,
  u: UniqueMatch,
  userId: string,
  userNames: Map<string, string>,
  channelNameById: Map<string, string>,
  workspaceUrl: string | undefined,
  maxMessagesPerSnippet: number
): Promise<ConversationSnippet | null> {
  let messages: ConversationMessage[];
  if (u.thread_ts) {
    messages = await fetchThreadReplies(
      client,
      u.channel_id,
      u.thread_ts,
      userId,
      userNames,
      maxMessagesPerSnippet
    );
  } else {
    messages = await fetchChannelContext(
      client,
      u.channel_id,
      u.ts,
      userId,
      userNames
    );
  }
  if (messages.length === 0) return null;

  const channelName = channelNameById.get(u.channel_id) ?? u.channel_id;
  const displayName = channelName.startsWith("#") ? channelName : `#${channelName}`;
  const tsForLink = u.thread_ts ?? u.ts;
  const permalink = workspaceUrl
    ? `${workspaceUrl}archives/${u.channel_id}/p${tsForLink.replace(".", "")}`
    : undefined;

  return {
    channel_id: u.channel_id,
    channel_name: displayName,
    thread_ts: u.thread_ts,
    messages,
    permalink,
  };
}

/**
 * Fetches all conversation snippets for the user in the date range: search → dedupe → cap → fetch context (with optional cache and parallel workers).
 * @param client - Slack Web client.
 * @param options - userId, since, until, optional workspaceUrl, maxSnippets, maxMessagesPerSnippet, skipCache.
 * @returns Array of ConversationSnippet (threads and channel context windows), most recent first within cap.
 */
export async function fetchConversationSnippets(
  client: WebClient,
  options: SlackFetchOptions
): Promise<ConversationSnippet[]> {
  const {
    userId,
    since,
    until,
    workspaceUrl,
    maxSnippets = DEFAULT_MAX_SNIPPETS,
    maxMessagesPerSnippet = MAX_MESSAGES_PER_THREAD,
    skipCache = false,
  } = options;

  const { getCacheKey, readSnippetsFromCache, writeSnippetsToCache, isCacheEnabled } = await import("./cache.js");
  if (isCacheEnabled(skipCache)) {
    const cacheKey = getCacheKey(userId, since, until, maxSnippets);
    const cached = readSnippetsFromCache(cacheKey);
    if (cached !== null) {
      console.error(`Using ${cached.length} cached snippet(s) for ${since.toISOString().slice(0, 10)}–${until.toISOString().slice(0, 10)}.`);
      return cached;
    }
  }

  const query = buildSearchQuery(userId, since, until);
  console.error("Searching your messages...");
  const matches = await fetchAllSearchMatches(client, query);
  let unique = dedupeMatches(matches);
  const totalBeforeCap = unique.length;
  unique = sortByTsDesc(unique).slice(0, maxSnippets);
  if (totalBeforeCap > unique.length) {
    console.error(
      `Using ${unique.length} most recent conversation(s) (skipped ${totalBeforeCap - unique.length} older). Set maxSnippets to increase.`
    );
  } else {
    console.error(`Deduped to ${unique.length} conversation(s).`);
  }
  console.error("Resolving user names...");
  const allUserIds = new Set<string>([userId]);
  for (const m of matches) {
    if (m.user) allUserIds.add(m.user);
  }

  const userNames = await resolveUserNames(client, allUserIds);
  const channelNameById = new Map<string, string>();
  for (const m of matches) {
    const name = m.channel_name ?? m.channel_id;
    channelNameById.set(m.channel_id, name.startsWith("#") ? name : `#${name}`);
  }

  const concurrencyEnv = process.env.BRAG_FETCH_CONCURRENCY;
  const concurrency = Math.max(
    1,
    Math.min(32, parseInt(concurrencyEnv ?? String(DEFAULT_FETCH_CONCURRENCY), 10) || DEFAULT_FETCH_CONCURRENCY)
  );
  console.error(`Fetching context for ${unique.length} conversation(s) (concurrency: ${concurrency})...`);

  const snippets: ConversationSnippet[] = [];

  if (concurrency <= 1) {
    for (let i = 0; i < unique.length; i++) {
      const u = unique[i]!;
      const channelLabel = channelNameById.get(u.channel_id) ?? u.channel_id;
      const kind = u.thread_ts ? "thread" : "channel";
      console.error(`  [${i + 1}/${unique.length}] ${channelLabel} (${kind})`);
      const snippet = await fetchOneSnippet(
        client,
        u,
        userId,
        userNames,
        channelNameById,
        workspaceUrl,
        maxMessagesPerSnippet
      );
      if (snippet) snippets.push(snippet);
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_SNIPPET_FETCHES_MS));
    }
  } else {
    const results: (ConversationSnippet | null)[] = new Array(unique.length);
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (true) {
        const i = nextIndex++;
        if (i >= unique.length) break;
        const u = unique[i]!;
        const snippet = await fetchOneSnippet(
          client,
          u,
          userId,
          userNames,
          channelNameById,
          workspaceUrl,
          maxMessagesPerSnippet
        );
        results[i] = snippet;
      }
    };
    const workers = Array.from(
      { length: Math.min(concurrency, unique.length) },
      () => runWorker()
    );
    await Promise.all(workers);
    for (const s of results) {
      if (s) snippets.push(s);
    }
  }

  if (isCacheEnabled(skipCache)) {
    const cacheKey = getCacheKey(userId, since, until, maxSnippets);
    writeSnippetsToCache(cacheKey, snippets);
    console.error(`Cached ${snippets.length} snippet(s) for ${since.toISOString().slice(0, 10)}–${until.toISOString().slice(0, 10)}.`);
  }

  return snippets;
}
