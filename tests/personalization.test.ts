import { describe, expect, it } from "vitest";

import {
  COMPANY_FALLBACK,
  GREETING_FALLBACK,
  PersonalizationError,
  hasPersonalizationTokens,
  parseSalutation,
  registrableDomain,
  renderContactName,
  renderGreeting,
  renderHtmlTemplate,
  renderPersonalizedMessage,
  renderTextTemplate,
  resolveCompanyName,
} from "@/lib/personalization";

/**
 * Smart personalization — the pure resolution + rendering rules.
 *
 * These pin the contract the sending pipeline relies on:
 *   - company names come from the email domain (or the user override) and
 *     never from free-mail providers or generic portal labels,
 *   - contact names come ONLY from an explicitly provided value and generic
 *     mailbox words are never presented as a person,
 *   - the greeting is personalized only with explicit Herr/Frau metadata,
 *   - every rendered message is independent, token-free and HTML-safe.
 */

describe("company name resolution", () => {
  it("resolves the required example domains", () => {
    expect(resolveCompanyName("bewerbung@carrier.de")).toEqual({
      value: "Carrier",
      // carrier.de is a curated KNOWN entry (exact casing guaranteed)
      source: "known",
    });
    expect(resolveCompanyName("info@bosch.de")).toEqual({
      value: "Bosch",
      source: "known",
    });
    expect(resolveCompanyName("jobs@bmw.de")).toEqual({
      value: "BMW",
      source: "known",
    });
  });

  it("handles subdomains (only the registrable domain counts)", () => {
    expect(registrableDomain("jobs.karriere.bmw.de")).toBe("bmw.de");
    expect(resolveCompanyName("bewerbung@jobs.karriere.bmw.de").value).toBe(
      "BMW",
    );
    expect(resolveCompanyName("bewerbung@sub.carrier.de").value).toBe("Carrier");
    expect(registrableDomain("firma.berlin.de")).toBe("firma.berlin.de");
  });

  it("never treats free-mail providers as companies", () => {
    for (const email of [
      "me@gmail.com",
      "me@googlemail.com",
      "me@web.de",
      "me@gmx.de",
      "me@gmx.net",
      "me@t-online.de",
      "me@outlook.com",
      "me@outlook.de",
      "me@hotmail.com",
      "me@yahoo.de",
      "me@icloud.com",
      "me@proton.me",
    ]) {
      expect(resolveCompanyName(email).value, email).toBeNull();
      expect(resolveCompanyName(email).source, email).toBe("unresolved");
    }
    // Subdomain abuse of a free provider must not slip through.
    expect(resolveCompanyName("bewerbung@mail.gmx.de").value).toBeNull();
  });

  it("never derives a name from generic portal labels", () => {
    for (const email of [
      "bewerbung@karriere.example.de",
      "info@job.example.de",
      "jobs@career.example.co.uk",
      "bewerbung@hr.example.at",
      "team@mail.example.com",
      "bewerbung@job.de",
    ]) {
      expect(resolveCompanyName(email).value, email).toBeNull();
    }
  });

  it("does not blindly capitalize: hyphenated / punycode labels resolve to nothing", () => {
    // unknown hyphenated employer → no guess (curated map entries still work)
    expect(resolveCompanyName("jobs@unknown-company.de").value).toBeNull();
    expect(resolveCompanyName("bewerbung@xn--se-3qa.de").value).toBeNull();
    // curated exception wins over the (impossible) heuristic
    expect(resolveCompanyName("jobs@mercedes-benz.de").value).toBe("Mercedes-Benz");
  });

  it("the user override always wins (and is trimmed + capped)", () => {
    expect(resolveCompanyName("me@gmail.com", "ACME AG")).toEqual({
      value: "ACME AG",
      source: "user",
    });
    expect(resolveCompanyName("jobs@bmw.de", "  BMW Werk München  ").value).toBe(
      "BMW Werk München",
    );
    const long = "x".repeat(400);
    expect(resolveCompanyName("a@b.de", long).value?.length).toBe(160);
    // A blank override counts as "no override" — a free-mail address then
    // still resolves to nothing (the safe fallback applies at render time).
    expect(resolveCompanyName("me@gmail.com", "   ").value).toBeNull();
  });

  it("invalid emails resolve to nothing", () => {
    for (const email of ["", "no-at-sign", "@carrier.de", "a@b", "a @b.de"]) {
      expect(resolveCompanyName(email).value).toBeNull();
    }
  });
});

