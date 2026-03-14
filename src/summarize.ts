import { GoogleGenAI } from "@google/genai";
import type { ConversationSnippet } from "./types.js";

const DEFAULT_MODEL = "gemini-2.0-flash";
const EVALUATED_LABEL = "[EVALUATED USER]";

/** Language instructions for the LLM. */
const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  en: "Write the entire summary in English.",
  ja: "Write the entire summary in Japanese (日本語). Use Japanese for all section headings, bullets, and body text.",
};

/**
 * Creates a GoogleGenAI client using GEMINI_API_KEY from the environment.
 * @returns Configured GoogleGenAI instance.
 * @throws Error if GEMINI_API_KEY is not set.
 */
function getGemini(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY. Set it in .env to generate the brag summary.");
  }
  return new GoogleGenAI({ apiKey: key });
}

/**
 * Formats a single conversation snippet as a Markdown block for the LLM prompt (header + bullet list of messages).
 * @param snippet - One thread or channel context snippet.
 * @returns Multi-line string with "## Thread/Channel: name" and "- Speaker: text" lines.
 */
function formatSnippet(snippet: ConversationSnippet): string {
  const lines: string[] = [];
  const header = snippet.thread_ts
    ? `## Thread: ${snippet.channel_name}`
    : `## Channel: ${snippet.channel_name} (context)`;
  lines.push(header);
  for (const msg of snippet.messages) {
    const speaker = msg.is_evaluated_user
      ? `${msg.display_name} ${EVALUATED_LABEL}`
      : msg.display_name;
    const text = (msg.text || "").trim().replace(/\n/g, " ");
    if (text) {
      lines.push(`- ${speaker}: ${text}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Builds the full prompt sent to the LLM for a single week's brag summary.
 * @param snippets - Conversation snippets for the period.
 * @param since - Start of the period.
 * @param until - End of the period.
 * @param lang - Language code (e.g. "en", "ja") for output language instruction.
 * @returns The prompt string (instruction + snippets + format requirements).
 */
function buildPrompt(
  snippets: ConversationSnippet[],
  since: Date,
  until: Date,
  lang: string = "en"
): string {
  const dateRange = `${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`;
  const snippetBlocks = snippets.map(formatSnippet).join("\n");
  const langInstruction = LANGUAGE_INSTRUCTIONS[lang] ?? LANGUAGE_INSTRUCTIONS.en;

  return `You are writing a detailed self-evaluation / "brag" summary for a performance review. Below are conversation snippets from Slack where the person being evaluated participated (their messages are marked with ${EVALUATED_LABEL}). Use ONLY these snippets; infer meaning from context (e.g. "LGTM" in a code-review thread = they approved the change, "Done" in an incident thread = they resolved it). Do not invent facts; if context is unclear, summarize neutrally or skip.

${langInstruction}

Time period: ${dateRange}

--- CONVERSATION SNIPPETS ---

${snippetBlocks}

--- END SNIPPETS ---

Write a **long, in-depth** brag summary in Markdown. **Do not be concise or shallow.** Aim for a rich, detailed narrative that would satisfy a thorough performance review.

1. **Opening**: Write a full paragraph (4–6 sentences) summarizing their overall impact, main projects, and areas of contribution. Reference specific initiatives or themes visible in the snippets.

2. **Sections**: Use clear headings. For each section:
   - Include **many** bullets (do not collapse or summarize away detail). Each bullet should be a **substantial paragraph**: 3–6 sentences minimum.
   - For every bullet: give **context** (situation, project, or problem), **what they did** (specific actions, decisions, code/features, ownership), and **outcome or impact** (unblocked, shipped, resolved, improved). Name specific channels, features, tools, and people when they appear in the snippets.
   - Use sub-bullets where one initiative has multiple distinct actions or outcomes. Do not merge related but separate contributions into a single short line.

3. **Suggested sections** (expand these and add more if the data supports it):
   - **Key contributions** (feature work, technical ownership, releases, investigations, migrations, refactors)
   - **Collaborations & support** (mentorship, onboarding, unblocking others, knowledge sharing, pairing, reviews)
   - **Decisions & outcomes** (reviews, approvals, process changes, coordination, technical decisions)
   Add subsections or extra sections (e.g. **Incidents & stability**, **Documentation & process**) when the snippets justify it.

4. **Closing**: Write a full paragraph (3–5 sentences) on recurring themes, strengths, and overall impact visible across the period.

Base every claim on the snippets above. Output only the Markdown, no preamble.`;
}

/**
 * Options for generateBragSummary.
 */
export interface GenerateBragOptions {
  /** When true, do not append the "Conversations analyzed" section (e.g. for weekly summaries to be merged). */
  omitSources?: boolean;
  /** Output language code (e.g. "en", "ja"). Default "en". */
  language?: string;
}

/**
 * Generates a brag summary from conversation snippets using Gemini.
 * @param snippets - Conversation snippets for the period.
 * @param since - Start of the period.
 * @param until - End of the period.
 * @param options - Optional: omitSources (skip "Conversations analyzed" block), language (e.g. "en", "ja").
 * @returns Markdown string: brag narrative and optionally the sources section.
 */
export async function generateBragSummary(
  snippets: ConversationSnippet[],
  since: Date,
  until: Date,
  options?: GenerateBragOptions
): Promise<string> {
  const lang = options?.language ?? "en";
  const emptyMsg =
    lang === "ja"
      ? "この期間にSlackメッセージは見つかりませんでした。"
      : "No Slack messages found for this period.";
  if (snippets.length === 0) {
    return `# Brag summary (${since.toISOString().slice(0, 10)} – ${until.toISOString().slice(0, 10)})\n\n${emptyMsg}`;
  }

  const model = process.env.BRAG_LLM_MODEL ?? DEFAULT_MODEL;
  const ai = getGemini();
  const prompt = buildPrompt(snippets, since, until, lang);

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.3,
      maxOutputTokens: 16384,
    },
  });

  const content = (response as { text?: string }).text?.trim();
  if (!content) {
    throw new Error("Gemini returned an empty response.");
  }

  if (options?.omitSources) {
    return content;
  }
  const sourcesSection = buildSourcesSection(snippets, lang);
  return sourcesSection ? `${content}\n\n---\n\n${sourcesSection}` : content;
}

