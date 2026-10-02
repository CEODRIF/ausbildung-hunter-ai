import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_EMAIL_PAGES_PER_COMPANY,
  companyWebsiteFromPublishedEmail,
  countsAsResult,
  offerEmailCandidate,
  pickPublicEmail,
  resolveCompanyPublicEmail,
  websiteEmailCandidates,
} from "@/lib/company-discovery/emails";
import type { Opportunity } from "@/lib/opportunities/types";

/**
 * Public-email discovery — the rules that decide what a user is told.
 *
 * The one invariant everything else serves: an address is reported ONLY when
 * it was actually published (in the source's offer contact block or on a page
 * of the company's own website). No name-derived addresses, no invented
 * "info@…", and "No public email found" when there is nothing.
 */

type OfferInput = Pick<Opportunity, "contact" | "source_url" | "enrichment">;

function offer(input: {
  contactEmail?: string | null;
  enrichmentEmail?: string | null;
  website?: string | null;
} = {}): OfferInput {
  const contact =
    input.contactEmail === undefined
      ? { email: "bewerbung@mustermann-gmbh.de", name: null, phone: null }
      : input.contactEmail === null
        ? null
        : { email: input.contactEmail, name: null, phone: null };
  const enrichment =
    input.enrichmentEmail === undefined && input.website === undefined
      ? null
      : {
          website_url: input.website ?? null,
          website_source: input.website ? `${input.website}/impressum` : null,
          email: input.enrichmentEmail ?? null,
        };
  return {
    contact,
    source_url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1-S",
    enrichment,
  } as unknown as OfferInput;
}

const page = (url: string, kind: string, text: string) => ({ url, kind, text });

describe("email discovery — only what was actually published", () => {
  it("keeps the address the source published, with its provenance", () => {
    const candidate = offerEmailCandidate(offer());
    expect(candidate).toMatchObject({
      email: "bewerbung@mustermann-gmbh.de",
      sourceType: "offer",
      confidence: "medium",
      fetchedSite: false,
    });
  });

  it("treats a source placeholder as 'no email' (never an address)", () => {
    for (const placeholder of ["keine Angabe", "n/a", "-", ""]) {
      expect(offerEmailCandidate(offer({ contactEmail: placeholder }))).toBeNull();
    }
    expect(offerEmailCandidate(offer({ contactEmail: null }))).toBeNull();
  });

  it("accepts an address the engine verified on a public page", async () => {
    const resolved = await resolveCompanyPublicEmail({
      companyName: "Example GmbH",
      offer: offer({ contactEmail: null, enrichmentEmail: "kontakt@mustermann-gmbh.de" }),
      websiteUrl: null,
      fetchPages: null,
    });
    expect(resolved?.email).toBe("kontakt@mustermann-gmbh.de");
    expect(resolved?.sourceType).toBe("search_result");
  });

  it("reads an address from the company's own Impressum with page provenance", async () => {
    const resolved = await resolveCompanyPublicEmail({
      companyName: "Example GmbH",
      offer: offer({ contactEmail: null }),
      websiteUrl: "https://mustermann-gmbh.de",
      fetchPages: async () => [
        page(
          "https://mustermann-gmbh.de/impressum",
          "impressum",
          "Impressum — Example GmbH, Köln. Kontakt: bewerbung@mustermann-gmbh.de",
        ),
      ],
    });
    expect(resolved).toMatchObject({
      email: "bewerbung@mustermann-gmbh.de",
      sourceUrl: "https://mustermann-gmbh.de/impressum",
      sourceType: "impressum",
      confidence: "high",
      fetchedSite: true,
    });
  });

  it("never attributes an address of another domain to the company", () => {
    const candidates = websiteEmailCandidates({
      companyName: "Example GmbH",
      pages: [
        page(
          "https://mustermann-gmbh.de/kontakt",
          "kontakt",
          "Example GmbH — Vermittlung: bewerbung@personalvermittlung-koeln.de",
        ),
      ],
    });
    expect(candidates).toEqual([]);
  });

  it("prefers an application mailbox over a general one", () => {
    const candidates = websiteEmailCandidates({
      companyName: "Example GmbH",
      pages: [
        page(
          "https://mustermann-gmbh.de/kontakt",
          "kontakt",
          "Example GmbH: info@mustermann-gmbh.de und bewerbung@mustermann-gmbh.de",
        ),
      ],
    });
    expect(pickPublicEmail(candidates)?.email).toBe("bewerbung@mustermann-gmbh.de");
  });

  it("a blocked or empty page yields no address instead of a guess", async () => {
    const blocked = await resolveCompanyPublicEmail({
      companyName: "Example GmbH",
      offer: offer({ contactEmail: null }),
      websiteUrl: "https://mustermann-gmbh.de",
      fetchPages: async () => {
        throw new Error("robots.txt disallows");
      },
    });
    expect(blocked).toBeNull();

    const empty = await resolveCompanyPublicEmail({
      companyName: "Example GmbH",
      offer: offer({ contactEmail: null }),
      websiteUrl: "https://mustermann-gmbh.de",
      fetchPages: async () => [page("https://mustermann-gmbh.de", "home", "Willkommen")],
    });
    expect(empty).toBeNull();
  });

  it("never turns a company NAME into a host, and never fetches without evidence", async () => {
    const fetchPages = vi.fn(async () => [
      page("https://mustermann-gmbh.de/impressum", "impressum", "bewerbung@mustermann-gmbh.de"),
    ]);
    const resolved = await resolveCompanyPublicEmail({
      companyName: "Example GmbH",
      offer: offer({ contactEmail: null }),
      websiteUrl: null,
      fetchPages,
    });
    expect(resolved).toBeNull();
    expect(fetchPages).not.toHaveBeenCalled();
  });

  it("derives a website only from a published, non-free-mail address", () => {
    expect(companyWebsiteFromPublishedEmail("bewerbung@mustermann-gmbh.de")).toBe(
      "https://mustermann-gmbh.de",
    );
    expect(companyWebsiteFromPublishedEmail("bewerbung@gmail.com")).toBeNull();
    expect(companyWebsiteFromPublishedEmail(null)).toBeNull();
  });

  it("stays inside the page budget", async () => {
    const pages = [
      page("https://mustermann-gmbh.de", "home", "Example GmbH"),
      page("https://mustermann-gmbh.de/kontakt", "kontakt", "Example GmbH"),
      page("https://mustermann-gmbh.de/karriere", "karriere", "Example GmbH"),
      page("https://mustermann-gmbh.de/impressum", "impressum", "Example GmbH bewerbung@mustermann-gmbh.de"),
    ];
    const resolved = await resolveCompanyPublicEmail({
      companyName: "Example GmbH",
      offer: offer({ contactEmail: null }),
      websiteUrl: "https://mustermann-gmbh.de",
      fetchPages: async () => pages,
      maxPages: 3,
    });
    // The address only exists on page 4 — outside the budget → no result.
    expect(resolved).toBeNull();
    expect(MAX_EMAIL_PAGES_PER_COMPANY).toBe(3);
  });
});