describe("contact person resolution", () => {
  it("only uses explicitly provided names (a personal-looking mailbox is NOT a source)", () => {
    // No contact value → nothing, no matter how "personal" the mailbox is.
    expect(renderGreeting(null)).toBe(GREETING_FALLBACK);
    expect(renderContactName(null)).toBe("Damen und Herren");
    // max.mustermann@company.de looks personal — but without an explicit
    // contact value the greeting must stay the general one.
    const rendered = renderPersonalizedMessage(
      {
        subject: "{{company_name}}",
        bodyHtml: "<p>{{greeting}}</p>",
        bodyText: "{{greeting}}",
      },
      { email: "max.mustermann@carrier.de" },
    );
    expect(rendered.bodyHtml).toContain("Sehr geehrte Damen und Herren,");
    expect(rendered.bodyHtml).not.toContain("Mustermann");
  });

  it("never presents generic mailbox words as a person's name", () => {
    for (const value of [
      "info",
      "bewerbung",
      "karriere",
      "jobs",
      "hr",
      "kontakt",
      "contact",
      "recruiting",
      "personal",
      "office",
      "support",
      "admin",
      "sales",
      "team",
      "hello",
      "noreply",
      "no-reply",
      "Frau info",
      "Herr bewerbung",
      "info team",
    ]) {
      expect(renderGreeting(value), value).toBe(GREETING_FALLBACK);
      expect(renderContactName(value), value).toBe("Damen und Herren");
    }
  });

  it("generates the formal German greetings from explicit Herr/Frau metadata", () => {
    expect(renderGreeting("Herr Mustermann")).toBe(
      "Sehr geehrter Herr Mustermann,",
    );
    expect(renderGreeting("Frau Schmidt")).toBe("Sehr geehrte Frau Schmidt,");
    expect(renderGreeting("Frau Dr. Schmidt")).toBe(
      "Sehr geehrte Frau Dr. Schmidt,",
    );
    expect(renderGreeting("Herr Prof. Müller")).toBe(
      "Sehr geehrter Herr Prof. Müller,",
    );
    // lowercase input is normalised
    expect(renderGreeting("herr mustermann")).toBe(
      "Sehr geehrter Herr Mustermann,",
    );
  });

  it("a verified person WITHOUT salutation info still gets the general greeting", () => {
    // Gender is never inferred from a first name.
    expect(renderGreeting("Max Mustermann")).toBe(GREETING_FALLBACK);
    expect(renderGreeting("Anna Schmidt")).toBe(GREETING_FALLBACK);
    expect(parseSalutation("Max Mustermann")).toBeNull();
    // …but the contact variable still shows the provided name.
    expect(renderContactName("Max Mustermann")).toBe("Max Mustermann");
  });

  it("rejects malformed / hostile contact values (no markup, no truncation games)", () => {
    for (const value of [
      "Herr <script>alert(1)</script>",
      "Frau Müller</p><p>injected",
      "Herr",
      "Herr  ",
      "Frau a".concat("x".repeat(90)),
      "Herr http://evil.example",
      "Herr Müller; DROP TABLE x",
    ]) {
      expect(renderGreeting(value), value).toBe(GREETING_FALLBACK);
    }
  });
});

