import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptEmailsFromContent,
  deobfuscateEmailNotation,
  findLiteralEvidence,
  isEligiblePublicEmail,
  isPlaceholderAddress,
  isSystemAddress,
  textNamesCompany,
} from "@/lib/company-discovery/accept";
import {
  MAX_EMAIL_PAGES_PER_COMPANY,
  countsAsResult,
  listingEmailCandidate,
  resolveCompanyEmails,
  type CompanySiteTextPage,
} from "@/lib/company-discovery/emails";

/**
 * Public-email discovery — the rules that decide what a user is told.
 *
 * The one invariant everything else serves: an address is reported ONLY when
 * it was literally published in content fetched in this run, and the outcome
 * distinguishes "nothing was published" from "a source refused to talk to us".
 * No name-derived addresses, no invented "info@…", and no block reported as
 * "no public email".
 */

type SourcePage = { url: string; kind: string; text: string };

const EMPTY_SEARCH = { ran: true, results: [] as Array<{ content: string; sourceUrl: string }> };

function site(overrides: {
  pages?: SourcePage[];
  blocked?: boolean;
  blockedReason?: "captcha" | "bot_challenge" | "login_required" | null;
  throws?: boolean;
}) {
  return async (): Promise<{
    pages: CompanySiteTextPage[];
    attempts: [];
    blocked: boolean;
    blockedReason: never | null;
  }> => {
    if (overrides.throws) throw new Error("unexpected failure");
    return {
      pages: (overrides.pages ?? []) as CompanySiteTextPage[],
      attempts: [],
      blocked: overrides.blocked ?? false,
      blockedReason: (overrides.blockedReason ?? null) as never,
    };
  };
}