describe("onlyPublicEmail decides what becomes a result", () => {
  it("true → only companies with a published address count", () => {
    expect(countsAsResult({ onlyPublicEmail: true, hasPublicEmail: true })).toBe(true);
    expect(countsAsResult({ onlyPublicEmail: true, hasPublicEmail: false })).toBe(false);
  });

  it("false → every company counts, the UI labels the ones without an address", () => {
    expect(countsAsResult({ onlyPublicEmail: false, hasPublicEmail: false })).toBe(true);
    expect(countsAsResult({ onlyPublicEmail: false, hasPublicEmail: true })).toBe(true);
  });
});

describe("results UI (component contract)", () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const component = readFileSync(
    resolve(root, "src/components/company-discovery.tsx"),
    "utf8",
  );

  it("renders the public-email table from the database, not from client state", () => {
    expect(component).toContain("/api/company-discovery/${runId}/results");
    expect(component).toContain('initialRun = null');
    expect(component).toContain('initialCompanies = []');
  });

  it("shows 'No public email found' through i18n when a company has none", () => {
    expect(component).toContain('t("companyDiscovery.results.noEmail")');
    expect(component).not.toContain("No public email found\"");
  });

  it("offers the Excel download of exactly this run", () => {
    expect(component).toContain("/api/company-discovery/${run.runId}/export?lang=${lang}");
    expect(component).toContain('t("companyDiscovery.results.download")');
  });

  it("keeps the campaign history visible and links it to the run", () => {
    expect(component).toContain('t("companyDiscovery.campaigns.title")');
    expect(component).toContain("campaign.discoveryRunId");
    expect(component).toContain("/applications/campaign/${campaign.campaignId}");
  });

  it("creates a persisted draft from the selection (no send, no invention)", () => {
    expect(component).toContain("createDiscoveryDraftAction(");
    expect(component).toContain("/applications/new?draft=${draftState.draftId}");
    expect(component).toContain("companyDiscovery.campaigns.noAccount");
  });
});

describe("the way back from the campaign editor (reported: it went to Dashboard)", () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");
  const component = read("src/components/company-discovery.tsx");
  const composer = read("src/components/application-composer.tsx");
  const composerPage = read("src/app/applications/new/page.tsx");

  it("the composer offers the way back to Company Discovery when it came from there", () => {
    expect(composer).toContain('from === "company-discovery"');
    expect(composer).toContain('href="/company-discovery"');
    expect(composer).toContain('t("companyDiscovery.campaigns.backToDiscovery")');
    // It never restarts anything: the control is a plain link.
    expect(composer).not.toMatch(/onClick=\{[^}]*company-discovery/);
  });

  it("the composer page passes ?from= through to the composer", () => {
    expect(composerPage).toContain(
      'from={typeof params.from === "string" ? params.from : ""}',
    );
  });

  it("EVERY link from the discovery page into the editor keeps the origin", () => {
    const editorLinks =
      component.match(/\/applications\/new\?draft=\$\{[^}]+\}[^`"']*/g) ?? [];
    expect(editorLinks.length).toBeGreaterThanOrEqual(2); // after saving + a listed draft
    for (const link of editorLinks) {
      expect(link).toContain("from=company-discovery");
    }
  });

  it("the history panel is rendered on the form AND on the result view", () => {
    expect(component.split("<CampaignsPanel").length - 1).toBe(2);
    // A draft row (no campaign yet) opens in the composer, a campaign in its monitor.
    expect(component).toContain("campaign.campaignId");
  });

  it("the freshly created draft appears without a new search (server refresh)", () => {
    expect(component).toContain("router.refresh()");
  });
});
