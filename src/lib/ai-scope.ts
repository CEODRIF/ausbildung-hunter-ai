/**
 * Server-side scope enforcement for the AI Assistant chat.
 *
 * The assistant is a SPECIALIST for Ausbildung Hunter AI (Ausbildung, jobs,
 * applications, career in Germany, platform features) — not a general chatbot.
 * This module decides, deterministically and BEFORE any model call, whether a
 * user message is in scope:
 *
 *   - in scope  → the model answers (the hardened system prompt reinforces);
 *   - out of scope → the server streams a short, language-matched redirect
 *     (no model call, no long off-topic answer, nothing fabricated).
 *
 * The decision is signal-based, not a naive keyword check: domain lexicons in
 * de/en/fr/ar, multi-word intent patterns ("work in germany", "التقديم على",
 * "أريد العمل في ألمانيا"), document-analysis patterns, German-vocabulary
  * questions, and a context rule for short follow-ups ("Is that right for
  * me?" style) that only fires on deictic continuation markers and an
 * in-scope recent history. Instruction-override attempts are always blocked,
 * even when they embed in-scope words.
 *
 * Pure module (no server imports) → fully unit-testable.
 */

export interface ScopeHistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ScopeDecision {
  inScope: boolean;
  /** Why the decision was made (for logs/tests, not user-visible). */
  reason:
    | "domain"
    | "attachments"
    | "context"
    | "out_of_scope"
    | "instruction_override";
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Lowercase + fold German characters so "Ausbildung" matches "ausbildung". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Domain lexicons (normalized form — no umlauts, lowercase)
// ---------------------------------------------------------------------------

const GERMAN_TERMS = new Set([
  "ausbildung", "ausbildungen", "ausbildungsberuf", "ausbildungsvertrag",
  "berufsausbildung", "dualsystem", "dualstudium", "praktikum",
  "praktikum", "praxisstelle", "stellenanzeige", "stellenanzeigen",
  "stellenangebot", "stellenangebote", "stellenboerse", "jobboerse",
  "bewerbung", "bewerbungen", "bewerbungsschreiben", "bewerbungsunterlagen",
  "lebenslauf", "anschreiben", "deckblatt", "vorstellungsgesprach",
  "karriere", "arbeitsstelle", "arbeitsstellen", "arbeitsvertrag",
  "arbeitsmarkt", "arbeitsvisum", "arbeitslosengeld", "minijob",
  "berufseinstieg", "berufserfahrung", "entgelt", "gehalt",
  "chancenkarte", "bluecard", "arbeitszeugnis", "referenzen",
]);

const ENGLISH_TERMS = new Set([
  "ausbildung", "apprenticeship", "vacancy", "vacancies", "application",
  "applications", "cover", "resume", "cv", "career", "interview",
  "interviews", "employer", "employers", "workpermit", "workvisa",
  "bluecard", "chancenkarte", "germany", "german", "apprentice",
  "trainee", "traineeship", "salary", "apprenticeships",
]);

const FRENCH_TERMS = new Set([
  "formation", "professionnelle", "candidature", "candidatures",
  "motivation", "entretien", "allemagne", "allemand", "allemande",
  "carriere", "stagiaire", "carte",
]);

const ARABIC_TERMS = new Set([
  "التدريب", "تدريب", "مهني", "مهنية", "مهن", "مهنة", "التقديم", "تقديم",
  "وظيفة", "وظائف", "وظيفي", "وظيفية", "فرص", "فرصة", "العمل", "عمل",
  "ألمانيا", "الألمانية", "الالمانية", "ألمانية", "ألماني", "ألمانيا",
  "شركة", "شركات", "مقابلة", "مقابلات", "مسار", "مهني", "سيرة", "ذاتية",
  "خطاب", "رسالة", "تغطية", "عقد", "عقود", "تأشيرة", "تأشيرات", "راتب",
  "راتبين", "خبرة", "شهادة", "شهادات", "لغة", "لغات", "دراسة", "تعلم",
  "بداية", "ابدأ", "أبدأ", "المحفوظة", "المحفوظ", "المحفوظات",
]);

const PLATFORM_TERMS = new Set([
  // platform features (all languages, normalized)
  "scanner", "dashboard", "profil", "profile", "saved", "opportunities",
  "opportunity", "notifications", "تنبيهات", "تنبيه", "لوحة", "التحكم",
  "الملف", "الشخصي", "بوينج",
]);

/** "job", "jobs", "stelle", "stellen", "bewerbung"-style stems. */
const STEM_TERMS = new Set([
  "job", "jobs", "stelle", "stellen", "stellenanzeige", "bewerbung",
  "bewerbungen", "anstellung", "stellenanzeigen", "stellenangebote",
  "jobbörse", "jobboerse", "stellenboerse", "arbeits", "arbeit",
]);

// Multi-word intent patterns, matched on normalized text (regex, literal).
const PATTERN_LIST: RegExp[] = [
  // German
  /job in deutschland/, /arbeit in deutschland/, /arbeitsplatz/,
  /bewerbung (schreiben|stellen|senden|ausfuhren)/, /anschreiben (schreiben|erstellen)/,
  /(mein|meine) (cv|lebenslauf)/, /lebenslauf (erstellen|schreiben|optimieren)/,
  /interview (vorbereiten|vorbereitung)/, /vorstellungsgesprach/,
  /ausbildung (finden|suchen|beginnen|anfangen|ohne)/, /dual studium/,
  /praktikum (finden|suchen)/, /jobsuche/, /stellenanzeige(n)? (erkl|verst|lesen)/,
  // English
  /work in germany/, /job in germany/, /jobs in germany/, /find (a|an) job/,
  /job search/, /apply for/, /write (a|my) cover letter/, /cover letter/,
  /write (my|a) cv/, /my resume/, /career in/, /job interview/,
  /work (visa|permit)/, /apprentice(ship)?/, /saved opportunit(y|ies)/,
  // French
  /travailler en allemagne/, /trouver un emploi/, /postuler/,
  /lettre de motivation/, /entretien d.{0,3}embauche/, /carriere en allemagne/,
  /carte bleue/, /offre d.{0,3}emploi/,
  // Arabic
  /العمل في ألمانيا/, /العمل في الالمانية/, /أبحث عن (وظيفة|عمل|فرص)/,
  /ابحث عن (وظيفة|عمل|فرص)/, /التقديم على/, /التقديم ل/, /تقديم طلب/,
  /طلب (وظيفي|تقديم)/, /إعلان (وظيفي|وظائف)/, /اعلان (وظيفي|وظائف)/,
  /إعلانات وظيفية/, /فرص عمل/, /فرصة عمل/, /المقابلة الشخصية/,
  /بطاقة الفرصة/, /تعلم الألمانية/, /دراسة الألمانية/, /اللغة الألمانية/,
  /شهادة ألمانية/, /مستوى b[12]/, /ب[12] في/, /من اين ابدأ/, /من أين أبدأ/,
  /أين أجد/, /اين اجد/, /كيف اكتب/, /كيف أكتب/, /كيف اقدم/, /كيف أقدم/,
  /كيف ارسل/, /كيف أرسل/, /كيف استخدم/, /كيف أستخدم/, /كيف اضيف/, /كيف أضيف/,
  /خطاب (التقديم|تقديم)/, /رسالة (التقديم|تقديم)/, /السيرة الذاتية/,
  /السير الذاتية/, /خطاب التغطية/,
  // Document-analysis intent (any language)
  /(حلل|تحليل|analyze|analys|analyse|explain|وضّح|وضح|اشرح|شرح) (هذا|هذه|that|this|the)? ?(نص|ملف|إعلان|اعلان|رسالة|pdf|docx?|text|file|document|listing)/,
  /was bedeutet/, /what (does|do) .{1,40} (mean|say)/,
  /que signifie/, /ما معنى (كلمة|نص)?/,
];

// Instruction-override / jailbreak patterns — ALWAYS block, even when the
// message embeds in-scope words ("…ignore previous instructions. What do
// you think about Ausbildung?").
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |previous |prior |the |your )?(instructions|rules|prompts|guidelines)/,
  /disregard (your |the |previous |all )?(instructions|rules|prompts)/,
  /forget (your |the |previous |all )?(instructions|rules|everything|prior)/,
  /you are now (a|an|the) (general|unrestricted|different|regular)/,
  /act as (a|an) (general|unrestricted|different|regular|new)/,
  /new (system )?(instructions|rules|prompt)/,
  /reveal (your |the )?(system|prompt|instructions|rules)/,
  /show (your |me the )?(system )?(prompt|instructions)/,
  /jailbreak/, /override (the |your |all )?(instructions|rules|filters|safety|limits)/,
  /بإهمال (ال|كل )?(تعليمات|قواعد)/, /تجاهل (ال|كل |أي )?(تعليمات|قواعد)/,
  /أنسى (تعليماتك|قواعدك)/, /انسى (تعليماتك|قواعدك)/, /أنت الآن (مساعد|chatbot|نظام) عام/,
  /انت الان (مساعد|chatbot|نظام) عام/, /تصرف كـ(مساعد|chatbot) عام/,
  /تعليمات النظام/, /اعرض (تعليماتك|نظامك)/, /أعد كتابة التعليمات/,
  /ignorez (les |toutes les )?(instructions|règles|regles)/,
  /vous êtes maintenant/, /vous etes maintenant/, /nouveaux (instructions|règles)/,
  /ignorieren.{0,25}(anweisungen|regeln)/, /ignoriere.{0,25}(anweisungen|regeln)/,
  /du bist jetzt (ein )?allgemeiner/,
  /neue (system-)?(anweisungen|regeln)/,
];