function base(overrides: Partial<Parameters<typeof resolveCompanyEmails>[0]> = {}) {
  return {
    companyName: "Mustermann GmbH",
    listingEmail: null,
    websiteUrl: "https://mustermann-gmbh.de" as string | null,
    search: EMPTY_SEARCH,
    trustedPages: [] as Array<{ content: string; sourceUrl: string }>,
    fetchSite: site({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §4.2 — acceptance rules
// ---------------------------------------------------------------------------

describe("§4.2 — nothing is accepted that was not literally published", () => {
  it("1. an Impressum address is found with its full provenance", async () => {
    const page = {
      url: "https://mustermann-gmbh.de/impressum",
      kind: "impressum",
      text: "Impressum — Mustermann GmbH, Köln. Kontakt: bewerbung@mustermann-gmbh.de",
    };
    const outcome = await resolveCompanyEmails(base({ fetchSite: site({ pages: [page] }) }));
    expect(outcome.reasonCode).toBe("email_found");
    expect(outcome.primary).toMatchObject({
      email: "bewerbung@mustermann-gmbh.de",
      sourceUrl: page.url,
      sourceType: "official_site_impressum",
      verificationStatus: "verified",
      verificationMethod: "literal_on_official_site",
      domainMatch: true,
    });
    expect(outcome.primary?.evidenceSnippet).toContain("bewerbung@mustermann-gmbh.de");
  });

  it("2. an alternative source is used when the Impressum has none", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        fetchSite: site({
          pages: [
            { url: "https://mustermann-gmbh.de/impressum", kind: "impressum", text: "Impressum — Mustermann GmbH" },
            {
              url: "https://mustermann-gmbh.de/karriere",
              kind: "karriere",
              text: "Karriere bei der Mustermann GmbH — Bewerbung an karriere@mustermann-gmbh.de",
            },
          ],
        }),
      }),
    );
    expect(outcome.primary).toMatchObject({
      email: "karriere@mustermann-gmbh.de",
      sourceUrl: "https://mustermann-gmbh.de/karriere",
      sourceType: "official_site_career",
    });
  });

  it("5. rejects placeholders, system mailboxes and vendor addresses", async () => {
    for (const address of [
      "mustermann@mustermann-gmbh.de",
      "beispiel@mustermann-gmbh.de",
      "name@mustermann-gmbh.de",
      "user@mustermann-gmbh.de",
      "test@mustermann-gmbh.de",
      "logo@2x.png",
      "noreply@mustermann-gmbh.de",
      "postmaster@mustermann-gmbh.de",
      "webmaster@mustermann-gmbh.de",
    ]) {
      expect(isPlaceholderAddress(address) || isSystemAddress(address)).toBe(true);
    }
    // A genuine role mailbox is neither.
    expect(isPlaceholderAddress("bewerbung@mustermann-gmbh.de")).toBe(false);
    expect(isSystemAddress("bewerbung@mustermann-gmbh.de")).toBe(false);
    // Vendor / platform hosts are never the company's contact.
    expect(isSystemAddress("support@hubspot.com")).toBe(true);
    // Example/invalid domains are rejected one layer earlier, by the shared
    // extraction rules — asserted through the acceptor, not the predicates.
    for (const bogus of ["info@example.de", "kontakt@firma.invalid", "a@b.test"]) {
      expect(
        acceptEmailsFromContent({
          text: `Impressum Mustermann GmbH — ${bogus}`,
          sourceUrl: "https://mustermann-gmbh.de/impressum",
          sourceType: "official_site_impressum",
          companyName: "Mustermann GmbH",
          companyDomain: "mustermann-gmbh.de",
        }),
      ).toEqual([]);
    }
  });

  it("5b. an address absent from the fetched text is rejected (LLM safety)", () => {
    const text = "Impressum — Mustermann GmbH, Köln. Kontakt: info@mustermann-gmbh.de";
    expect(findLiteralEvidence(text, "info@mustermann-gmbh.de")).not.toBeNull();
    expect(findLiteralEvidence(text, "bewerbung@mustermann-gmbh.de")).toBeNull();
  });

  it("5c. reads the obfuscation a human reader can decode (and only that)", () => {
    expect(deobfuscateEmailNotation("kontakt (at) mustermann-gmbh (dot) de")).toBe(
      "kontakt@mustermann-gmbh.de",
    );
    const accepted = acceptEmailsFromContent({
      text: "Impressum Mustermann GmbH — kontakt (at) mustermann-gmbh (dot) de",
      sourceUrl: "https://mustermann-gmbh.de/impressum",
      sourceType: "official_site_impressum",
      companyName: "Mustermann GmbH",
      companyDomain: "mustermann-gmbh.de",
    });
    expect(accepted[0]?.email).toBe("kontakt@mustermann-gmbh.de");
  });

  it("never attributes an off-site address that the block does not bind", () => {
    const accepted = acceptEmailsFromContent({
      text: "Vermittlung: bewerbung@personalvermittlung-koeln.de",
      sourceUrl: "https://personalvermittlung-koeln.de/team",
      sourceType: "trusted_public_page",
      companyName: "Mustermann GmbH",
    });
    expect(accepted).toEqual([]);
  });

  it("accepts an attributed third-party address when the block names the company", () => {
    const accepted = acceptEmailsFromContent({
      text: "Mustermann GmbH — zugelassener Ausbildungsbetrieb, Kontakt: bewerbung@mustermann-gmbh.de",
      sourceUrl: "https://www.ihk-koeln.de/ausbildungsbetriebe",
      sourceType: "trusted_public_page",
      companyName: "Mustermann GmbH",
    });
    expect(accepted[0]).toMatchObject({
      email: "bewerbung@mustermann-gmbh.de",
      verificationMethod: "literal_on_attributed_third_party_page",
    });
  });

  it("accepts free-mail when it is genuinely published on the company's own site", () => {
    const accepted = acceptEmailsFromContent({
      text: "Impressum — Müller Elektro GmbH. E-Mail: mueller.elektro@gmail.com",
      sourceUrl: "https://mueller-elektro.de/impressum",
      sourceType: "official_site_impressum",
      companyName: "Müller Elektro GmbH",
      companyDomain: "mueller-elektro.de",
    });
    expect(accepted[0]).toMatchObject({ email: "mueller.elektro@gmail.com", domainMatch: false });
  });

  it("binds a company only when the name really appears in the text", () => {
    expect(textNamesCompany("Ausbildungsbetrieb: Mustermann GmbH", "Mustermann GmbH")).toBe(true);
    expect(textNamesCompany("Ausbildungsbetrieb: Andere Firma AG", "Mustermann GmbH")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.4 — the three outcomes
// ---------------------------------------------------------------------------

describe("§4.4 — email_found / no_public_email / source_blocked stay distinct", () => {
  it("4. every required page was reachable and published nothing", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        fetchSite: site({
          pages: [
            { url: "https://mustermann-gmbh.de/impressum", kind: "impressum", text: "Impressum — Mustermann GmbH, Köln. Tel. 0221 123456." },
            { url: "https://mustermann-gmbh.de/kontakt", kind: "kontakt", text: "Kontakt — Mustermann GmbH. Nutzen Sie bitte unser Formular." },
          ],
        }),
      }),
    );
    expect(outcome.reasonCode).toBe("no_public_email");
    expect(outcome.blocked).toBe(false);
    expect(outcome.requiredInspected).toBe(true);
    expect(outcome.emails).toEqual([]);
  });

  it("3. a CAPTCHA on a required page is source_blocked — never 'no public email'", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        fetchSite: site({ pages: [], blocked: true, blockedReason: "captcha" }),
      }),
    );
    expect(outcome.reasonCode).toBe("source_blocked");
    expect(outcome.blocked).toBe(true);
    expect(outcome.blockedReason).toBe("captcha");
    // The counting rule refuses it in BOTH modes as an email, and never merges
    // it into the "no public email" bucket.
    expect(
      countsAsResult({ onlyPublicEmail: true, hasPublicEmail: false, outcome: "source_blocked" }),
    ).toBe(false);
  });

  it("a block elsewhere never downgrades a found address", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        fetchSite: site({
          pages: [
            { url: "https://mustermann-gmbh.de/kontakt", kind: "kontakt", text: "Kontakt Mustermann GmbH: info@mustermann-gmbh.de" },
          ],
          blocked: true,
          blockedReason: "bot_challenge",
        }),
      }),
    );
    expect(outcome.reasonCode).toBe("email_found");
    expect(outcome.blocked).toBe(false);
    expect(outcome.primary?.email).toBe("info@mustermann-gmbh.de");
  });

  it("no website + the search step could not run ⇒ no_website_found, not no_public_email", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        websiteUrl: null,
        search: { ran: false, results: [] },
      }),
    );
    expect(outcome.reasonCode).toBe("no_website_found");
    expect(outcome.blocked).toBe(true);
  });

  it("no website + the permitted search step found the published address", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        websiteUrl: null,
        search: {
          ran: true,
          results: [
            {
              content:
                "Mustermann GmbH — offizielle Seite. Ausbildungsleitung: ausbildung@mustermann-gmbh.de",
              sourceUrl: "https://www.mustermann-gmbh.de/karriere",
            },
          ],
        },
      }),
    );
    expect(outcome.reasonCode).toBe("email_found");
    expect(outcome.primary).toMatchObject({
      email: "ausbildung@mustermann-gmbh.de",
      sourceType: "search_result",
      verificationMethod: "literal_on_attributed_third_party_page",
    });
  });

  it("an exhausted page budget is inconclusive, never 'no public email'", async () => {
    const outcome = await resolveCompanyEmails(base({ fetchSite: null }));
    expect(outcome.reasonCode).toBe("source_blocked");
    expect(outcome.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4.5 — dedupe and full provenance
// ---------------------------------------------------------------------------

describe("§4.5 — one record per address, every source URL kept", () => {
  it("6+7. the same address on three pages is stored once, all URLs preserved", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        fetchSite: site({
          pages: [
            { url: "https://mustermann-gmbh.de", kind: "home", text: "Mustermann GmbH — info@mustermann-gmbh.de" },
            { url: "https://mustermann-gmbh.de/impressum", kind: "impressum", text: "Impressum Mustermann GmbH — info@mustermann-gmbh.de" },
            { url: "https://mustermann-gmbh.de/kontakt", kind: "kontakt", text: "Kontakt Mustermann GmbH — info@mustermann-gmbh.de" },
          ],
        }),
      }),
    );
    expect(outcome.emails).toHaveLength(1);
    expect(outcome.emails[0].sourceUrls).toHaveLength(3);
    // The highest-priority source is primary (the Impressum).
    expect(outcome.emails[0].sourceType).toBe("official_site_impressum");
    expect(outcome.emails[0].sourceUrl).toBe("https://mustermann-gmbh.de/impressum");
  });

  it("prefers an application mailbox over a general one", async () => {
    const outcome = await resolveCompanyEmails(
      base({
        fetchSite: site({
          pages: [
            {
              url: "https://mustermann-gmbh.de/kontakt",
              kind: "kontakt",
              text: "Mustermann GmbH: info@mustermann-gmbh.de und bewerbung@mustermann-gmbh.de",
            },
          ],
        }),
      }),
    );
    expect(outcome.primary?.email).toBe("bewerbung@mustermann-gmbh.de");
    expect(outcome.emails).toHaveLength(2);
  });

  it("stays inside the page budget", () => {
    expect(MAX_EMAIL_PAGES_PER_COMPANY).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// §4.1 — the listing is only read for enabled portals
// ---------------------------------------------------------------------------

describe("§4.1 — a listing address is used, a BA address is not", () => {
  it("accepts an address the ENABLED portal printed in the listing", () => {
    const accepted = listingEmailCandidate({
      email: "ausbildung@mustermann-gmbh.de",
      sourceUrl: "https://www.ausbildung.de/stellen/123",
      evidence:
        "Ausbildung bei der Mustermann GmbH — Bewerbung an ausbildung@mustermann-gmbh.de",
      companyName: "Mustermann GmbH",
    });
    expect(accepted).toMatchObject({
      email: "ausbildung@mustermann-gmbh.de",
      sourceType: "job_listing",
      verificationMethod: "literal_in_listing",
    });
  });

  it("never maps an Arbeitsagentur record to an email (source contract)", () => {
    const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const pipeline = readFileSync(
      resolve(root, "src/lib/company-discovery/search.ts"),
      "utf8",
    );
    expect(pipeline).toContain("listingEmail: null");
    expect(pipeline).toContain("§3.3");
    // No reader of the BA contact block may remain in the discovery feature.
    expect(pipeline).not.toContain("opp.contact");
  });
});

// ---------------------------------------------------------------------------
// §4.6 — onlyPublicEmail
// ---------------------------------------------------------------------------

describe("onlyPublicEmail decides what becomes a result", () => {
  it("true → only companies with a verified published address count", () => {
    expect(countsAsResult({ onlyPublicEmail: true, hasPublicEmail: true })).toBe(true);
    expect(countsAsResult({ onlyPublicEmail: true, hasPublicEmail: false })).toBe(false);
    expect(
      countsAsResult({
        onlyPublicEmail: true,
        hasPublicEmail: false,
        outcome: "no_public_email",
      }),
    ).toBe(false);
  });

  it("true → a blocked company is not eligible, and never becomes 'no public email'", () => {
    expect(
      countsAsResult({ onlyPublicEmail: true, hasPublicEmail: false, outcome: "source_blocked" }),
    ).toBe(false);
  });

  it("false → every company counts, the UI labels the ones without an address", () => {
    expect(countsAsResult({ onlyPublicEmail: false, hasPublicEmail: false })).toBe(true);
    expect(countsAsResult({ onlyPublicEmail: false, hasPublicEmail: true })).toBe(true);
    expect(
      countsAsResult({ onlyPublicEmail: false, hasPublicEmail: false, outcome: "source_blocked" }),
    ).toBe(true);
  });
});

describe("§4.5/§4.6 — legacy rows are never eligible", () => {
  it("rejects a BA-derived ('offer') address and a provenance-less one", () => {
    // §3.3: an address that came from an Arbeitsagentur record is legacy.
    expect(
      isEligiblePublicEmail({
        sourceUrl: "https://www.arbeitsagentur.de/jobsuche/jobdetail/1",
        sourceType: "offer",
        verificationStatus: null,
      }),
    ).toBe(false);
    // No source page at all → unverifiable.
    expect(
      isEligiblePublicEmail({ sourceUrl: null, sourceType: "official_site_impressum" }),
    ).toBe(false);
    // A stored non-verified status is excluded too.
    expect(
      isEligiblePublicEmail({
        sourceUrl: "https://mustermann-gmbh.de/impressum",
        sourceType: "official_site_impressum",
        verificationStatus: "unverified",
      }),
    ).toBe(false);
  });

  it("accepts a verified address with a real source page", () => {
    expect(
      isEligiblePublicEmail({
        sourceUrl: "https://mustermann-gmbh.de/impressum",
        sourceType: "official_site_impressum",
        verificationStatus: "verified",
      }),
    ).toBe(true);
    // Rows that predate the verification columns are still usable when they
    // carry real provenance (they are not "without provenance").
    expect(
      isEligiblePublicEmail({
        sourceUrl: "https://mustermann-gmbh.de/impressum",
        sourceType: "impressum",
        verificationStatus: null,
      }),
    ).toBe(true);
  });

  it("the UI and the export share the same rule", () => {
    const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    const component = readFileSync(resolve(root, "src/components/company-discovery.tsx"), "utf8");
    const exportRoute = readFileSync(
      resolve(root, "src/app/api/company-discovery/[runId]/export/route.ts"),
      "utf8",
    );
    expect(component).toContain("isEligiblePublicEmail");
    expect(component).toContain("unverified_legacy");
    expect(exportRoute).toContain("isEligiblePublicEmail");
    expect(exportRoute).toContain("unverified_legacy");
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
