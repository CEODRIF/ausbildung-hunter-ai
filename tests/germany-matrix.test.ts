import { describe, expect, it } from "vitest";
import { decideScope, detectUILanguage } from "@/lib/ai-scope";
import { needsCurrentInformation } from "@/lib/germany-knowledge";

/**
 * Acceptance matrix: the 18 categories the product lists × 4 languages.
 *
 * Every cell must be IN SCOPE (the assistant answers it) and its language must
 * be detected correctly — a wrong detection means a redirect or an answer in
 * the wrong language. The `search` column records whether the question asks
 * for a MOVING value (fee, deadline, threshold, law in force): those must
 * trigger the official-source lookup; the stable/conceptual ones must not,
 * because a needless lookup costs money and latency.
 */
type Row = {
  lang: "de" | "en" | "fr" | "ar";
  topic: string;
  question: string;
  search: boolean;
};

const MATRIX: Row[] = [
  // ---------------------------------------------------------------- German
  { lang: "de", topic: "Ausbildung", question: "Wie finde ich einen Ausbildungsplatz als Kaufmann im E-Commerce?", search: false },
  { lang: "de", topic: "Visa", question: "Welche Unterlagen brauche ich für ein Visum zur Ausbildung?", search: false },
  { lang: "de", topic: "Botschaft", question: "Wie bekomme ich einen Termin bei der deutschen Botschaft in Rabat?", search: true },
  { lang: "de", topic: "Einwanderung", question: "Ich möchte nach Deutschland einwandern, wo fange ich an?", search: false },
  { lang: "de", topic: "Aufenthalt", question: "Wie verlängere ich meine Aufenthaltserlaubnis?", search: false },
  { lang: "de", topic: "Einbürgerung", question: "Was sind die Voraussetzungen für die Einbürgerung?", search: false },
  { lang: "de", topic: "Goethe B1", question: "Wie viel kostet die Goethe B1 Prüfung?", search: true },
  { lang: "de", topic: "Studium", question: "Wie bewerbe ich mich an einer Universität in Deutschland?", search: false },
  { lang: "de", topic: "Anabin", question: "Wie prüfe ich meine Universität in Anabin?", search: false },
  { lang: "de", topic: "ZAB", question: "Brauche ich eine Zeugnisbewertung von der ZAB?", search: false },
  { lang: "de", topic: "Arbeit", question: "Wie hoch ist der Mindestlohn?", search: true },
  { lang: "de", topic: "Krankenversicherung", question: "Welche Krankenversicherung brauche ich als Student?", search: false },
  { lang: "de", topic: "Anmeldung", question: "Wie melde ich mich beim Bürgeramt an?", search: false },
  { lang: "de", topic: "Sperrkonto", question: "Wie viel Geld muss ich auf ein Sperrkonto einzahlen?", search: true },
  { lang: "de", topic: "Familiennachzug", question: "Wie funktioniert der Familiennachzug für meinen Ehepartner?", search: false },
  { lang: "de", topic: "Chancenkarte", question: "Was ist die Chancenkarte und wer bekommt sie?", search: false },
  { lang: "de", topic: "Blue Card", question: "Wie bekomme ich eine EU Blue Card?", search: false },
  { lang: "de", topic: "Alltag", question: "Wie finde ich eine Wohnung in Deutschland?", search: false },
  // --------------------------------------------------------------- English
  { lang: "en", topic: "Ausbildung", question: "How do I apply for an Ausbildung in Germany?", search: false },
  { lang: "en", topic: "Visa", question: "Which documents do I need for an Ausbildung visa?", search: false },
  { lang: "en", topic: "Embassy", question: "How do I book an appointment at the German embassy in Rabat?", search: true },
  { lang: "en", topic: "Immigration", question: "I want to immigrate to Germany, where do I start?", search: false },
  { lang: "en", topic: "Residence", question: "How do I extend my residence permit?", search: false },
  { lang: "en", topic: "Citizenship", question: "What are the requirements for German citizenship?", search: true },
  { lang: "en", topic: "Goethe B1", question: "How much does the Goethe B1 exam cost?", search: true },
  { lang: "en", topic: "Study", question: "How do I apply to a German university?", search: false },
  { lang: "en", topic: "Anabin", question: "How do I check my university in Anabin?", search: false },
  { lang: "en", topic: "ZAB", question: "Do I need a ZAB statement of comparability?", search: false },
  { lang: "en", topic: "Work", question: "What is the minimum wage in Germany?", search: true },
  { lang: "en", topic: "Insurance", question: "Which health insurance do I need as a student?", search: false },
  { lang: "en", topic: "Anmeldung", question: "How do I register at the Bürgeramt?", search: false },
  { lang: "en", topic: "Blocked account", question: "How much money do I need for a blocked account?", search: true },
  { lang: "en", topic: "Family", question: "How does family reunification work for my spouse?", search: false },
  { lang: "en", topic: "Chancenkarte", question: "What is the Chancenkarte and who qualifies?", search: false },
  { lang: "en", topic: "Blue Card", question: "How do I get an EU Blue Card?", search: false },
  { lang: "en", topic: "Daily life", question: "How do I find a flat in Germany?", search: false },
  // ---------------------------------------------------------------- French
  { lang: "fr", topic: "Ausbildung", question: "Comment trouver une formation professionnelle en Allemagne ?", search: false },
  { lang: "fr", topic: "Visa", question: "Quels documents faut-il pour un visa Ausbildung ?", search: false },
  { lang: "fr", topic: "Ambassade", question: "Comment prendre rendez-vous à l'ambassade d'Allemagne à Rabat ?", search: true },
  { lang: "fr", topic: "Immigration", question: "Je veux immigrer en Allemagne, par où commencer ?", search: false },
  { lang: "fr", topic: "Séjour", question: "Comment prolonger mon titre de séjour ?", search: false },
  { lang: "fr", topic: "Nationalité", question: "Quelles sont les conditions pour la nationalité allemande ?", search: true },
  { lang: "fr", topic: "Goethe B1", question: "Combien coûte l'examen Goethe B1 ?", search: true },
  { lang: "fr", topic: "Études", question: "Comment s'inscrire à l'université en Allemagne ?", search: false },
  { lang: "fr", topic: "Anabin", question: "Comment vérifier mon université dans Anabin ?", search: false },
  { lang: "fr", topic: "ZAB", question: "Ai-je besoin d'une évaluation de diplôme du ZAB ?", search: false },
  { lang: "fr", topic: "Travail", question: "Quel est le salaire minimum en Allemagne ?", search: true },
  { lang: "fr", topic: "Assurance", question: "Quelle assurance maladie pour un étudiant ?", search: false },
  { lang: "fr", topic: "Anmeldung", question: "Comment s'enregistrer au Bürgeramt ?", search: false },
  { lang: "fr", topic: "Compte bloqué", question: "Combien dois-je déposer sur un compte bloqué ?", search: true },
  { lang: "fr", topic: "Famille", question: "Comment fonctionne le regroupement familial ?", search: false },
  { lang: "fr", topic: "Chancenkarte", question: "Qu'est-ce que la Chancenkarte ?", search: false },
  { lang: "fr", topic: "Carte bleue", question: "Comment obtenir une carte bleue européenne ?", search: false },
  { lang: "fr", topic: "Vie quotidienne", question: "Comment trouver un logement en Allemagne ?", search: false },
  // ---------------------------------------------------------------- Arabic
  { lang: "ar", topic: "Ausbildung", question: "كيف أجد مقعد Ausbildung في ألمانيا؟", search: false },
  { lang: "ar", topic: "Visa", question: "ما هي الوثائق المطلوبة لتأشيرة Ausbildung؟", search: false },
  { lang: "ar", topic: "السفارة", question: "كيف أحجز موعدًا في السفارة الألمانية في الرباط؟", search: true },
  { lang: "ar", topic: "الهجرة", question: "أريد الهجرة إلى ألمانيا، من أين أبدأ؟", search: false },
  { lang: "ar", topic: "الإقامة", question: "كيف أمدد تصريح الإقامة؟", search: false },
  { lang: "ar", topic: "الجنسية", question: "ما هي شروط الحصول على الجنسية الألمانية؟", search: true },
  { lang: "ar", topic: "Goethe", question: "كم رسوم امتحان Goethe B1؟", search: true },
  { lang: "ar", topic: "الدراسة", question: "كيف أسجل في جامعة ألمانية؟", search: false },
  { lang: "ar", topic: "Anabin", question: "كيف أتحقق من جامعتي في Anabin؟", search: false },
  { lang: "ar", topic: "ZAB", question: "هل أحتاج تقييم شهادة من ZAB؟", search: false },
  { lang: "ar", topic: "العمل", question: "كم الحد الأدنى للأجور؟", search: true },
  { lang: "ar", topic: "التأمين", question: "أي تأمين صحي أحتاج كطالب؟", search: false },
  { lang: "ar", topic: "Anmeldung", question: "كيف أسجل في Bürgeramt؟", search: false },
  { lang: "ar", topic: "الحساب المغلق", question: "كم يجب أن أودع في الحساب المغلق؟", search: true },
  { lang: "ar", topic: "لم الشمل", question: "كيف يعمل لمّ الشمل لزوجتي؟", search: false },
  { lang: "ar", topic: "Chancenkarte", question: "ما هي بطاقة الفرصة؟", search: false },
  { lang: "ar", topic: "البطاقة الزرقاء", question: "كيف أحصل على البطاقة الزرقاء الأوروبية؟", search: false },
  { lang: "ar", topic: "الحياة اليومية", question: "كيف أجد شقة في ألمانيا؟", search: false },
];

