import type { PollsterConfig } from "../types/poll";

// ============================================================================
// Whitelist registry. Nothing gets ingested unless it's here AND approved:true.
//
// `ingestionMethod` reflects reality, checked by hand (see /test/fixtures and the
// research notes in README.md), not aspiration:
//   - None of these pollsters were found to publish a dedicated polling API.
//   - Most run on a CMS (often WordPress) that *may* expose a default REST feed
//     at /wp-json/wp/v2/posts — worth trying first, but unconfirmed per-site, so
//     it's still marked "source_page_adapter" until an adapter actually verifies
//     the feed responds for that specific domain.
//   - historicalLeanD is only filled in where a specific, named source stated it
//     (see comments) — left undefined everywhere else rather than guessed.
// ============================================================================

export const POLLSTERS: PollsterConfig[] = [
  {
    id: "emerson",
    name: "Emerson College Polling",
    approved: true,
    officialDomains: ["emersoncollegepolling.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: "emerson",
    qualityNotes: "AAPOR Transparency Initiative charter member; publishes full crosstabs via linked Google Sheets.",
    sourceUrl: "https://emersoncollegepolling.com",
  },
  {
    id: "siena", // NYT/Siena College
    name: "Siena College Research Institute (NYT/Siena)",
    approved: true,
    officialDomains: ["siena.edu", "nytimes.com"],
    ingestionMethod: "manual", // NYT's polling pages are paywalled/JS-rendered; no adapter yet
    adapterId: null,
    qualityNotes: "Historical average error ~3.1pts, D+2.5 house lean per PollingSource pollster tracking (2024 cycle).",
    historicalLeanD: 2.5,
    sourceUrl: "https://www.nytimes.com/interactive/polling",
  },
  {
    id: "yougov",
    name: "YouGov",
    approved: true,
    officialDomains: ["today.yougov.com", "yougov.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null, // interface reserved; not implemented — see README "Not yet implemented"
    qualityNotes: "Online panel; frequently commissioned by third parties (e.g. YouGov Blue is D-affiliated — tag by sponsor, not just pollster).",
    sourceUrl: "https://today.yougov.com",
  },
  {
    id: "fox_news",
    name: "Fox News (Beacon Research/Shaw & Co.)",
    approved: true,
    officialDomains: ["foxnews.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    qualityNotes: "Bipartisan pairing (Beacon Research (D) / Shaw & Co. Research (R)). Historical D+1.9 house lean per PollingSource tracking.",
    historicalLeanD: 1.9,
    sourceUrl: "https://www.foxnews.com/politics",
  },
  {
    id: "surveyusa",
    name: "SurveyUSA",
    approved: true,
    officialDomains: ["surveyusa.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    sourceUrl: "https://www.surveyusa.com",
  },
  {
    id: "susquehanna",
    name: "Susquehanna Polling & Research",
    approved: true,
    officialDomains: ["susquehannapolling.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    qualityNotes: "Historical average error ~3.7pts, D+2.2 house lean per PollingSource pollster tracking.",
    historicalLeanD: 2.2,
    sourceUrl: "https://susquehannapolling.com",
  },
  {
    id: "data_for_progress",
    name: "Data for Progress",
    approved: true,
    officialDomains: ["dataforprogress.org"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    qualityNotes: "Progressive/Democratic-aligned research firm — always surface this alongside the poll, never hide it.",
    sourceUrl: "https://www.dataforprogress.org",
  },
  {
    id: "tipp",
    name: "TIPP Insights",
    approved: true,
    officialDomains: ["tippinsights.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    qualityNotes: "Historical average error ~2.5pts, D+2.5 house lean per PollingSource pollster tracking.",
    historicalLeanD: 2.5,
    sourceUrl: "https://tippinsights.com",
  },
  {
    id: "insider_advantage",
    name: "InsiderAdvantage",
    approved: true,
    officialDomains: ["insideradvantage.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    qualityNotes: "Historical average error ~1.9pts, D+1.2 house lean per PollingSource pollster tracking.",
    historicalLeanD: 1.2,
    sourceUrl: "https://www.insideradvantage.com",
  },
  {
    id: "st_anselm",
    name: "St. Anselm College Survey Center",
    approved: true,
    officialDomains: ["anselm.edu"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    sourceUrl: "https://www.anselm.edu/center-ethics-society-public-life/survey-center",
  },
  {
    id: "high_point",
    name: "High Point University Survey Research Center",
    approved: true,
    officialDomains: ["highpoint.edu"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    sourceUrl: "https://www.highpoint.edu/src/",
  },
  {
    id: "epic_mra",
    name: "EPIC-MRA",
    approved: true,
    officialDomains: ["epicmra.com"],
    ingestionMethod: "source_page_adapter",
    adapterId: null,
    sourceUrl: "https://www.epicmra.com",
  },
  {
    id: "fabrizio_anzalone",
    name: "Fabrizio Ward / Impact Research (bipartisan, incl. AARP surveys)",
    approved: true,
    officialDomains: ["fabrizioward.com", "impact-research.com"],
    ingestionMethod: "manual",
    adapterId: null,
    qualityNotes: "Bipartisan R/D pairing, often commissioned by AARP. Historical D+1.9 house lean per PollingSource tracking.",
    historicalLeanD: 1.9,
    sourceUrl: "https://fabrizioward.com",
  },
];

export function getPollster(id: string): PollsterConfig | undefined {
  return POLLSTERS.find(p => p.id === id);
}
export function isApproved(id: string): boolean {
  return getPollster(id)?.approved === true;
}
/** Domain check tolerates subdomains (e.g. "today.yougov.com" matches domain "yougov.com"). */
export function isOfficialDomain(pollsterId: string, url: string): boolean {
  const pollster = getPollster(pollsterId);
  if (!pollster) return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return pollster.officialDomains.some(d => host === d || host.endsWith("." + d));
}