// Deictic continuation markers — a SHORT message carrying one of these (and
// an in-scope recent history) is treated as a follow-up of the conversation,
// even without any domain word of its own.
const DEICTIC_PATTERNS: RegExp[] = [
  // Arabic (bare copulas "هو/هي" excluded on purpose — they appear in
  // unrelated questions like "من هو رئيس فرنسا؟")
  /(?:^|\s)(هذا|هذه|ذلك|تلك|هؤلاء|أولئك|هم|هم|يريدين|يريدين|الرسالة|الإعلان|اعلان|الوظيفة|الملف|العرض)(?:\s|$|[?؟.!،,])/u,
  // English / German / French
  /\b(?:this|that|it|they|them|the job|the vacancy|the letter|the application|the file|should i|can i)\b/,
  /\b(?:das|diese|dieser|dieses|sie|es|die stelle|das angebot|der brief|soll ich|kann ich)\b/,
  /\b(?:ceci|cela|cette|ces|ils|elles|l.{0,3}offre|la candidature|la lettre|ce texte|puis-je)\b/,
];

// ---------------------------------------------------------------------------
// Detection primitives
// ---------------------------------------------------------------------------

function containsToken(text: string, terms: Set<string>): boolean {
  const tokens = text.split(/[^a-z0-9\u0600-\u06ff]+/i);
  for (const token of tokens) {
    if (token && terms.has(token)) return true;
  }
  // Stem match: "bewerbungsunterlagen" contains "bewerbung"
  for (const term of terms) {
    if (term.length >= 4 && text.includes(term)) return true;
  }
  return false;
}

