# Brag Slack Bot

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

   Copy `.env.example` to `.env` and set:

   - `SLACK_USER_TOKEN` – your Slack user OAuth token (`xoxp-...`).
   - `GEMINI_API_KEY` – your Gemini API key (from [Google AI Studio](https://aistudio.google.com/apikey)).

   Optional:

   - `BRAG_SLACK_EMAIL` – if you use a bot token or `auth.test` doesn’t identify you, set your Slack email so the app can resolve "you."
   - `BRAG_LLM_MODEL` – Gemini model (default: `gemini-2.0-flash`).

## Usage

**Last 30 days (output to default file):**

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

**Options:** `--lang en|ja`, `--sources` (append channel list + Slack links), `--no-cache` (bypass snippet cache). See `.env.example` for `BRAG_CACHE`, `BRAG_MAX_SNIPPETS`, `BRAG_FETCH_CONCURRENCY`, and `BRAG_LANG`.

## Output

By default the app writes a Markdown file to the **`output/`** folder (e.g. `output/brag-summary-2025-02-01-to-2025-03-14.md`) with sections like:

- Key contributions  
- Collaborations & support  
- Decisions & outcomes  

All claims are derived from the conversation snippets; the model is instructed not to invent facts.

## Security

- Do not commit `.env` or share your Slack or Gemini API keys.
- Use the minimum Slack scopes needed; the app only reads messages and resolves users.
