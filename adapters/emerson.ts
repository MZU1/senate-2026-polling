import type { RawPollRecord, RaceId, PopulationType } from "../types/poll";
import type { PollAdapter } from "./base";
import { AdapterError } from "./base";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

// ============================================================================
// Emerson College Polling has no public API (checked — see README). This adapter
// parses their own press-release pages, e.g. https://emersoncollegepolling.com/iowa-2026-poll/
//
// The candidate/percentage extraction below is tested against a REAL fetched page
// (test/fixtures/emerson-iowa-2026.txt, fetched 2026-08-21) — see test/emerson.test.ts.
// It is NOT tested against Emerson's full historical archive, so treat the regexes as
// "known to work for this page's phrasing," not "guaranteed for every future release."
// If Emerson changes their write-up style, this adapter needs updating — that's an
// expected, ordinary maintenance cost of source-page parsing, which is exactly why
// official_api / official_feed are preferred whenever they exist (see base.ts).
// ============================================================================

const NUMBER_WORDS: Record<string, number> = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17,
  eighteen:18, nineteen:19, twenty:20,
};
function parseNumberWord(s: string): number | null {
  const digit = s.match(/^\d+(\.\d+)?$/);
  if (digit) return parseFloat(s);
  const w = NUMBER_WORDS[s.toLowerCase()];
  return w === undefined ? null : w;
}
function partyFromWord(w: string): "D" | "R" | "I" {
  const lw = w.toLowerCase();
  if (lw.startsWith("republican")) return "R";
  if (lw.startsWith("democrat")) return "D";
  return "I";
}

/** Pulls the publish timestamp out of the page's own meta block. */
function extractPublishedAt(text: string): string | null {
  const m = text.match(/meta-article:published_time:\s*([0-9T:+\-.Z]+)/);
  return m ? m[1] : null;
}

/** Pulls "X% support PARTY NAME, while Y% support PARTY NAME. Z percent are undecided" out of a
 *  window of text following a "U.S. Senate" mention. The candidate/party/share sub-pattern is
 *  the original, tested-against-Iowa pattern, unchanged. What changed is *where* we look for it:
 *  originally this required the literal prefix "for U.S. Senate," immediately before the first
 *  percentage (true for Iowa's "In the race for U.S. Senate, 48% support..."), but Emerson's own
 *  Texas release phrases the identical fact differently — "...finds the U.S. Senate race in a
 *  dead heat: 47% support..." — no "for", different connector before the number. Rather than
 *  add a second full sentence-pattern (risking a misattribution bug on any phrasing that states
 *  a lead as "X to Y" without repeating "support ... NAME" for each candidate, e.g. some other
 *  Emerson releases), we scan forward from every "U.S. Senate" occurrence and try the same
 *  unambiguous NAME-adjacent-to-share pattern within a bounded window — still requires each
 *  candidate's share to sit directly next to "support PARTY NAME", so it can't swap who a number
 *  belongs to. Verified against two real, live-fetched releases (Iowa, Texas); see
 *  test/emerson.test.ts and test/fixtures/emerson-texas-2026.txt. */
const SUPPORT_PAIR_RE = /(\d+(?:\.\d+)?)%\s+support\s+(Republican|Democrat(?:ic)?|Independent)\s+([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)*)\s*,?\s+while\s+(\d+(?:\.\d+)?)%\s+support\s+(Republican|Democrat(?:ic)?|Independent)\s+([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)*)\s*\.\s*([A-Za-z]+|\d+)\s+percent\s+(?:are|is)\s+undecided/i;
const SENATE_ANCHOR_RE = /U\.S\.\s*Senate/gi;
const SENATE_WINDOW_CHARS = 400;

function extractSenateRace(text: string): { candidates: RawPollRecord["candidates"]; undecidedShare: number | null; rawExcerpt: string } | null {
  SENATE_ANCHOR_RE.lastIndex = 0;
  let anchor: RegExpExecArray | null;
  while ((anchor = SENATE_ANCHOR_RE.exec(text)) !== null) {
    const window = text.slice(anchor.index, anchor.index + SENATE_WINDOW_CHARS);
    const m = window.match(SUPPORT_PAIR_RE);
    if (m) {
      const [, share1, party1, name1, share2, party2, name2, undecidedRaw] = m;
      return {
        candidates: [
          { name: name1.trim(), party: partyFromWord(party1), share: parseFloat(share1) },
          { name: name2.trim(), party: partyFromWord(party2), share: parseFloat(share2) },
        ],
        undecidedShare: parseNumberWord(undecidedRaw),
        rawExcerpt: m[0],
      };
    }
  }
  return null;
}