function hasDomainSignal(raw: string): boolean {
  const text = normalize(raw);
  if (
    containsToken(text, GERMAN_TERMS) ||
    containsToken(text, ENGLISH_TERMS) ||
    containsToken(text, FRENCH_TERMS) ||
    containsToken(text, ARABIC_TERMS) ||
    containsToken(text, PLATFORM_TERMS) ||
    containsToken(text, STEM_TERMS)
  ) {
    return true;
  }
  for (const pattern of PATTERN_LIST) if (pattern.test(text)) return true;
  // German-vocabulary question about a word with German characters:
  // "ما معنى كلمة Überstunden?" / "was bedeutet Kündigungsfrist?"
  const wordMatch = /(?:ما معنى (?:كلمة )?|what does |was bedeutet |que signifie )([^\s?؟.,;]+(?:-[^\s?؟.,;]+)*)/.exec(
    raw,
  );
  if (wordMatch) {
    const word = wordMatch[1];
    if (/[ßäöüÄÖÜ]/.test(word) || GERMAN_TERMS.has(normalize(word))) return true;
  }
  return false;
}

function isInjectionAttempt(raw: string): boolean {
  const text = normalize(raw);
  for (const pattern of INJECTION_PATTERNS) if (pattern.test(text)) return true;
  return false;
}

function historyIsInScope(history: ScopeHistoryMessage[]): boolean {
  const recent = history.slice(0, 4); // newest first
  return recent.some((message) => {
    if (message.role === "assistant" && message.content.includes("[file context]"))
      return true;
    return hasDomainSignal(message.content);
  });
}

