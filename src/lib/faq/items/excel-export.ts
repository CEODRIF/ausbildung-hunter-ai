import type { FaqItem } from "../types";

/** Category 6 — Excel Export / Excel-Export */
export const excelExportItems: FaqItem[] = [
  {
    id: "xe-how",
    category: "excel-export",
    question: {
      de: "Wie lade ich meine Ergebnisse als Excel herunter?",
      en: "How do I download my results as Excel?",
      fr: "Comment télécharger mes résultats en Excel ?",
      ar: "كيف أحمّل نتائجي كملف Excel؟",
    },
    answer: {
      de: "In den Suchergebnissen (z. B. nach der KI-Suche) wählen Sie die gewünschten Ergebnisse aus und klicken Sie auf Download Excel. Es wird eine .xlsx-Datei erzeugt und heruntergeladen.",
      en: "In the search results (e.g. after an AI Search) select the results you want and click Download Excel. A .xlsx file is generated and downloaded.",
      fr: "Dans les résultats (p. ex. après la Recherche IA), sélectionnez les résultats voulus et cliquez sur Télécharger Excel. Un fichier .xlsx est généré et téléchargé.",
      ar: "في نتائج البحث (مثلًا بعد البحث بالذكاء الاصطناعي) اختر النتائج المطلوبة وانقر تنزيل Excel. يُنشأ ملف .xlsx ويُحمَّل.",
    },
    keywords: ["excel", "download", "xlsx"],
  },
  {
    id: "xe-where-button",
    category: "excel-export",
    question: {
      de: "Wo ist der Button 'Download Excel'?",
      en: "Where is the 'Download Excel' button?",
      fr: "Où est le bouton « Télécharger Excel » ?",
      ar: "أين زر «تنزيل Excel»؟",
    },
    answer: {
      de: "Der Button befindet sich im Bereich der Suchergebnisse, wenn es exportierbare Ergebnisse mit gültiger E-Mail gibt.",
      en: "The button is in the search results area, when there are exportable results with a valid email.",
      fr: "Le bouton se trouve dans la zone des résultats, lorsqu'il y a des résultats exportables avec un e-mail valide.",
      ar: "يوجد الزر ضمن منطقة نتائج البحث عندما تكون هناك نتائج قابلة للتصدير وتحمل بريدًا صحيحًا.",
    },
    keywords: ["button", "where", "download"],
  },
  {
    id: "xe-disabled",
    category: "excel-export",
    question: {
      de: "Warum ist der Button manchmal deaktiviert?",
      en: "Why is the button sometimes disabled?",
      fr: "Pourquoi le bouton est-il parfois désactivé ?",
      ar: "لماذا يكون الزر معطّلًا أحيانًا؟",
    },
    answer: {
      de: "Der Button ist deaktiviert, wenn aktuell keine exportierbare Zeile vorliegt – also kein Ergebnis mit gültiger E-Mail ausgewählt oder gefunden ist.",
      en: "The button is disabled when there is currently no exportable row – i.e. no result with a valid email is selected or found.",
      fr: "Le bouton est désactivé lorsqu'aucune ligne exportable n'est disponible – c'est-à-dire qu'aucun résultat avec e-mail valide n'est sélectionné ou trouvé.",
      ar: "يكون الزر معطّلًا عندما لا يتوفر صف قابل للتصدير حاليًا — أي لم يتم اختيار أو إيجاد نتيجة بريد صحيح.",
    },
    keywords: ["disabled", "button", "why"],
  },
  {
    id: "xe-missing-rows",
    category: "excel-export",
    question: {
      de: "Warum fehlen manche Ergebnisse in Excel?",
      en: "Why are some results missing from Excel?",
      fr: "Pourquoi certains résultats manquent-ils dans Excel ?",
      ar: "لماذا تنقص بعض النتائج من Excel؟",
    },
    answer: {
      de: "Weil nur Zeilen mit gültiger E-Mail exportiert werden, Duplikate entfernt werden und die Anzahl begrenzt ist. Ergebnisse ohne E-Mail erscheinen daher nicht in der Datei.",
      en: "Because only rows with a valid email are exported, duplicates are removed and the count is bounded. Results without an email therefore do not appear in the file.",
      fr: "Parce que seules les lignes avec e-mail valide sont exportées, les doublons sont retirés et le nombre est limité. Les résultats sans e-mail n'apparaissent donc pas dans le fichier.",
      ar: "لأنه يُصدَّر فقط الصفوف التي لها بريد صحيح، وتُحذف المكررات، والعدد محدود. لذلك لا تظهر النتائج بدون بريد في الملف.",
    },
    keywords: ["missing", "rows", "excel"],
  },
  {
    id: "xe-dedupe",
    category: "excel-export",
    question: {
      de: "Werden doppelte E-Mails entfernt?",
      en: "Are duplicate emails removed?",
      fr: "Les e-mails en double sont-ils retirés ?",
      ar: "هل تُحذف عناوين البريد المكررة؟",
    },
    answer: {
      de: "Ja. Die Entduplizierung erfolgt ohne Unterschied zwischen Groß- und Kleinschreibung und ohne Berücksichtigung von Leerzeichen.",
      en: "Yes. Deduplication is case-insensitive and ignores surrounding whitespace.",
      fr: "Oui. La déduplication ignore les majuscules et minuscules ainsi que les espaces superflus.",
      ar: "نعم. تتم إزالة التكرار بغضّ النظر عن الأحرف الكبيرة والصغيرة وال فراغات الزائدة.",
    },
    keywords: ["dedupe", "duplicate", "email"],
  },
  {
    id: "xe-which-kept",
    category: "excel-export",
    question: {
      de: "Welches Ergebnis bleibt, wenn dieselbe E-Mail mehrfach vorkommt?",
      en: "Which result is kept when the same email appears multiple times?",
      fr: "Quel résultat est conservé quand le même e-mail apparaît plusieurs fois ?",
      ar: "أي نتيجة تُحتفظ بها إذا تكرّر نفس البريد؟",
    },
    answer: {
      de: "Der erste, bestbewertete Eintrag bleibt erhalten – spätere Duplikate werden weggelassen.",
      en: "The first, highest-ranked entry is kept – later duplicates are dropped.",
      fr: "Le premier élément le mieux classé est conservé – les doublons suivants sont supprimés.",
      ar: "يُحتفظ بالبيان الأول والأعلى تقييمًا — وتُترك المكررات اللاحقة.",
    },
    keywords: ["kept", "first", "duplicate"],
  },
  {
    id: "xe-columns",
    category: "excel-export",
    question: {
      de: "Welche Spalten enthält das Excel?",
      en: "Which columns does the Excel contain?",
      fr: "Quelles colonnes contient l'Excel ?",
      ar: "ما الأعمدة الموجودة في Excel؟",
    },
    answer: {
      de: "Firma, Ausbildungstitel, E-Mail, Telefon, Ort, Bundesland, Startdatum, Bewerbungsfrist, Firmen-Website, Bewerbungs-URL, Quell-URL, Anforderungen, weitere nützliche Informationen, Quellentyp und zusätzliche Quellen – plus eine Zählspalte.",
      en: "Company, apprenticeship title, email, phone, location, state, start date, application deadline, company website, application URL, source URL, requirements, other useful information, source type and additional sources – plus an index column.",
      fr: "Entreprise, titre de la formation, e-mail, téléphone, lieu, land, date de début, date limite de candidature, site de l'entreprise, URL de candidature, URL source, exigences, autres informations utiles, type de source et sources supplémentaires – plus une colonne d'index.",
      ar: "الشركة، عنوان التدريب، البريد، الهاتف، الموقع، الولاية، تاريخ البدء، آخر موعد للتقديم، موقع الشركة، رابط التقديم، رابط المصدر، المتطلبات، معلومات مفيدة أخرى، نوع المصدر، والمصادر الإضافية — مع عمود ترقيم.",
    },
    keywords: ["columns", "fields", "excel"],
  },
  {
    id: "xe-search-details",
    category: "excel-export",
    question: {
      de: "Gibt es ein Blatt mit Suchdetails?",
      en: "Is there a sheet with search details?",
      fr: "Y a-t-il un onglet avec les détails de la recherche ?",
      ar: "هل توجد ورقة بتفاصيل البحث؟",
    },
    answer: {
      de: "Ja. Ein zweites Blatt 'Search details' listet Zeitstempel, Ziel, angefragte und gefundene Anzahl, Anzahl mit gültiger E-Mail, entfernte Duplikate, exportierte Anzahl, Filterbeschreibung, Quelle und die Begründung der KI.",
      en: "Yes. A second sheet 'Search details' lists the timestamp, goal, requested and found counts, count with a valid email, removed duplicates, exported count, filter description, source and the AI rationale.",
      fr: "Oui. Un second onglet « Search details » liste l'horodatage, l'objectif, le nombre demandé et trouvé, le nombre avec e-mail valide, les doublons retirés, le nombre exporté, la description des filtres, la source et la justification de l'IA.",
      ar: "نعم. تدرج ورقة ثانية «تفاصيل البحث» الطابع الزمني، الهدف، العدد المطلوب والموجود، عدد العناوين الصحيحة، المكررات المحذوفة، العدد المصدَّر، وصف عوامل التصفية، المصدر، وتفسير الذكاء الاصطناعي.",
    },
    keywords: ["search details", "sheet", "info"],
  },
  {
    id: "xe-no-email",
    category: "excel-export",
    question: {
      de: "Was passiert, wenn keine Ergebnisse eine E-Mail haben?",
      en: "What happens if no results have an email?",
      fr: "Que se passe-t-il si aucun résultat n'a d'e-mail ?",
      ar: "ماذا يحدث إذا لم تكن للنتائج عناوين بريد؟",
    },
    answer: {
      de: "Dann gibt es keine exportierbare Zeile: Der Export zeigt entsprechend an, dass keine gültigen E-Mails vorlagen, und es wird nichts erfunden.",
      en: "Then there is no exportable row: the export indicates accordingly that no valid emails were present, and nothing is invented.",
      fr: "Alors il n'y a aucune ligne exportable : l'export indique qu'aucun e-mail valide n'était présent, et rien n'est inventé.",
      ar: "في هذه الحالة لا يوجد صف قابل للتصدير: يُظهر التصدير أن هناك عناوين صحيحة موجودة، ولا يُخترع شيء.",
    },
    keywords: ["no email", "empty", "export"],
  },
  {
    id: "xe-real-xlsx",
    category: "excel-export",
    question: {
      de: "Ist das Excel eine echte .xlsx-Datei?",
      en: "Is the Excel a real .xlsx file?",
      fr: "L'Excel est-il un vrai fichier .xlsx ?",
      ar: "هل ملف Excel حقيقي بصيغة .xlsx؟",
    },
    answer: {
      de: "Ja. Die Datei wird als echte .xlsx erzeugt und kann direkt in Excel oder LibreOffice geöffnet werden.",
      en: "Yes. The file is generated as a real .xlsx and can be opened directly in Excel or LibreOffice.",
      fr: "Oui. Le fichier est généré en .xlsx réel et peut être ouvert directement dans Excel ou LibreOffice.",
      ar: "نعم. يُنشأ الملف بصيغة .xlsx حقيقية ويمكن فتحه مباشرة في Excel أو LibreOffice.",
    },
    keywords: ["xlsx", "real", "file"],
  },
];
