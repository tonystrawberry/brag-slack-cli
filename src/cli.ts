#!/usr/bin/env node
import { program } from "commander";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSlackClient, resolveCurrentUser, fetchConversationSnippets } from "./slack.js";
import { generateBragSummary, mergeWeeklySummaries, buildSourcesSection } from "./summarize.js";
import type { ConversationSnippet } from "./types.js";

/**
 * Parses a --last period (e.g. "30d", "2w") into since/until dates relative to now.
 * @param value - Period string: N followed by "d" (days) or "w" (weeks), e.g. "7d", "2w".
 * @returns Object with since and until Date values.
 * @throws Error if value is invalid (not a positive number or missing d/w suffix).
 */
function parseLast(value: string): { since: Date; until: Date } {
  const now = new Date();
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new Error(`Invalid --last value: ${value}. Use e.g. 7d or 30d.`);
  }
  const until = new Date(now);
  const since = new Date(now);
  if (value.endsWith("d")) {
    since.setDate(since.getDate() - n);
  } else if (value.endsWith("w")) {
    since.setDate(since.getDate() - n * 7);
  } else {
    since.setDate(since.getDate() - n);
  }
  return { since, until };
}

/**
 * Parses --since and --until date strings into Date objects.
 * @param sinceStr - Start date (YYYY-MM-DD or parseable by Date).
 * @param untilStr - End date (YYYY-MM-DD or parseable by Date).
 * @returns Object with since and until Date values.
 * @throws Error if dates are invalid or since >= until.
 */
