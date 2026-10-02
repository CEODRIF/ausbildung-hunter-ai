import "server-only";

/**
 * Company-domain guard for opportunity enrichment.
 *
 * The source registry and query builders that once lived here belonged to
 * the AI Ausbildung Search discovery layer, which was removed together
 * with that feature. The company-website guard below is still used by the
 * shared company-enrichment modules.
 */

function hostDomain(bare: string): string {
  const parts = bare.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : bare;
}

/**
 * Hosts that can NEVER be a company's official website — job portals,
 * company-review sites, business directories and public-employer portals.
 * They are legitimate DISCOVERY sources (how we find the job), but a
 * website discovered on one of them is a portal page, not the company.
 * (kununu/glassdoor/northdata/… are company-info sites, not the company.)
 */
export const BLOCKED_COMPANY_DOMAINS = [
  // discovery/job portals (registry domains + extras)
  "arbeitsagentur.de",
  "ausbildung.de",
  "aubi-plus.de",
  "azubiyo.de",
  "azubi.de",
  "meine-ausbildung-in-deutschland.de",
  "lehrstellen-radar.de",
  "ausbildung.nrw",
  "derausbildungsatlas.de",
  "hallo-beruf.de",
  "ihk.de",
  "ihk-lehrstellenboerse.de",
  "hwk.de",
  "handwerk.de",
  "stepstone.de",
  "indeed.de",
  "indeed.com",
  "meinestadt.de",
  "stellenanzeigen.de",
  "gojobs.de",
  "xing.com",
  "ausbildungihrerstadt.de",
  "azubimessenger.de",
  "jobvector.de",
  "service.bund.de",
  "wir-sind-bund.de",
  "bund.de",
  // company review / directory / data sites
  "kununu.com",
  "glassdoor.com",
  "northdata.de",
  "firmenwissen.de",
  "gelbe-seiten.de",
  "wer-weiss-was.de",
  "companyhouse.de",
  "handelsregister.de",
  // social
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
] as const;

/** True when a URL's host may plausibly be the company's own website
 *  (i.e. it is NOT a known portal / review / directory / social host). */
export function isAllowedCompanyDomain(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const bare = host.toLowerCase().replace(/^www\./, "");
  const domain = hostDomain(bare);
  for (const blocked of BLOCKED_COMPANY_DOMAINS) {
    if (domain === blocked || bare === blocked || bare.endsWith(`.${blocked}`))
      return false;
  }
  return true;
}