describe("per-recipient rendering", () => {
  const template = {
    subject: "Bewerbung bei {{company_name}}",
    bodyHtml:
      "<p>{{greeting}}</p><p>Ich möchte gerne bei <strong>{{company_name}}</strong> arbeiten.</p><p>{{contact_name}}</p>",
    bodyText:
      "{{greeting}} Ich möchte gerne bei {{company_name}} arbeiten. {{contact_name}}",
  };

  it("renders different recipients independently (no cross-recipient leakage)", () => {
    const carrier = renderPersonalizedMessage(template, {
      email: "bewerbung@carrier.de",
    });
    const bosch = renderPersonalizedMessage(template, {
      email: "info@bosch.de",
      contactName: "Herr Mustermann",
    });

    expect(carrier.subject).toBe("Bewerbung bei Carrier");
    expect(bosch.subject).toBe("Bewerbung bei Bosch");

    expect(carrier.bodyHtml).toContain("bei <strong>Carrier</strong>");
    expect(carrier.bodyHtml).toContain("Sehr geehrte Damen und Herren,");
    expect(bosch.bodyHtml).toContain("bei <strong>Bosch</strong>");
    expect(bosch.bodyHtml).toContain("Sehr geehrter Herr Mustermann,");
    expect(bosch.bodyHtml).toContain("<p>Herr Mustermann</p>");

    // No recipient's data may leak into the other's message.
    expect(carrier.bodyHtml).not.toContain("Bosch");
    expect(carrier.bodyHtml).not.toContain("Mustermann");
    expect(carrier.subject).not.toContain("Bosch");
    expect(bosch.bodyHtml).not.toContain("Carrier");
    expect(bosch.bodyHtml).not.toContain("Damen und Herren,");
  });

  it("never leaves a known token (or spaced variant) unresolved", () => {
    const rendered = renderPersonalizedMessage(template, {
      email: "jobs@bmw.de",
    });
    for (const value of [rendered.subject, rendered.bodyHtml, rendered.bodyText]) {
      expect(value).not.toMatch(/\{\{\s*(company_name|contact_name|greeting)\s*\}\}/);
    }
    expect(hasPersonalizationTokens(rendered.bodyHtml)).toBe(false);
    expect(hasPersonalizationTokens("kein Token hier")).toBe(false);
    expect(hasPersonalizationTokens("{{greeting}}")).toBe(true);

    // A token trapped inside tag markup cannot be resolved → hard error.
    expect(() =>
      renderPersonalizedMessage(
        { subject: "", bodyHtml: '<a href="{{company_name}}">x</a>', bodyText: "" },
        { email: "a@b.de" },
      ),
    ).toThrow(PersonalizationError);

    // A hand-typed spaced variant is not substituted AND not sent.
    expect(() =>
      renderPersonalizedMessage(
        { subject: "", bodyHtml: "<p>{{ company_name }}</p>", bodyText: "" },
        { email: "a@b.de" },
      ),
    ).toThrow(PersonalizationError);
  });

  it("uses the safe fallbacks when a variable cannot be resolved", () => {
    const rendered = renderPersonalizedMessage(template, {
      email: "me@gmail.com", // free provider → company fallback
    });
    expect(rendered.subject).toBe(`Bewerbung bei ${COMPANY_FALLBACK}`);
    expect(rendered.subject).toBe("Bewerbung bei Ihrem Unternehmen");
    expect(rendered.bodyHtml).toContain("<strong>Ihrem Unternehmen</strong>");
    expect(rendered.bodyText).toContain("bei Ihrem Unternehmen arbeiten.");
    expect(rendered.bodyHtml).toContain("Sehr geehrte Damen und Herren,");
    expect(rendered.bodyHtml).toContain("<p>Damen und Herren</p>");
  });

  it("preserves rich-text formatting around the tokens", () => {
    const rendered = renderPersonalizedMessage(
      {
        subject: "",
        bodyHtml:
          '<p style="text-align:center"><b>Betreff</b><br/>bei {{company_name}}<i> (Azubi)</i></p><ul><li>Punkt</li></ul>',
        bodyText: "",
      },
      { email: "jobs@bmw.de", contactName: "Frau Dr. Schmidt" },
    );
    expect(rendered.bodyHtml).toBe(
      '<p style="text-align:center"><b>Betreff</b><br/>bei BMW<i> (Azubi)</i></p><ul><li>Punkt</li></ul>',
    );
  });

  it("escapes inserted values for the HTML context (no injection from recipient data)", () => {
    const rendered = renderPersonalizedMessage(template, {
      email: "a@b.de",
      companyName: '<img src=x onerror=alert(1)> "Firma"',
    });
    expect(rendered.bodyHtml).not.toContain("<img");
    expect(rendered.bodyHtml).toContain(
      "&lt;img src=x onerror=alert(1)&gt; &quot;Firma&quot;",
    );
    // The subject is plain text: the raw value is fine there, but the HTML
    // copy must never carry unescaped markup.
    expect(rendered.subject).toContain('<img src=x onerror=alert(1)> "Firma"');

    // A contact value full of markup is rejected entirely → fallbacks.
    const hostile = renderPersonalizedMessage(
      { subject: "{{contact_name}}", bodyHtml: "<p>{{greeting}}</p>", bodyText: "" },
      { email: "a@b.de", contactName: 'Herr <svg/onload=alert(1)>' },
    );
    expect(hostile.bodyHtml).toBe("<p>Sehr geehrte Damen und Herren,</p>");
    expect(hostile.subject).toBe("Damen und Herren");
  });

  it("only rewrites text nodes — tags and attributes are byte-for-byte untouched", () => {
    const html = '<p data-x="{{company_name}}">vor <span style="color:#fff">{{greeting}}</span> nach</p>';
    const out = renderHtmlTemplate(html, {
      company_name: "Carrier",
      contact_name: "x",
      greeting: "Sehr geehrte Damen und Herren,",
    });
    expect(out).toBe(
      '<p data-x="{{company_name}}">vor <span style="color:#fff">Sehr geehrte Damen und Herren,</span> nach</p>',
    );
    expect(renderTextTemplate("hallo {{company_name}}", { company_name: "Bosch" })).toBe(
      "hallo Bosch",
    );
  });
});