function parseDates(sinceStr: string, untilStr: string): { since: Date; until: Date } {
  const since = new Date(sinceStr);
  const until = new Date(untilStr);
  if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since date: ${sinceStr}`);
  if (Number.isNaN(until.getTime())) throw new Error(`Invalid --until date: ${untilStr}`);
  if (since >= until) throw new Error("--since must be before --until");
  return { since, until };
}

/** Monday = 1 in JS getDay(); days back to reach Monday. */
const MONDAY_GET_DAY = 1;

/**
 * Returns Monday 00:00:00 of the calendar week containing the given date (ISO week: Mon–Sun).
 * @param date - Any date in the week.
 * @returns New Date set to that week's Monday at midnight (local time).
 */
function getMondayOnOrBefore(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const daysToMonday = day === 0 ? 6 : day - MONDAY_GET_DAY;
  d.setDate(d.getDate() - daysToMonday);
  return d;
}

/**
 * Splits a date range into full calendar weeks (Monday–Sunday). Same week always has the same start/end so cache keys are stable regardless of --last vs --since/--until.
 * @param since - Start of the requested range.
 * @param until - End of the requested range.
 * @returns Array of { start, end } for each week that overlaps [since, until]; each start is Monday 00:00:00, each end is Sunday 23:59:59.
 */
function getWeekBoundaries(since: Date, until: Date): Array<{ start: Date; end: Date }> {
  const weeks: Array<{ start: Date; end: Date }> = [];
  const sinceDay = new Date(since);
  sinceDay.setHours(0, 0, 0, 0);
  const untilEnd = new Date(until);
  untilEnd.setHours(23, 59, 59, 999);

  let weekStart = getMondayOnOrBefore(sinceDay);
  while (weekStart <= untilEnd) {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    if (weekEnd < sinceDay) {
      weekStart.setDate(weekStart.getDate() + 7);
      continue;
    }
    weeks.push({ start: new Date(weekStart), end: weekEnd });
    weekStart.setDate(weekStart.getDate() + 7);
  }
  return weeks;
}

/**
 * Loads .env from the current working directory into process.env. Does not override existing env vars. No-op if file is missing or unreadable.
 */
function loadEnv(): void {
  try {
    const path = resolve(process.cwd(), ".env");
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = value;
      }
    }
  } catch {
    // .env optional
  }
}

program
  .name("brag")
  .description("Generate a brag summary from your Slack participation for performance evaluations")
  .option("--since <date>", "Start date (YYYY-MM-DD)")
  .option("--until <date>", "End date (YYYY-MM-DD)")
  .option("--last <period>", "Last N days or weeks (e.g. 30d, 2w)")
  .option("-o, --output <path>", "Output file path (default: brag-summary-<date>.md)")
  .option("--stdout", "Print summary to stdout instead of writing a file")
  .option("--format <format>", "Output format: markdown | html", "markdown")
  .option("--no-cache", "Ignore cache and fetch from Slack")
  .option("--lang <code>", "Output language: en | ja", "en")
  .option("--sources", "Append 'Conversations analyzed' section with channel list and Slack links")
  .action(async (opts) => {
    loadEnv();

    let since: Date;
    let until: Date;
    if (opts.last) {
      const parsed = parseLast(opts.last);
      since = parsed.since;
      until = parsed.until;
    } else if (opts.since && opts.until) {
      const parsed = parseDates(opts.since, opts.until);
      since = parsed.since;
      until = parsed.until;
    } else {
      console.error("Provide either --since and --until, or --last (e.g. --last 30d).");
      process.exit(1);
    }

    const client = createSlackClient();
    console.error("Resolving current user...");
    const { user_id: userId, workspace_url: workspaceUrl } = await resolveCurrentUser(client);
    const maxSnippetsEnv = process.env.BRAG_MAX_SNIPPETS;
    const maxSnippets = maxSnippetsEnv ? parseInt(maxSnippetsEnv, 10) : undefined;
    const slackOptions = {
      userId,
      since,
      until,
      workspaceUrl,
      ...(Number.isInteger(maxSnippets) && maxSnippets! > 0 ? { maxSnippets } : {}),
      skipCache: opts.cache === false,
    };

    const lang = (opts.lang ?? process.env.BRAG_LANG ?? "en").toLowerCase();

    const weeks = getWeekBoundaries(since, until);
    console.error(`Splitting period into ${weeks.length} week(s). Summarizing each week, then merging.`);

    const allSnippets: ConversationSnippet[] = [];
    const weeklySummaries: string[] = [];

    for (let i = 0; i < weeks.length; i++) {
      const { start: weekStart, end: weekEnd } = weeks[i]!;
      const weekLabel = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`;
      console.error(`\n--- Week ${i + 1}/${weeks.length}: ${weekLabel} ---`);
      const snippets = await fetchConversationSnippets(client, { ...slackOptions, since: weekStart, until: weekEnd });
      allSnippets.push(...snippets);
      if (snippets.length > 0) {
        console.error(`Summarizing week ${i + 1} (${snippets.length} snippet(s))...`);
        const weekSummary = await generateBragSummary(snippets, weekStart, weekEnd, {
          omitSources: true,
          language: lang,
        });
        weeklySummaries.push(weekSummary);
      } else {
        const noMessages =
          lang === "ja"
            ? "この週にSlackメッセージは見つかりませんでした。"
            : "No Slack messages found for this week.";
        weeklySummaries.push(`# Week ${i + 1} (${weekLabel})\n\n${noMessages}`);
      }
    }

    const channelNames = [...new Set(allSnippets.map((s) => s.channel_name))].sort();
    console.error(`\nAnalyzed channels (${channelNames.length}): ${channelNames.join(", ")}`);
    console.error(`Total snippet(s): ${allSnippets.length}. Merging ${weeklySummaries.length} weekly summaries...`);

    let markdown: string;
    if (weeklySummaries.length === 1) {
      markdown = weeklySummaries[0]!;
      if (opts.sources && allSnippets.length > 0) {
        markdown = `${markdown}\n\n---\n\n${buildSourcesSection(allSnippets, lang)}`;
      }
    } else {
      markdown = await mergeWeeklySummaries(weeklySummaries, since, until, lang);
      if (opts.sources && allSnippets.length > 0) {
        markdown = `${markdown}\n\n---\n\n${buildSourcesSection(allSnippets, lang)}`;
      }
    }

    if (opts.stdout) {
      process.stdout.write(markdown);
      return;
    }

    const defaultFileName = `brag-summary-${since.toISOString().slice(0, 10)}-to-${until.toISOString().slice(0, 10)}.md`;
    const outPath =
      opts.output ?? resolve(process.cwd(), "output", defaultFileName);
    const outDir = resolve(outPath, "..");
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }
    writeFileSync(outPath, markdown, "utf-8");
    console.error(`Wrote ${outPath}`);
  });

program.parse();