/** "conducted August 2-4, 2026" -> { fieldStart: 2026-08-02, fieldEnd: 2026-08-04 } */
function extractFieldDates(text: string): { fieldStart: string | null; fieldEnd: string | null } {
  const months: Record<string,string> = { january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12" };
  const m = text.match(/conducted\s+([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})/i);
  if (!m) return { fieldStart: null, fieldEnd: null };
  const [, monthName, d1, d2, year] = m;
  const mm = months[monthName.toLowerCase()];
  if (!mm) return { fieldStart: null, fieldEnd: null };
  const pad = (d: string) => d.padStart(2, "0");
  return { fieldStart: `${year}-${mm}-${pad(d1)}`, fieldEnd: `${year}-${mm}-${pad(d2)}` };
}

/** "n=712" + "credibility interval ... of +/- 3.7 percent" + "likely voters" */
function extractSample(text: string): { sampleSize: number | null; population: PopulationType; marginOfError: number | null } {
  const nMatch = text.match(/n\s*=\s*(\d[\d,]*)/i);
  const sampleSize = nMatch ? parseInt(nMatch[1].replace(/,/g, ""), 10) : null;
  const moeMatch = text.match(/\+\/-\s*(\d+(?:\.\d+)?)\s*percent/i);
  const marginOfError = moeMatch ? parseFloat(moeMatch[1]) : null;
  let population: PopulationType = "unknown";
  if (/likely voters/i.test(text)) population = "LV";
  else if (/registered voters/i.test(text)) population = "RV";
  return { sampleSize, population, marginOfError };
}

export function parseEmersonPost(text: string, sourceUrl: string, race: { raceId: RaceId; geographicId: string | null }): RawPollRecord {
  const senate = extractSenateRace(text);
  if (!senate) {
    throw new AdapterError("emerson", `Could not find a U.S. Senate result sentence in ${sourceUrl}`);
  }
  const { fieldStart, fieldEnd } = extractFieldDates(text);
  const { sampleSize, population, marginOfError } = extractSample(text);
  return {
    pollsterId: "emerson",
    sponsor: /Nexstar Media/i.test(text) ? "Nexstar Media" : undefined,
    sourceUrl,
    race: { raceId: race.raceId, geographicId: race.geographicId, chamber: "senate" },
    fieldStart, fieldEnd,
    publishedAt: extractPublishedAt(text),
    sampleSize, population, marginOfError,
    candidates: senate.candidates,
    undecidedShare: senate.undecidedShare,
    otherShare: null,
    rawExcerpt: senate.rawExcerpt,
  };
}

/**
 * Live fetchLatestPolls: this part is NOT exercised by the test suite (it needs real network
 * access this environment doesn't have at runtime). It's written to real, current fetch()
 * semantics so it's ready to run once deployed — see README "What's real vs. scaffold."
 */
export const emersonAdapter: PollAdapter = {
  pollsterId: "emerson",
  async fetchLatestPolls(race) {
    if (!race.geographicId) return [];
    const stateSlug = STATE_SLUG[race.geographicId];
    if (!stateSlug) return [];
    const url = `https://emersoncollegepolling.com/${stateSlug}-2026-poll/`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": "senate-2026-election-center/1.0 (+ingestion bot)" } });
    } catch (err) {
      throw new AdapterError("emerson", `Network error fetching ${url}`, err);
    }
    if (res.status === 404) return []; // no Emerson poll for this state — not a failure
    if (!res.ok) throw new AdapterError("emerson", `HTTP ${res.status} fetching ${url}`);
    const html = await res.text();
    const text = extractArticleText(html, url);
    try {
      return [parseEmersonPost(text, url, { raceId: race.raceId, geographicId: race.geographicId })];
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError("emerson", `Failed to parse ${url}`, err);
    }
  },
};

/** Real HTML->text extraction: Readability strips nav/header/footer/sidebar/related-posts
 *  boilerplate and returns the article body, which is what parseEmersonPost's regexes are
 *  written against (see test/fixtures/*.txt — those are what this function's output looks
 *  like). Replaces the earlier `text = html` placeholder, which would have fed raw markup
 *  (tags interleaved with the sentence content) into regexes that expect plain text and
 *  would almost never have matched. Verified against a realistic synthetic WordPress-style
 *  HTML page — see test/emerson-extraction.test.ts — because this sandbox's network egress
 *  doesn't reach emersoncollegepolling.com to fetch a real raw-HTML sample (see README).
 */
export function extractArticleText(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article || !article.textContent) {
    throw new AdapterError("emerson", `Readability could not extract article content from ${url}`);
  }
  return article.textContent;
}

const STATE_SLUG: Record<string, string> = {
  IA: "iowa", TX: "texas", GA: "georgia", MI: "michigan", NC: "north-carolina",
  OH: "ohio", ME: "maine", NH: "new-hampshire", AK: "alaska", FL: "florida", MN: "minnesota",
};