function isDeicticFollowUp(raw: string): boolean {
  const text = normalize(raw);
  for (const pattern of DEICTIC_PATTERNS) if (pattern.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decideScope(
  content: string,
  hasAttachments: boolean,
  history: ScopeHistoryMessage[],
): ScopeDecision {
  const text = (content ?? "").trim();
  if (!text && !hasAttachments) {
    return { inScope: false, reason: "out_of_scope" };
  }
  // 1) Security first: override attempts are always blocked, even when they
  //    embed in-scope words.
  if (text && isInjectionAttempt(text)) {
    return { inScope: false, reason: "instruction_override" };
  }
  // 2) Uploads are a platform feature by definition (the file context is
  //    built server-side from the user's own documents).
  if (hasAttachments) return { inScope: true, reason: "attachments" };
  // 3) Direct domain signal — the primary path.
  if (hasDomainSignal(text)) return { inScope: true, reason: "domain" };
  // 4) Short contextual follow-up with deictic continuation + an in-scope
  //    recent history ("ist das wasche für mich?" / "هل هذا مناسب لي؟").
  if (
    text &&
    wordCount(text) <= 10 &&
    isDeicticFollowUp(text) &&
    historyIsInScope(history)
  ) {
    return { inScope: true, reason: "context" };
  }
  // 5) Nothing in scope — the server will stream a short redirect.
  return { inScope: false, reason: "out_of_scope" };
}

// ---------------------------------------------------------------------------
// Language detection + short, language-matched redirect (never a lecture)
// ---------------------------------------------------------------------------

export type UILanguage = "de" | "en" | "fr" | "ar";

// Tiny stopword sets used ONLY for redirect-language detection.
const GERMAN_STOPWORDS = new Set([
  "der", "die", "das", "ist", "wie", "bitte", "nicht", "und", "sich",
  "heute", "auch", "kann", "muss", "soll", "ein", "eine", "ich", "du",
  "mein", "meine", "kosten",
]);
const FRENCH_STOPWORDS = new Set([
  "quel", "quelle", "quels", "quelles", "me", "moi", "vous", "le", "la",
  "les", "est", "pour", "avec", "type", "niveau", "convient", "comment",
]);

// "Ausbildung" is a cross-language loan word — it must not decide the
// redirect language (an English jailbreak sentence that embeds it is still
// English). Everything else in the German lexicon is German-specific.
const GERMAN_TERMS_FOR_LANGUAGE = new Set(
  [...GERMAN_TERMS].filter((term) => term !== "ausbildung"),
);

export function detectUILanguage(raw: string): UILanguage {
  const text = raw ?? "";
  const norm = normalize(text);
  // Arabic script is unambiguous.
  if (/[\u0600-\u06ff]/.test(text)) return "ar";
  const germanMarks = /[ßäöüÄÖÜ]/.test(text);
  const frenchMarks = /[éèêëàâîïôûùÿçÉÈÊËÀÂÎÏÔÛÙŸÇ]/.test(text);
  const frenchSignal =
    containsToken(norm, FRENCH_STOPWORDS) || containsToken(norm, FRENCH_TERMS);
  const germanSignal =
    containsToken(norm, GERMAN_STOPWORDS) ||
    containsToken(norm, GERMAN_TERMS_FOR_LANGUAGE);
  // French before German: "quel type d'Ausbildung …" and "Expliquez-moi la
  // Kündigungsfrist" are French even though they contain German words.
  if (frenchMarks || frenchSignal) return "fr";
  if (germanMarks || germanSignal) return "de";
  return "en";
}

export const SCOPE_REDIRECTS: Record<UILanguage, string> = {
  de: "Ich helfe bei Ausbildung, Jobs, Bewerbungen und Karriere in Deutschland sowie bei der Nutzung von Ausbildung Hunter AI. Stelle mir gerne eine Frage zu einem dieser Themen.",
  en: "I can help with Ausbildung, jobs, applications (Bewerbungen) and careers in Germany, and with using Ausbildung Hunter AI. Please ask me a question about these topics.",
  fr: "Je peux vous aider pour la formation professionnelle (Ausbildung), les offres d'emploi, les candidatures et la carrière en Allemagne, ainsi que pour l'utilisation d'Ausbildung Hunter AI. Posez-moi une question sur l'un de ces sujets.",
  ar: "أستطيع مساعدتك في الأمور المتعلقة بـ Ausbildung والوظائف في ألمانيا وBewerbungen (طلبات التقديم) والمسار المهني، بالإضافة إلى استخدام منصة Ausbildung Hunter AI. اطرح عليّ سؤالًا متعلقًا بهذه المواضيع وسأساعدك.",
};