/**
 * Merges multiple weekly brag summaries into one coherent summary without dropping content.
 * @param weeklySummaries - Array of Markdown summaries (one per week).
 * @param since - Start of the full period.
 * @param until - End of the full period.
 * @param language - Language code (e.g. "en", "ja") for the merged output.
 * @returns Single Markdown brag summary combining all weeks.
 */
export async function mergeWeeklySummaries(
  weeklySummaries: string[],
  since: Date,
  until: Date,
  language: string = "en"
): Promise<string> {
  const lang = language;
  const noContentMsg =
    lang === "ja" ? "マージする内容がありません。" : "No content to merge.";
  if (weeklySummaries.length === 0) {
    return `# Brag summary (${since.toISOString().slice(0, 10)} – ${until.toISOString().slice(0, 10)})\n\n${noContentMsg}`;
  }
  if (weeklySummaries.length === 1) {
    return weeklySummaries[0]!;
  }

  const dateRange = `${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`;
  const blocks = weeklySummaries.map(
    (s, i) => `--- WEEK ${i + 1} ---\n\n${s}\n`
  ).join("\n");
  const langInstruction = LANGUAGE_INSTRUCTIONS[lang] ?? LANGUAGE_INSTRUCTIONS.en;

  const mergePrompt = `You are merging brag summaries that were written week-by-week for the same person. Below are ${weeklySummaries.length} weekly summaries for the period ${dateRange}. Your task is to produce a single, comprehensive brag summary that:

1. **Does not omit anything**: Every contribution, outcome, collaboration, or decision mentioned in any weekly summary must appear in the merged summary. Combine only when they refer to the exact same action; otherwise keep as separate, detailed bullets. Do not shorten or condense bullets into one-liners.
2. **Uses the same structure**: Keep clear sections (e.g. Key contributions, Collaborations & support, Decisions & outcomes). Use subsections and sub-bullets where appropriate. Preserve the level of detail from the weekly summaries—do not summarize away content.
3. **Reads as one narrative**: Write a full opening paragraph (4–6 sentences) for the full period, then the merged sections with substantial bullets (3–6 sentences each where the source had detail). Add a full closing paragraph (3–5 sentences). Do not say "in week 1..." or "in week 2..."; integrate everything into a single, thorough narrative. The merged output should be long and rich, not a shortened digest.
4. **Output only the Markdown**: No preamble or meta-commentary.

--- WEEKLY SUMMARIES ---

${blocks}

--- END WEEKLY SUMMARIES ---

${langInstruction}
Produce the merged brag summary in Markdown.`;

  const model = process.env.BRAG_LLM_MODEL ?? DEFAULT_MODEL;
  const ai = getGemini();
  const response = await ai.models.generateContent({
    model,
    contents: mergePrompt,
    config: {
      temperature: 0.2,
      maxOutputTokens: 16384,
    },
  });

  const merged = (response as { text?: string }).text?.trim();
  if (!merged) {
    throw new Error("Gemini returned an empty response when merging.");
  }
  return merged;
}

const SOURCES_HEADING: Record<string, string> = {
  en: "Conversations analyzed",
  ja: "分析した会話",
};

/**
 * Builds the "Conversations analyzed" section: heading, channel list, and per-snippet Slack links.
 * @param snippets - Snippets to list (channel names and permalinks).
 * @param lang - Language code for section heading and labels (e.g. "en", "ja").
 * @returns Markdown string for the sources section, or empty string if no snippets.
 */
export function buildSourcesSection(
  snippets: ConversationSnippet[],
  lang: string = "en"
): string {
  if (snippets.length === 0) return "";
  const heading = SOURCES_HEADING[lang] ?? SOURCES_HEADING.en;
  const channelNames = [...new Set(snippets.map((s) => s.channel_name))].sort();
  const channelsLabel = lang === "ja" ? "チャンネル" : "Channels";
  const lines = [
    `## ${heading}`,
    "",
    `**${channelsLabel}:** ` + channelNames.join(", "),
    "",
  ];
  for (const s of snippets) {
    const label = s.thread_ts ? `${s.channel_name} (thread)` : s.channel_name;
    if (s.permalink) {
      lines.push(`- **${label}**: [Open in Slack](${s.permalink})`);
    } else {
      lines.push(`- **${label}**`);
    }
  }
  return lines.join("\n");
}
