import type { FaqItem } from "../types";

/** Category 12 — Deckblatt / Deckblatt
 *  NOTE: The platform does not currently offer a Deckblatt builder.
 *  Definition questions are answered with general knowledge; all
 *  "can I do it here" questions honestly state it is not available yet. */
export const deckblattItems: FaqItem[] = [
  {
    id: "deck-what",
    category: "deckblatt",
    question: {
      de: "Was ist ein Deckblatt?",
      en: "What is a cover page (Deckblatt)?",
      fr: "Qu'est-ce qu'une page de couverture (Deckblatt) ?",
      ar: "ما هو الغلاف (Deckblatt)؟",
    },
    answer: {
      de: "Ein Deckblatt ist eine erste Seite einer Bewerbungsmappe, die zusammenfasst, worum es geht: Ihr Name, die Position, Ihr Ziel und ggf. ein Foto. Es ist eine Art Zusammenfassung vor dem Lebenslauf.",
      en: "A cover page is the first page of an application folder that summarizes what it is about: your name, the position, your goal and optionally a photo. It is a kind of summary before the CV.",
      fr: "Une page de couverture est la première page d'un dossier de candidature qui résume dont il s'agit : votre nom, le poste, votre objectif et éventuellement une photo. C'est une sorte de résumé avant le CV.",
      ar: "الغلاف هو الصفحة الأولى لمجلد الطلب، تلخّص موضوعه: اسمك والمنصب وهدفك وصورة اختيارية. وهو نوع من الملخص قبل السيرة الذاتية.",
    },
    keywords: ["deckblatt", "what", "cover page"],
  },
  {
    id: "deck-is-cv",
    category: "deckblatt",
    question: {
      de: "Ist ein Deckblatt ein Lebenslauf?",
      en: "Is a cover page a CV?",
      fr: "Une page de couverture est-elle un CV ?",
      ar: "هل الغلاف سيرة ذاتية؟",
    },
    answer: {
      de: "Nein. Das Deckblatt ist keine vollständige Lebenslauf, sondern eine kurze Übersichtseite, die zusammen mit dem Lebenslauf überreicht wird.",
      en: "No. A cover page is not a full CV, but a short overview page that is submitted together with the CV.",
      fr: "Non. Une page de couverture n'est pas un CV complet, mais une page de synthèse remise avec le CV.",
      ar: "لا. الغلاف ليس سيرة ذاتية كاملة، بل صفحة موجزة تُقدَّم مع السيرة الذاتية.",
    },
    keywords: ["cv", "difference", "cover page"],
  },
  {
    id: "deck-vs-cv",
    category: "deckblatt",
    question: {
      de: "Was ist der Unterschied zwischen Deckblatt und Lebenslauf?",
      en: "What is the difference between a cover page and a CV?",
      fr: "Quelle est la différence entre page de couverture et CV ?",
      ar: "ما الفرق بين الغلاف والسيرة الذاتية؟",
    },
    answer: {
      de: "Der Lebenslauf listet alle Ihre Angaben im Detail (Ausbildung, Erfahrung, Skills). Das Deckblatt ist eine kompakte erste Seite, die den Überblick gibt.",
      en: "The CV lists all your details (education, experience, skills). The cover page is a compact first page that gives the overview.",
      fr: "Le CV détaille toutes vos informations (formation, expérience, compétences). La page de couverture est une première page compacte qui donne l'aperçu.",
      ar: "تُفصّل السيرة الذاتية جميع بياناتك (التعليم والخبرة والمهارات). أما الغلاف فهو صفحة أولى مختصرة تعطي النظرة العامة.",
    },
    keywords: ["difference", "cv", "deckblatt"],
  },
  {
    id: "deck-when",
    category: "deckblatt",
    question: {
      de: "Wann kann ein Deckblatt verwendet werden?",
      en: "When can a cover page be used?",
      fr: "Quand une page de couverture peut-elle être utilisée ?",
      ar: "متى يمكن استخدام الغلاف؟",
    },
    answer: {
      de: "Ein Deckblatt wird üblicherweise bei einer schriftlichen Bewerbungsmappe (z. B. als PDF oder ausgedruckt) verwendet. Ob es gewünscht ist, hängt von der Anzeige ab.",
      en: "A cover page is usually used with a written application folder (e.g. as PDF or printed). Whether it is wanted depends on the listing.",
      fr: "Une page de couverture est généralement utilisée avec un dossier de candidature écrit (p. ex. en PDF ou imprimé). Si elle est attendue dépend de l'offre.",
      ar: "يُستخدم الغلاف عادةً مع ملف تقديم مكتوب (مثل PDF أو مطبوع). وهل هو مطلوب يعتمد على الإعلان.",
    },
    keywords: ["when", "use", "folder"],
  },
  {
    id: "deck-how",
    category: "deckblatt",
    question: {
      de: "Kann ich ein Deckblatt in der Plattform erstellen?",
      en: "Can I create a cover page in the platform?",
      fr: "Puis-je créer une page de couverture dans la plateforme ?",
      ar: "هل يمكنني إنشاء غلاف في المنصّة؟",
    },
    answer: {
      de: "Diese Funktion ist derzeit nicht verfügbar. Ein Deckblatt-Builder ist noch nicht Teil der Plattform – Sie können ihn für Ihre Bewerbung separat erstellen.",
      en: "This feature is currently not available. A cover-page builder is not yet part of the platform – you can create it separately for your application.",
      fr: "Cette fonction n'est pas disponible pour le moment. Un éditeur de page de couverture n'est pas encore une partie de la plateforme – vous pouvez le créer séparément pour votre candidature.",
      ar: "هذه الوظيفة غير متاحة حاليًا. أداة إنشاء الغلاف ليست بعد جزءًا من المنصّة — ويمكنك إنشاؤه بشكل منفصل لطلبك.",
    },
    keywords: ["create", "not available", "builder"],
  },
  {
    id: "deck-info",
    category: "deckblatt",
    question: {
      de: "Welche Angaben enthält ein Deckblatt?",
      en: "What information does a cover page contain?",
      fr: "Quelles informations contient une page de couverture ?",
      ar: "ما المعلومات التي يحتويها الغلاف؟",
    },
    answer: {
      de: "Üblicherweise Ihr Name, die beworbene Position, Ihr Ziel oder Ihre Ausbildung, Kontaktdaten und optional ein Foto.",
      en: "Usually your name, the position you are applying for, your goal or apprenticeship, contact details and optionally a photo.",
      fr: "Habituellement votre nom, le poste visé, votre objectif ou formation, les coordonnées et éventuellement une photo.",
      ar: "عادةً اسمك والمنصب الذي تتقدم له وهدفك أو تدريبك وبيانات التواصل وصورة اختيارية.",
    },
    keywords: ["info", "fields", "contents"],
  },
  {
    id: "deck-photo",
    category: "deckblatt",
    question: {
      de: "Kann ich ein Foto auf das Deckblatt setzen?",
      en: "Can I put a photo on the cover page?",
      fr: "Puis-je mettre une photo sur la page de couverture ?",
      ar: "هل يمكنني وضع صورة على الغلاف؟",
    },
    answer: {
      de: "In der Plattform ist diese Funktion derzeit nicht verfügbar, da noch kein Deckblatt-Builder existiert. Bei einem Deckblatt, das Sie separat erstellen, ist ein Foto üblich und möglich.",
      en: "In the platform this feature is currently not available, as there is no cover-page builder yet. For a cover page you create separately, a photo is common and possible.",
      fr: "Dans la plateforme, cette fonction n'est pas disponible pour le moment, car il n'existe pas encore d'éditeur de page de couverture. Pour une page que vous créez séparément, une photo est courante et possible.",
      ar: "هذه الوظيفة غير متاحة حاليًا في المنصّة لعدم وجود أداة إنشاء غلاف بعد. أما في الغلاف الذي تنشئه بشكل منفصل فوجود صورة شائع وممكن.",
    },
    keywords: ["photo", "not available", "cover page"],
  },
  {
    id: "deck-pdf",
    category: "deckblatt",
    question: {
      de: "Kann ich ein Deckblatt als PDF herunterladen?",
      en: "Can I download a cover page as PDF?",
      fr: "Puis-je télécharger une page de couverture en PDF ?",
      ar: "هل يمكنني تنزيل غلاف كملف PDF؟",
    },
    answer: {
      de: "In der Plattform ist dies derzeit nicht verfügbar, da noch kein Deckblatt-Builder existiert. Ein Deckblatt, das Sie separat erstellen, lässt sich selbstverständlich als PDF speichern.",
      en: "In the platform this is currently not available, as there is no cover-page builder yet. A cover page you create separately can of course be saved as PDF.",
      fr: "Dans la plateforme, ce n'est pas disponible pour le moment, car il n'existe pas encore d'éditeur de page de couverture. Une page que vous créez séparément peut bien sûr être enregistrée en PDF.",
      ar: "هذه غير متاحة حاليًا في المنصّة لعدم وجود أداة إنشاء غلاف بعد. أما الغلاف الذي تنشئه بشكل منففل فيمكن حفظه كملف PDF بالطبع.",
    },
    keywords: ["pdf", "download", "not available"],
  },
];
