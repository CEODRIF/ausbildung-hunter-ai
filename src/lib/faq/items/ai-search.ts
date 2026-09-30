import type { FaqItem } from "../types";

/** Category 7 — AI Search / KI-Suche */
export const aiSearchItems: FaqItem[] = [
  {
    id: "ais-what",
    category: "ai-search",
    question: {
      de: "Was ist die KI-Suche?",
      en: "What is the AI Search?",
      fr: "Qu'est-ce que la Recherche IA ?",
      ar: "ما هو البحث بالذكاء الاصطناعي؟",
    },
    answer: {
      de: "Die KI-Suche ist eine erweiterte Suche: Ein KI-Schritt plant Ihre Anfrage und durchsucht daraufhin die Jobbörse der Bundesagentur für Arbeit und zusätzlich Webquellen – für breitere Ergebnisse.",
      en: "The AI Search is an extended search: an AI step plans your query and then searches the Federal Employment Agency's Jobbörse plus additional web sources – for broader results.",
      fr: "La Recherche IA est une recherche étendue : une étape IA planifie votre requête, puis recherche dans la Jobbörse de l'Agence fédérale et dans des sources web supplémentaires – pour des résultats plus larges.",
      ar: "البحث بالذكاء الاصطناعي هو بحث موسّع: يخطّط ذكاء اصطناعي لطلبك، ثم يبحث في لوحة وظائف وكالة العمل ومصادر ويب إضافية — للحصول على نتائج أوسع.",
    },
    keywords: ["ai search", "what", "extended"],
  },
  {
    id: "ais-how",
    category: "ai-search",
    question: {
      de: "Wie funktioniert die KI-Suche?",
      en: "How does the AI Search work?",
      fr: "Comment fonctionne la Recherche IA ?",
      ar: "كيف يعمل البحث بالذكاء الاصطناعي؟",
    },
    answer: {
      de: "Eine KI plant Ihre Suchanfrage und leitet daraus Suchabfragen ab. Diese laufen parallel: die Jobbörse der Bundesagentur für Arbeit und Webquellen. Die gefundenen Angebote werden zusammengeführt, entdupliziert und als Ergebnisliste angezeigt.",
      en: "An AI plans your search query and derives search requests from it. These run in parallel: the Federal Employment Agency's Jobbörse and web sources. The found listings are merged, deduplicated and shown as a result list.",
      fr: "Une IA planifie votre requête et en déduit des recherches. Celles-ci s'exécutent en parallèle : la Jobbörse de l'Agence fédérale et des sources web. Les offres trouvées sont fusionnées, dédupliquées et affichées comme liste de résultats.",
      ar: "يخطّط الذكاء الاصطناعي لطلبك ويشتق منه استعلامات بحث. تعمل بالتوازي: لوحة وظائف وكالة العمل ومصادر الويب. ثم تُدمج الإعلانات الموجودة وتُزال تكراراتها وتُعرض كقائمة نتائج.",
    },
    keywords: ["how", "plan", "parallel"],
  },
  {
    id: "ais-vs-normal",
    category: "ai-search",
    question: {
      de: "Was ist der Unterschied zur normalen Suche?",
      en: "What is the difference from the normal search?",
      fr: "Quelle différence avec la recherche normale ?",
      ar: "ما الفرق عن البحث العادي؟",
    },
    answer: {
      de: "Die normale Suche durchsucht nur die Jobbörse der Bundesagentur für Arbeit. Die KI-Suche plant Ihre Anfrage und wertet zusätzlich Webquellen aus, wodurch mehr und verschiedene Quellen abgedeckt werden.",
      en: "The normal search only searches the Federal Employment Agency's Jobbörse. The AI Search plans your query and additionally evaluates web sources, covering more and varied sources.",
      fr: "La recherche normale ne cherche que dans la Jobbörse de l'Agence fédérale. La Recherche IA planifie votre requête et évalue en plus des sources web, couvrant plus de sources variées.",
      ar: "البحث العادي يبحث فقط في لوحة وظائف وكالة العمل. أما البحث بالذكاء الاصطناعي فيخطّط لطلبك ويقيّم مصادر ويب إضافية، فيغطي مصادر أكثر وأكثر تنوعًا.",
    },
    keywords: ["difference", "normal", "ai"],
  },
  {
    id: "ais-ranking",
    category: "ai-search",
    question: {
      de: "Wie nutzt die KI die Ergebnisse?",
      en: "How does the AI use the results?",
      fr: "Comment l'IA utilise-t-elle les résultats ?",
      ar: "كيف يستفيد الذكاء الاصطناعي من النتائج؟",
    },
    answer: {
      de: "Die KI plant die Suchanfragen und fasst die gefundenen Angebote zusammen – inklusive einer kurzen Begründung. Die Anzeige und Reihenfolge der Ergebnisse basieren auf den Quellen und Ihrer Anfrage.",
      en: "The AI plans the search queries and summarizes the found listings – including a short rationale. The display and order of results are based on the sources and your query.",
      fr: "L'IA planifie les recherches et résume les offres trouvées – avec une brève justification. L'affichage et l'ordre des résultats se basent sur les sources et votre requête.",
      ar: "يخطّط الذكاء الاصطناعي لاستعلامات البحث ويلخّص الإعلانات الموجودة — مع تفسير موجز. ويعتمد عرض النتائج وترتيبها على المصادر وعلى طلبك.",
    },
    keywords: ["ranking", "summary", "ai"],
  },
  {
    id: "ais-invent-info",
    category: "ai-search",
    question: {
      de: "Erfindet die KI Informationen?",
      en: "Does the AI invent information?",
      fr: "L'IA invente-t-elle des informations ?",
      ar: "هل يخرع الذكاء الاصطناعي معلومات؟",
    },
    answer: {
      de: "Nein. Die KI plant und fasst zusammen, erfindet aber keine Angebote, Firmen oder Angaben. Die Ergebnisse stammen aus den durchsuchten Quellen.",
      en: "No. The AI plans and summarizes, but it does not invent listings, companies or details. The results come from the searched sources.",
      fr: "Non. L'IA planifie et résume, mais n'invente ni offres, ni entreprises, ni détails. Les résultats proviennent des sources recherchées.",
      ar: "لا. يخطّط الذكاء الاصطناعي ويلخّص، لكنه لا يخترع إعلانات أو شركات أو تفاصيل. النتائج تأتي من المصادر التي تمت رؤيتها.",
    },
    keywords: ["invent", "info", "no"],
  },
  {
    id: "ais-invent-email",
    category: "ai-search",
    question: {
      de: "Fügt die KI eine E-Mail hinzu, die es nicht gibt?",
      en: "Does the AI add an email that doesn't exist?",
      fr: "L'IA ajoute-t-elle un e-mail qui n'existe pas ?",
      ar: "هل يضيف الذكاء الاصطناعي بريدًا غير موجود؟",
    },
    answer: {
      de: "Nein. Es werden nur E-Mails übernommen, die im Originaltext des Angebots stehen und formal gültig sind. Die KI rät oder erfindet keine Adressen.",
      en: "No. Only emails that appear in the listing's original text and are formally valid are kept. The AI does not guess or invent addresses.",
      fr: "Non. Seuls les e-mails présents dans le texte original de l'offre et formellement valides sont repris. L'IA ne devine et n'invente aucune adresse.",
      ar: "لا. تُعتمد فقط العناوين الموجودة في نص الإعلان الأصلي وصحيحة الصيغة. لا يتخمن الذكاء الاصطناعي ولا يخترع عناوين.",
    },
    keywords: ["invent", "email", "no"],
  },
  {
    id: "ais-why-different",
    category: "ai-search",
    question: {
      de: "Warum können die Ergebnisse unterschiedlich ausfallen?",
      en: "Why can the results be different?",
      fr: "Pourquoi les résultats peuvent-ils différer ?",
      ar: "لماذا قد تختلف النتائج؟",
    },
    answer: {
      de: "Weil die KI Ihre Anfrage neu plant und Webquellen variieren können. Auch die Verfügbarkeit der Quellen beeinflusst, welche Ergebnisse erscheinen.",
      en: "Because the AI re-plans your query and web sources can vary. The availability of the sources also influences which results appear.",
      fr: "Parce que l'IA replanifie votre requête et que les sources web peuvent varier. La disponibilité des sources influence aussi quels résultats apparaissent.",
      ar: "لأن الذكاء الاصطناعي يعيد خطّة طلبك، وقد تتباين مصادر الويب. كما تؤثر جاهزية المصادر على النتائج التي تظهر.",
    },
    keywords: ["different", "results", "vary"],
  },
  {
    id: "ais-one-fails",
    category: "ai-search",
    question: {
      de: "Was passiert, wenn eine Suchquelle fehlschlägt?",
      en: "What happens if one search source fails?",
      fr: "Que se passe-t-il si une source de recherche échoue ?",
      ar: "ماذا يحدث إذا فشل مصدر بحث؟",
    },
    answer: {
      de: "Die Suche fährt fort und meldet den Zustand der Quelle. So können Ergebnisse der anderen Quellen weiterhin angezeigt werden, statt dass die gesamte Suche fehlschlägt.",
      en: "The search continues and reports the source's status. This way, results from the other sources can still be shown instead of the whole search failing.",
      fr: "La recherche continue et signale l'état de la source. Ainsi, les résultats des autres sources peuvent encore s'afficher au lieu que toute la recherche échoue.",
      ar: "يواصل البحث ويُبلّغ عن حالة المصدر. بهذا يمكن عرض نتائج المصادر الأخرى بدل فشل البحث كاملًا.",
    },
    keywords: ["fail", "source", "continue"],
  },
  {
    id: "ais-others-continue",
    category: "ai-search",
    question: {
      de: "Funktionieren die anderen Quellen weiter?",
      en: "Do the other sources keep working?",
      fr: "Les autres sources continuent-elles de fonctionner ?",
      ar: "هل تستمر المصادر الأخرى في العمل؟",
    },
    answer: {
      de: "Ja. Die Quellen laufen unabhängig voneinander weiter. Eine ausfallende Quelle verhindert nicht, dass die anderen liefern.",
      en: "Yes. The sources keep running independently. One failing source does not prevent the others from delivering.",
      fr: "Oui. Les sources continuent indépendamment. Une source en panne n'empêche pas les autres de livrer.",
      ar: "نعم. تعمل المصادر بشكل مستقل. فشل مصدر واحد لا يمنع المصادر الأخرى من تقديم نتائجها.",
    },
    keywords: ["continue", "others", "independent"],
  },
  {
    id: "ais-source-unavailable",
    category: "ai-search",
    question: {
      de: "Warum heißt es, eine Quelle sei nicht verfügbar?",
      en: "Why does it say a source is unavailable?",
      fr: "Pourquoi indique-t-il qu'une source est indisponible ?",
      ar: "لماذا يُقال إن مصدرًا غير متاح؟",
    },
    answer: {
      de: "Das kann passieren, wenn eine Quelle gerade überlastet ist oder nicht antwortet. Es ist meist vorübergehend – Sie können die Suche erneut ausführen.",
      en: "This can happen when a source is temporarily overloaded or not responding. It is usually transient – you can re-run the search.",
      fr: "Cela peut arriver quand une source est temporairement surchargée ou ne répond pas. C'est généralement transitoire – vous pouvez relancer la recherche.",
      ar: "قد يحدث عندما يكون مصدر مثقلًا مؤقتًا أو لا يستجيب. غالبًا هو عارض — يمكنك إعادة تشغيل البحث.",
    },
    keywords: ["unavailable", "source", "message"],
  },
  {
    id: "ais-degraded",
    category: "ai-search",
    question: {
      de: "Was bedeutet 'degraded' bzw. Teil-Ergebnisse?",
      en: "What does 'degraded' or partial results mean?",
      fr: "Que signifie « degraded » ou résultats partiels ?",
      ar: "ما معنى «degraded» أو النتائج الجزئية؟",
    },
    answer: {
      de: "Es bedeutet eine kontrollierte Teilerreichbarkeit: Die Quelle lieferte teilweise Daten oder war eingeschränkt, sodass die Ergebnisse unvollständig sein können. Die Suche zeigt dies transparent an.",
      en: "It means a controlled partial availability: the source delivered partial data or was restricted, so the results may be incomplete. The search shows this transparently.",
      fr: "Cela signifie une disponibilité partielle contrôlée : la source a livré des données partielles ou était restreinte, les résultats peuvent donc être incomplets. La recherche le signale transparentement.",
      ar: "يعني قابلية وصول جزئية مُتحكَّم بها: قدّم المصدر بيانات جزئية أو كان محدودًا، فقد تكون النتائج ناقصة. ويُظهر البحث ذلك بشفافية.",
    },
    keywords: ["degraded", "partial", "results"],
  },
  {
    id: "ais-retry",
    category: "ai-search",
    question: {
      de: "Kann ich die KI-Suche erneut ausführen?",
      en: "Can I re-run the AI Search?",
      fr: "Puis-je relancer la Recherche IA ?",
      ar: "هل يمكنني إعادة تشغيل البحث بالذكاء الاصطناعي؟",
    },
    answer: {
      de: "Ja. Sie können die Suche jederzeit erneut ausführen, um frische Ergebnisse zu erhalten – besonders nach einer vorübergehenden Störung.",
      en: "Yes. You can re-run the search any time to get fresh results – especially after a temporary outage.",
      fr: "Oui. Vous pouvez relancer la recherche à tout moment pour obtenir des résultats frais – surtout après une panne temporaire.",
      ar: "نعم. يمكنك إعادة تشغيل البحث في أي وقت للحصول على نتائج جديدة — خاصة بعد عطل مؤقت.",
    },
    keywords: ["retry", "re-run", "fresh"],
  },
];
