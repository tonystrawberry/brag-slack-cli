# Brag Slack CLI

Generate a **brag summary** from your Slack participation over a set period and turn it into a narrative suitable for performance evaluations.

## How it works

**High level:** Search your Slack messages → deduplicate and cap → fetch full context in parallel → split into calendar weeks → summarize each week with Gemini → merge into one brag doc.

### 1. Search and deduplication

- **Search**: Uses Slack `search.messages` with your user token, paginating through all results so nothing is dropped (e.g. across many channels).
- **Trivial filter**: Drops matches where the message text is 2 characters or less (e.g. "ok", "👍") to avoid noise.
- **Deduplication**:
  - **Threads**: One entry per `(channel_id, thread_ts)` so the same thread isn’t summarized multiple times.
  - **Channel messages**: Grouped by **1-hour bucket** per channel so many messages in the same channel in a short window become one “snippet” instead of dozens.
- **Cap**: Keeps the **N most recent** conversation snippets (default 200, set via `BRAG_MAX_SNIPPETS`) to limit API usage and context size.

### 2. Fetching context (parallel)

- For each unique conversation (thread or channel bucket), the app fetches **full context**: either all thread replies or a channel history window around your message, so short replies like "LGTM" or "Done" can be interpreted correctly.
- **Parallel fetches**: By default up to **8** snippet fetches run at once (`BRAG_FETCH_CONCURRENCY`). Use `1` for strictly sequential (e.g. if you hit rate limits).

### 3. Caching

- With **`BRAG_CACHE=1`** (or `true`), fetched snippets are stored on disk in **`.brag-cache/`**.
- **Cache key** = hash of `userId`, week start, week end, and `maxSnippets`, so the same calendar week always reuses the same cache entry.
- **Stable weeks**: The app splits the date range into **Monday–Sunday calendar weeks**. So whether you use `--last 30d` or `--since` / `--until`, the same week (e.g. 2026-02-10–16) always has the same boundaries and thus the same cache key. Re-runs for overlapping periods hit the cache and only re-run the summarize/merge step.
- Use **`--no-cache`** to force a fresh fetch from Slack.

### 4. Summarize and merge

- The period is split into **full calendar weeks** (Mon–Sun). For each week with snippets, the app calls Gemini to produce a **weekly brag summary** (no “Conversations analyzed” section at this stage).
- A final **merge** call combines all weekly summaries into one narrative without omitting content, so you get a single coherent doc.
- Output is Markdown (and optionally a “Conversations analyzed” section with channel list and Slack links if you pass **`--sources`**).

## Main libraries

- **[@slack/web-api](https://github.com/slackapi/node-slack-sdk)** – Official Slack Node SDK. Used for authenticated API calls: `search.messages` (find your messages), `conversations.replies` (thread context), `conversations.history` (channel context), `users.info` / `users.lookupByEmail`, and `auth.test` (resolve current user and workspace URL).
- **[@google/genai](https://github.com/google/generative-ai-js)** – Google Gemini API client. Used to generate the brag summary from conversation snippets (per-week summaries and the final merge) with configurable model (default `gemini-2.0-flash`), temperature, and max output tokens.
- **[commander](https://github.com/tj/commander.js)** – CLI framework. Parses `--since`, `--until`, `--last`, `--output`, `--lang`, `--no-cache`, `--sources`, `--stdout`, and `--format` and runs the main workflow.

The app is written in **TypeScript** and runs as ESM (`"type": "module"`).

## Setup

1. **Clone and install**

   ```bash
   cd brag-slack-bot && npm install && npm run build
   ```

2. **Slack app and token**

   - Create a [Slack app](https://api.slack.com/apps) (or use an existing one).
   - Add a **user** OAuth scope (not only bot) so you can search as yourself:
     - `search:read`
     - `channels:history`
     - `groups:history`
     - `im:history`
     - `mpim:history`
     - `users:read`
   - Install the app to your workspace and copy the **OAuth token** (starts with `xoxp-`).

3. **Environment**

   Copy `.env.example` to `.env` and set the required variables. All supported variables:

   | Variable | Required | Description | Default |
   |----------|----------|-------------|---------|
   | `SLACK_USER_TOKEN` | Yes* | Slack user OAuth token (`xoxp-...`) for searching as yourself. | — |
   | `SLACK_BOT_TOKEN` | Yes* | Alternative to `SLACK_USER_TOKEN` (bot token). One of the two must be set. | — |
   | `GEMINI_API_KEY` | Yes | Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). | — |
   | `BRAG_SLACK_EMAIL` | No | Your Slack email; used to resolve "you" when `auth.test` doesn’t (e.g. with a bot token). | — |
   | `BRAG_LLM_MODEL` | No | Gemini model name for summaries and merge. | `gemini-2.0-flash` |
   | `BRAG_MAX_SNIPPETS` | No | Max conversation snippets to fetch (most recent first). | `200` |
   | `BRAG_CACHE` | No | Set to `1` or `true` to cache snippets in `.brag-cache/`. | off |
   | `BRAG_LANG` | No | Output language: `en` or `ja`. Overridable by `--lang`. | `en` |
   | `BRAG_FETCH_CONCURRENCY` | No | Max concurrent snippet fetches (1 = sequential). | `8` |

## Usage

You must provide either **`--last`** or both **`--since`** and **`--until`** to set the date range.

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--since <date>` | Start date (YYYY-MM-DD). Use with `--until`. | — |
| `--until <date>` | End date (YYYY-MM-DD). Use with `--since`. | — |
| `--last <period>` | Shorthand: last N days or weeks, e.g. `30d`, `7d`, `2w`. | — |
| `-o, --output <path>` | Output file path. | `output/brag-summary-<since>-to-<until>.md` |
| `--stdout` | Print summary to stdout instead of writing a file. | off |
| `--format <format>` | Output format: `markdown` or `html`. | `markdown` |
| `--no-cache` | Bypass snippet cache and fetch from Slack. | off (cache used if `BRAG_CACHE=1`) |
| `--lang <code>` | Output language: `en` or `ja`. | `en` |
| `--sources` | Append "Conversations analyzed" section (channel list + Slack links). | off |

All environment variables are listed in **Setup → Environment** (see also `.env.example`).

### Examples

**Last 30 days (write to default path `output/brag-summary-...md`):**

```bash
npm run brag -- --last 30d
```

**Custom date range:**

```bash
npm run brag -- --since 2025-02-01 --until 2025-03-14
```

**Write to a specific file:**

```bash
npm run brag -- --last 7d -o my-brag.md
```

**Print to stdout:**

```bash
npm run brag -- --last 14d --stdout
```

**Japanese output, no cache, with channel links:**

```bash
npm run brag -- --last 30d --lang ja --no-cache --sources
```

**HTML format to a custom path:**

```bash
npm run brag -- --since 2025-01-01 --until 2025-03-01 --format html -o output/review.html
```

## Output

By default the app writes a Markdown file to the **`output/`** folder (e.g. `output/brag-summary-2025-02-01-to-2025-03-14.md`) with sections like:

- Key contributions  
- Collaborations & support  
- Decisions & outcomes  

All claims are derived from the conversation snippets; the model is instructed not to invent facts.

## Security

- Do not commit `.env` or share your Slack or Gemini API keys.
- Use the minimum Slack scopes needed; the app only reads messages and resolves users.
