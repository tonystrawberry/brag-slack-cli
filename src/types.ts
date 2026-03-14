/**
 * A single message in a conversation with resolved display name and evaluated-user flag.
 */
export interface ConversationMessage {
  /** Slack user ID of the sender. */
  user_id: string;
  /** Resolved display name (real_name or name from users.info). */
  display_name: string;
  /** Slack message timestamp. */
  ts: string;
  /** Message text (may be truncated). */
  text: string;
  /** True if this message is from the user being evaluated. */
  is_evaluated_user: boolean;
}

/**
 * One conversation snippet: either a full thread or a channel context window around a message.
 */
export interface ConversationSnippet {
  /** Slack channel ID. */
  channel_id: string;
  /** Channel display name (e.g. #channel-name). */
  channel_name: string;
  /** Thread root ts, or null for a channel (non-thread) snippet. */
  thread_ts: string | null;
  /** Messages in this snippet, sorted by ts. */
  messages: ConversationMessage[];
  /** Slack permalink to the thread or message (when workspace URL is available). */
  permalink?: string;
}

/**
 * Options for fetching Slack conversation snippets in a date range.
 */
export interface SlackFetchOptions {
  /** Slack user ID to search and mark as evaluated. */
  userId: string;
  /** Start of date range (inclusive). */
  since: Date;
  /** End of date range (inclusive). */
  until: Date;
  /** Workspace URL (e.g. from auth.test) for building message/thread permalinks. */
  workspaceUrl?: string;
  /** Max conversation snippets to fetch context for (most recent first). Reduces API calls and context size. */
  maxSnippets?: number;
  /** Max messages to fetch per thread (conversations.replies limit). */
  maxMessagesPerSnippet?: number;
  /** Max character length per message (truncation). */
  maxMessageLength?: number;
  /** If true, do not read from or write to the snippet cache (overrides BRAG_CACHE). */
  skipCache?: boolean;
}

/**
 * Parsed options from the brag CLI (dates, output, format, etc.).
 */
export interface CliOptions {
  /** Start date string (e.g. YYYY-MM-DD). */
  since: string;
  /** End date string (e.g. YYYY-MM-DD). */
  until: string;
  /** Optional shorthand period (e.g. "30d", "2w"). */
  last?: string;
  /** Optional output file path. */
  output?: string;
  /** If true, print summary to stdout instead of writing a file. */
  stdout: boolean;
  /** Output format: "markdown" or "html". */
  format: "markdown" | "html";
}