describe("acceptance matrix: 18 categories x 4 languages", () => {
  it("covers all four languages and at least the required topics", () => {
    expect(new Set(MATRIX.map((row) => row.lang)).size).toBe(4);
    for (const lang of ["de", "en", "fr", "ar"] as const) {
      expect(MATRIX.filter((row) => row.lang === lang).length).toBe(18);
    }
    const topics = new Set(MATRIX.filter((row) => row.lang === "de").map((r) => r.topic));
    for (const required of [
      "Ausbildung",
      "Visa",
      "Botschaft",
      "Einwanderung",
      "Aufenthalt",
      "Einbürgerung",
      "Studium",
      "Anabin",
      "ZAB",
      "Arbeit",
      "Krankenversicherung",
      "Anmeldung",
      "Sperrkonto",
      "Familiennachzug",
      "Chancenkarte",
      "Blue Card",
      "Alltag",
    ]) {
      expect(topics, required).toContain(required);
    }
  });

  it.each(MATRIX)("$lang / $topic → in scope", (row) => {
    const decision = decideScope(row.question, false, []);
    expect(decision.inScope, `${row.lang}/${row.topic}: ${row.question}`).toBe(true);
  });

  it.each(MATRIX)("$lang / $topic → language detected", (row) => {
    expect(detectUILanguage(row.question), row.question).toBe(row.lang);
  });

  it.each(MATRIX.filter((row) => row.search))(
    "$lang / $topic → live lookup required (moving value)",
    (row) => {
      expect(needsCurrentInformation(row.question), row.question).toBe(true);
    },
  );

  it("stable/conceptual cells do NOT spend a lookup", () => {
    const needless = MATRIX.filter(
      (row) => !row.search && needsCurrentInformation(row.question),
    ).map((row) => `${row.lang}/${row.topic}`);
    expect(needless).toEqual([]);
  });
});
