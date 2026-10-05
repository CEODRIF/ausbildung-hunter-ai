import type { LegalDoc } from "./types";

/**
 * AI Usage content — grounded in the actual implementation:
 * OpenAI-compatible API (AI_API_URL) for chat/scanner/generation,
 * Google Gemini for AI Search web grounding; assistant is scoped to the
 * platform domain; files up to 5 per request, 10 MB each.
 */
export const aiUsageDoc: LegalDoc = {
  slug: "ai-usage",
  title: {
    de: "KI-Nutzung",
    en: "AI Usage",
    fr: "Utilisation de l'IA",
    ar: "استخدام الذكاء الاصطناعي",
  },
  intro: {
    de: "Diese Seite erklärt, welche Funktionen AusbildungsWeg mit KI arbeiten, welche Daten dabei an KI-Dienste übermittelt werden und welche Einschränkungen Sie beachten sollten. Sie beschreibt das tatsächliche Verhalten der Plattform.",
    en: "This page explains which AusbildungsWeg features run with AI, what data is transmitted to AI services in the process, and what limitations you should be aware of. It describes the platform's actual behavior.",
    fr: "Cette page explique quelles fonctionnalités d'AusbildungsWeg fonctionnent avec l'IA, quelles données sont transmises aux services IA dans ce processus et quelles limites vous devez connaître. Elle décrit le comportement réel de la plateforme.",
    ar: "تشرح هذه الصفحة الميزات التي تعمل بالذكاء الاصطناعي في منصّة AusbildungsWeg، وأي بيانات تُرسَل إلى خدمات الذكاء الاصطناعي، وما القيود التي يجب مراعاتها. وهي تصف السلوك الفعلي للمنصّة.",
  },
  sections: [
    {
      id: "features",
      title: {
        de: "Funktionen mit KI",
        en: "AI Features",
        fr: "Fonctionnalités avec IA",
        ar: "الميزات التي تعمل بالذكاء الاصطناعي",
      },
      li: [
        {
          de: "KI-Assistent: beantwortet Fragen zu Ausbildung, Jobs in Deutschland, Bewerbungen, Lebenslauf, Anschreiben und zur Nutzung der Plattform; analysiert hochgeladene Dateien.",
          en: "AI Assistant: answers questions about apprenticeships, jobs in Germany, applications, CV, cover letter and platform usage; analyzes uploaded files.",
          fr: "Assistant IA : répond aux questions sur l'alternance, les emplois en Allemagne, les candidatures, le CV, la lettre de motivation et l'utilisation de la plateforme ; analyse les fichiers téléversés.",
          ar: "المساعد الذكي: يجيب عن أسئلة التدريب والعمل في ألمانيا وطلبات التقديم والسيرة الذاتية وخطاب التقديم واستخدام المنصّة؛ ويحلل الملفات المرفوعة.",
        },
        {
          de: "Bewerbungsscan: extrahiert strukturierte Angaben (Ausbildung, Erfahrung, Kenntnisse, Sprachen, Kontaktdaten, Stärken, fehlende Informationen) aus Ihren hochgeladenen Dokumenten.",
          en: "Application Scanner: extracts structured details (education, experience, skills, languages, contact info, strengths, missing information) from your uploaded documents.",
          fr: "Scan de candidature : extrait des informations structurées (formation, expérience, compétences, langues, coordonnées, points forts, informations manquantes) de vos documents téléversés.",
          ar: "ماسح الطلبات: يستخرج بيانات منظمة (التعليم، الخبرة، المهارات، اللغات، بيانات التواصل، النقاط القوية، المعلومات المفقودة) من مستنداتك المرفوعة.",
        },
        {
          de: "CV-Analyse / Import: Der CV-Builder übernimmt die aus dem Bewerbungsscan erkannten Angaben; es findet dabei keine eigene KI-Analyse statt.",
          en: "CV analysis / import: the CV Builder takes over the details recognized by the Application Scanner; no separate AI analysis takes place.",
          fr: "Analyse / import du CV : l'éditeur de CV reprend les informations reconnues par le Scan de candidature ; aucune analyse IA séparée n'a lieu.",
          ar: "تحليل السيرة/الاستيراد: يستلم منشئ السيرة البيانات المعترف بها من ماسح الطلبات؛ ولا يتم أي تحليل ذكاء اصطناعي منفصل.",
        },
        {
          de: "Dokumentenanalyse: Der KI-Assistent liest Anhänge (PDF, DOC, DOCX, TXT, Bilder) und bezieht deren Inhalt in die Antwort ein.",
          en: "Document analysis: the AI Assistant reads attachments (PDF, DOC, DOCX, TXT, images) and incorporates their content into the answer.",
          fr: "Analyse de documents : l'Assistant IA lit les pièces jointes (PDF, DOC, DOCX, TXT, images) et intègre leur contenu à la réponse.",
          ar: "تحليل المستندات: يقرأ المساعد الذكي المرفقات (PDF، DOC، DOCX، TXT، صور) ويدمج محتواها في الإجابة.",
        },
        {
          de: "KI-generierte Texte: Das Anschreiben kann per KI erstellt werden, gestützt auf Ihre tatsächlichen Angaben.",
          en: "AI-generated text: the cover letter can be created with AI, based on your real details.",
          fr: "Textes générés par IA : la lettre de motivation peut être créée par IA, sur la base de vos informations réelles.",
          ar: "النصوص المولّدة بالذكاء الاصطناعي: يمكن إنشاء خطاب التقديم بالذكاء الاصطناعي، اعتمادًا على بياناتك الحقيقية.",
        },
        {
          de: "KI-Suche: Eine KI plant Ihre Suchanfrage; die Web-Erkundung nutzt Google Gemini als Grounding-Dienst, danach werden gefundene Inhalte erneut strukturiert und entdupliziert.",
          en: "AI Search: an AI plans your search query; the web exploration uses Google Gemini as a grounding service, after which the found content is restructured and deduplicated.",
          fr: "Recherche IA : une IA planifie votre requête ; l'exploration web utilise Google Gemini comme service de grounding, après quoi le contenu trouvé est restructuré et dédupliqué.",
          ar: "البحث بالذكاء الاصطناعي: يخطّط الذكاء الاصطناعي لطلبك؛ ويستخدم الاستكشاف في الويب Google Gemini كخدمة تثبيت، ثم تُعاد هيكلة المحتوى الموجود وإزالة تكراراته.",
        },
      ],
    },
    {
      id: "data-to-ai",
      title: {
        de: "Welche Daten an KI-Dienste übermittelt werden",
        en: "What Data Is Transmitted to AI Services",
        fr: "Quelles données sont transmises aux services IA",
        ar: "البيانات التي تُرسَل إلى خدمات الذكاء الاصطناعي",
      },
      p: [
        {
          de: "Damit die KI-Funktionen arbeiten können, übermittelt die Plattform serverseitig an die konfigurierten KI-Dienste:",
          en: "For the AI features to work, the platform transmits server-side to the configured AI services:",
          fr: "Pour que les fonctions IA puissent fonctionner, la plateforme transmet côté serveur aux services IA configurés :",
          ar: "لكي تعمل ميزات الذكاء الاصطناعي، ترسل المنصّة من الخادم إلى خدمات الذكاء الاصطناعي المهيأة:",
        },
      ],
      li: [
        {
          de: "KI-Assistent: Ihre Nachrichtentexte sowie – falls angehängt – der Inhalt der Dateien (bis zu fünf Dateien pro Anfrage, je 10 MB).",
          en: "AI Assistant: your message texts plus – if attached – the content of the files (up to five files per request, 10 MB each).",
          fr: "Assistant IA : vos textes de messages ainsi que – si jointes – le contenu des fichiers (jusqu'à cinq fichiers par requête, 10 Mo chacun).",
          ar: "المساعد الذكي: نصوص رسائلك، بالإضافة إلى محتوى الملفات عند إرفاقها (حتى خمسة ملفات في كل طلب، 10 ميغابايت لكل منها).",
        },
        {
          de: "Bewerbungsscan: Der aus Ihren Dokumenten extrahierte Text plus Ihre Scan-Einstellungen (z. B. Ziel).",
          en: "Application Scanner: the text extracted from your documents plus your scan settings (e.g. goal).",
          fr: "Scan de candidature : le texte extrait de vos documents plus vos réglages de scan (p. ex. objectif).",
          ar: "ماسح الطلبات: النص المستخرج من مستنداتك بالإضافة إلى إعدادات المسح (مثل الهدف).",
        },
        {
          de: "KI-Suche: Ihre Suchbegriffe sowie die von der Suche erfassten Angebotstexte (zur Strukturierung und Entduplizierung).",
          en: "AI Search: your search terms plus the listing texts captured by the search (for structuring and deduplication).",
          fr: "Recherche IA : vos termes de recherche ainsi que les textes d'offres capturés par la recherche (pour la structuration et la déduplication).",
          ar: "البحث بالذكاء الاصطناعي: كلمات بحثك بالإضافة إلى نصوص الإعلانات التي يلتقطها البحث (لأجل الهيكلة وإزالة التكرار).",
        },
        {
          de: "Anschreiben: Die von Ihnen angegebenen Angaben (Stelle, Unternehmen, Ton, Sprache) plus Ihre Profil- und CV-Angaben, soweit vorhanden.",
          en: "Cover letter: the details you provide (position, company, tone, language) plus your profile and CV details, where present.",
          fr: "Lettre de motivation : les informations que vous fournissez (poste, entreprise, ton, langue) plus vos informations de profil et de CV, le cas échéant.",
          ar: "خطاب التقديم: البيانات التي تزوّد بها (المنصب، الشركة، الأسلوب، اللغة) بالإضافة إلى بيانات ملفك وسيرتك إذا وُجدت.",
        },
      ],
      pAfter: [
        {
          de: "Es werden keine Daten an KI-Dienste übertragen, die nicht für die von Ihnen ausgelöste Funktion erforderlich sind. Die Übertragung erfolgt an: einen OpenAI-kompatiblen API-Dienst (für Assistent, Scan, Generierung) und an die Google Gemini API (nur für das Web-Grounding der KI-Suche). Ihre Daten werden von uns nicht an Werbedienste oder andere Dritte zu anderen Zwecken übermittelt.",
          en: "No data is transmitted to AI services that is not required for the feature you triggered. Transmission goes to: an OpenAI-compatible API service (for assistant, scanner, generation) and to the Google Gemini API (only for the AI Search web grounding). Your data is not transmitted by us to advertising services or other third parties for other purposes.",
          fr: "Aucune donnée n'est transmise aux services IA qui n'est pas requise pour la fonctionnalité que vous avez déclenchée. La transmission va vers : un service d'API compatible OpenAI (assistant, scan, génération) et vers la Google Gemini API (uniquement pour le grounding web de la Recherche IA). Vos données ne sont pas transmises par nous à des services de publicité ou à d'autres tiers à d'autres fins.",
          ar: "لا تُرسل أي بيانات إلى خدمات الذكاء الاصطناعي غير الضرورية للميزة التي أطلقتها. وتتم الإرسال إلى: خدمة API متوافقة مع OpenAI (للمساعد والماسح والتوليد)، وإلى Google Gemini API (لأجل تثبيت الويب في البحث بالذكاء الاصطناعي فقط). ولا ترسل المنصّة بياناتك إلى خدمات إعلانية أو أطراف ثالثة أخرى لأغراض أخرى.",
        },
      ],
    },
    {
      id: "your-data",
      title: {
        de: "Was mit Ihren Daten passiert",
        en: "What Happens to Your Data",
        fr: "Ce qui arrive à vos données",
        ar: "ماذا يحدث لبياناتك",
      },
      li: [
        {
          de: "Gespeichert in Ihrem Konto: Ihre KI-Gespräche, hochgeladenen Dateien und erkannten Profile werden in Ihrem Konto (Supabase) gespeichert – in privaten, pro Nutzer getrennten Bereichen.",
          en: "Stored in your account: your AI conversations, uploaded files and recognized profiles are stored in your account (Supabase) – in private, per-user separated areas.",
          fr: "Stockées dans votre compte : vos conversations IA, fichiers téléversés et profils reconnus sont stockés dans votre compte (Supabase) – dans des zones privées, séparées par utilisateur.",
          ar: "محفوظة في حسابك: محادثاتك مع الذكاء الاصطناعي وملفاتك المرفوعة وملفاتك المعترف بها تُحفظ في حسابك (Supabase) — في مناطق خاصة مفصولة لكل مستخدم.",
        },
        {
          de: "Gelöscht mit dem Konto: Bei der Kontolöschung werden diese Daten und Dateien gelöscht (siehe Datenlöschung).",
          en: "Deleted with the account: on account deletion, this data and files are deleted (see Data Deletion).",
          fr: "Supprimées avec le compte : lors de la suppression du compte, ces données et fichiers sont supprimés (voir Suppression des données).",
          ar: "تُحذف مع الحساب: عند حذف الحساب تُحذف هذه البيانات والملفات (انظر حذف البيانات).",
        },
        {
          de: "Keine Weiterverwendung: Ihre Inhalte werden nicht für das Training von Modellen durch die Plattform verwendet und nicht an andere Nutzer ausgegeben.",
          en: "No further use: your content is not used by the platform to train models and is not shared with other users.",
          fr: "Aucune réutilisation : votre contenu n'est pas utilisé par la plateforme pour l'entraînement de modèles et n'est pas communiqué à d'autres utilisateurs.",
          ar: "لا إعادة استخدام: لا تُستخدم محتوياتك من قِبَل المنصّة لتدريب النماذج ولا تُشارك مع مستخدمين آخرين.",
        },
        {
          de: "Hinweis zu KI-Anbietern: Die Übertragung an die KI-Dienste erfolgt technisch über deren APIs; deren eigene Bearbeitungs- und Aufbewahrungsrichtlinien betreffen die Übertragungsdaten und sind von Ihnen über die jeweiligen Anbieter einzusehen.",
          en: "Note on AI providers: transmission to the AI services technically goes through their APIs; their own processing and retention policies apply to the transmitted data and should be consulted with the respective providers.",
          fr: "Note sur les fournisseurs IA : la transmission vers les services IA passe techniquement par leurs API ; leurs propres politiques de traitement et de conservation s'appliquent aux données transmises et sont à consulter auprès des fournisseurs respectifs.",
          ar: "ملاحظة حول مزودي الذكاء الاصطناعي: يتم الإرسال تقنيًا عبر واجهاتهم البرمجية؛ وسياساتهم الخاصة في المعالجة والاحتفاظ تنطبق على البيانات المرسلة ويُستحسن الاطلاع عليها لدى المزودين المعنيين.",
        },
      ],
      to: "/data-deletion",
      toLabel: {
        de: "Zur Seite Löschung von Daten",
        en: "To the Data Deletion page",
        fr: "Vers la page Suppression des données",
        ar: "إلى صفحة حذف البيانات",
      },
    },
    {
      id: "limitations",
      title: {
        de: "Wichtige Einschränkungen",
        en: "Important Limitations",
        fr: "Limites importantes",
        ar: "قيود مهمة",
      },
      li: [
        {
          de: "KI kann sich irren: Antworten, Extraktionen und generierte Texte können unvollständig, ungenau oder veraltet sein. Prüfen Sie alle Ergebnisse, bevor Sie sie verwenden.",
          en: "AI can be wrong: answers, extractions and generated texts can be incomplete, inaccurate or outdated. Check all results before using them.",
          fr: "L'IA peut se tromper : réponses, extractions et textes générés peuvent être incomplets, inexactes ou obsolètes. Vérifiez tous les résultats avant de les utiliser.",
          ar: "قد يخطئ الذكاء الاصطناعي: الإجابات والاستخراجات والنصوص المولّدة قد تكون ناقصة أو غير دقيقة أو قديمة. راجع جميع النتائج قبل استخدامها.",
        },
        {
          de: "Kein Beschäftigungsversprechen: Die KI gibt keine Garantie für den Erhalt einer Ausbildung oder einer Stelle.",
          en: "No employment promise: the AI gives no guarantee of obtaining an apprenticeship or a job.",
          fr: "Aucune promesse d'embauche : l'IA ne donne aucune garantie d'obtenir une alternance ou un emploi.",
          ar: "لا وعود توظيف: لا يعطي الذكاء الاصطناعي أي ضمان للحصول على تدريب أو وظيفة.",
        },
        {
          de: "Verifizieren Sie Firmenangaben: Überprüfen Sie Angaben zu Unternehmen, Stellen und Fristen vor der Bewerbung bei der Quelle bzw. dem Unternehmen.",
          en: "Verify company details: check details about companies, positions and deadlines with the source or company before applying.",
          fr: "Vérifiez les informations sur les entreprises : contrôlez les informations sur les entreprises, les postes et les délais auprès de la source ou de l'entreprise avant de postuler.",
          ar: "تحقق من بيانات الشركات: راجع المعلومات عن الشركات والمناصب والمواعيد لدى المصدر أو الشركة قبل التقديم.",
        },
        {
          de: "Kein Arbeitgeber: Die KI und die Plattform sind keine Arbeitgeberin und treten nicht für ein Unternehmen auf.",
          en: "Not an employer: the AI and the platform are not an employer and do not act on behalf of a company.",
          fr: "Pas un employeur : l'IA et la plateforme ne sont pas un employeur et n'agissent au nom d'aucune entreprise.",
          ar: "ليس صاحب عمل: الذكاء الاصطناعي والمنصّة ليسا صاحبَي عمل ولا يعملان نيابة عن أي شركة.",
        },
        {
          de: "Keine Rechtsberatung: Die KI gibt keine Rechtsberatung und keine verbindliche rechtliche Auskunft.",
          en: "No legal advice: the AI gives no legal advice and no binding legal information.",
          fr: "Pas de conseil juridique : l'IA ne donne pas de conseil juridique ni d'information juridique contraignante.",
          ar: "لا استشارة قانونية: لا يقدم الذكاء الاصطناعي استشارة قانونية ولا معلومات قانونية ملزمة.",
        },
        {
          de: "Kein offizieller Migrationsrat: Die KI ersetzt keine offizielle Beratungsstelle für Einreise, Aufenthalt oder Visafragen.",
          en: "No official immigration advice: the AI does not replace an official advisory office for entry, residence or visa questions.",
          fr: "Pas de conseil officiel en immigration : l'IA ne remplace pas un bureau de conseil officiel pour les questions d'entrée, de résidence ou de visa.",
          ar: "لا نصيحة هجرة رسمية: لا يغني الذكاء الاصطناعي عن مراكز الاستشارة الرسمية لقضايا الدخول والإقامة والتأشيرات.",
        },
        {
          de: "Kein spezialisierter Finanzrat: Die KI gibt keine spezialisierte Finanz- oder Steuerberatung.",
          en: "No specialized financial advice: the AI gives no specialized financial or tax advice.",
          fr: "Pas de conseil financier spécialisé : l'IA ne donne pas de conseil financier ou fiscal spécialisé.",
          ar: "لا استشارة مالية متخصصة: لا يقدم الذكاء الاصطناعي استشارة مالية أو ضريبية متخصصة.",
        },
      ],
    },
    {
      id: "scope",
      title: {
        de: "Abgrenzung und Umfang",
        en: "Scope and Boundaries",
        fr: "Périmètre et limites",
        ar: "النطاق والحدود",
      },
      p: [
        {
          de: "Der KI-Assistent ist ein spezialisierter Assistent für diese Plattform und nicht allgemeiner Chatbot. Fragen, die deutlich außerhalb von Ausbildung, Jobs in Deutschland, Bewerbungen, Lebenslauf, Anschreiben und der Plattform liegen, werden höflich abgelehnt oder auf das Thema zurückgeführt.",
          en: "The AI Assistant is a specialist assistant for this platform, not a general chatbot. Questions clearly outside apprenticeships, jobs in Germany, applications, CV, cover letter and the platform are politely declined or redirected back to the topic.",
          fr: "L'Assistant IA est un assistant spécialisé pour cette plateforme, pas un chatbot général. Les questions clairement hors de l'alternance, des emplois en Allemagne, des candidatures, du CV, de la lettre et de la plateforme sont poliment refusées ou redirigées vers le sujet.",
          ar: "المساعد الذكي مساعد متخصص لهذه المنصّة وليس روبوت محادثة عامًا. والأسئلة البعيدة عن التدريب والعمل في ألمانيا وطلبات التقديم والسيرة وخطاب التقديم والمنصّة ترفض بلطف أو تُعاد إلى الموضوع.",
        },
        {
          de: "Die KI erfindet keine Fakten: E-Mail-Adressen, Firmen und Links werden weder berechnet noch geraten – nur Angaben aus den durchsuchten Quellen bzw. aus Ihren Dokumenten werden übernommen.",
          en: "The AI invents no facts: email addresses, companies and links are neither computed nor guessed – only details from the searched sources or from your documents are taken over.",
          fr: "L'IA n'invente aucun fait : les adresses e-mail, les entreprises et les liens ne sont ni calculés ni devinés – seules les informations des sources consultées ou de vos documents sont reprises.",
          ar: "لا يخترع الذكاء الاصطناعي الوقائع: لا تُحسب عناوين البريد ولا الشركات ولا الروابط ولا تتخمن — بل تُعتمد فقط المعلومات من المصادر المستفتاة أو من مستنداتك.",
        },
      ],
    },
    {
      id: "questions",
      title: {
        de: "Fragen zur KI-Nutzung",
        en: "Questions about AI Usage",
        fr: "Questions sur l'utilisation de l'IA",
        ar: "أسئلة حول استخدام الذكاء الاصطناعي",
      },
      p: [
        {
          de: "Fragen zu KI-Funktionen, Fehlern oder Anliegen können Sie über die Kontaktseite stellen.",
          en: "Questions about AI features, errors or concerns can be submitted via the Contact page.",
          fr: "Les questions sur les fonctions IA, les erreurs ou les préoccupations peuvent être soumises via la page Contact.",
          ar: "يمكنك تقديم الأسئلة حول ميزات الذكاء الاصطناعي أو الأخطاء أو المخاوف عبر صفحة الاتصال.",
        },
      ],
      to: "/contact",
      toLabel: {
        de: "Zur Kontaktseite",
        en: "To the Contact page",
        fr: "Vers la page Contact",
        ar: "إلى صفحة الاتصال",
      },
    },
  ],
};
