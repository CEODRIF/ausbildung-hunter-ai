import type { FaqItem } from "../types";

/** Category 16 — Privacy & Security / Datenschutz & Sicherheit */
export const privacyItems: FaqItem[] = [
  {
    id: "pv-private",
    category: "privacy",
    question: {
      de: "Sind meine Daten privat?",
      en: "Is my data private?",
      fr: "Mes données sont-elles privées ?",
      ar: "هل بياناتي خاصة؟",
    },
    answer: {
      de: "Ja. Ihre Daten sind an Ihr Konto geknüpft und nur für Sie zugänglich. Die Plattform ist so gestaltet, dass andere Nutzer Ihre Inhalte nicht sehen können.",
      en: "Yes. Your data is bound to your account and accessible only to you. The platform is designed so other users cannot see your content.",
      fr: "Oui. Vos données sont liées à votre compte et accessibles uniquement par vous. La plateforme est conçue pour que d'autres utilisateurs ne puissent pas voir votre contenu.",
      ar: "نعم. بياناتك مرتبطة بحسابك ولا يملك الوصول إليها إلا أنت. صُممت المنصّة بحيث لا يمكن للمستخدمين الآخرين رؤية محتوياتك.",
    },
    keywords: ["private", "security", "data"],
  },
  {
    id: "pv-cv-visible",
    category: "privacy",
    question: {
      de: "Kann ein anderer Nutzer meinen Lebenslauf sehen?",
      en: "Can another user see my CV?",
      fr: "Un autre utilisateur peut-il voir mon CV ?",
      ar: "هل يمكن لمستخدم آخر رؤية سيرتي الذاتية؟",
    },
    answer: {
      de: "Nein. Ihr Lebenslauf und Ihre gescannten Unterlagen sind an Ihr Konto gebunden und für andere Nutzer nicht sichtbar.",
      en: "No. Your CV and your scanned documents are bound to your account and are not visible to other users.",
      fr: "Non. Votre CV et vos documents scannés sont liés à votre compte et ne sont pas visibles par les autres utilisateurs.",
      ar: "لا. سيرتك الذاتية ومستنداتك الممسوحة مرتبطة بحسابك ولا يراها المستخدمون الآخرون.",
    },
    keywords: ["cv", "visible", "no"],
  },
  {
    id: "pv-saved-visible",
    category: "privacy",
    question: {
      de: "Kann ein anderer Nutzer meine gespeicherten Stellen sehen?",
      en: "Can another user see my saved jobs?",
      fr: "Un autre utilisateur peut-il voir mes offres enregistrées ?",
      ar: "هل يمكن لمستخدم آخر رؤية الوظائف المحفوظة لدي؟",
    },
    answer: {
      de: "Nein. Gespeicherte Stellen sind privat und gehören zu Ihrem Konto.",
      en: "No. Saved jobs are private and belong to your account.",
      fr: "Non. Les offres enregistrées sont privées et appartiennent à votre compte.",
      ar: "لا. الوظائف المحفوظة خاصة وتابعة لحسابك.",
    },
    keywords: ["saved", "visible", "no"],
  },
  {
    id: "pv-chat-visible",
    category: "privacy",
    question: {
      de: "Kann ein anderer Nutzer meine Gespräche sehen?",
      en: "Can another user see my conversations?",
      fr: "Un autre utilisateur peut-il voir mes conversations ?",
      ar: "هل يمكن لمستخدم آخر رؤية محادثاتى؟",
    },
    answer: {
      de: "Nein. Ihre KI-Gespräche sind an Ihr Konto gebunden und privat.",
      en: "No. Your AI conversations are bound to your account and are private.",
      fr: "Non. Vos conversations IA sont liées à votre compte et privées.",
      ar: "لا. محادثاتك مع الذكاء الاصطناعي مرتبطة بحسابك وخاصة بك.",
    },
    keywords: ["chat", "visible", "no"],
  },
  {
    id: "pv-protected",
    category: "privacy",
    question: {
      de: "Wie wird mein Konto geschützt?",
      en: "How is my account protected?",
      fr: "Comment mon compte est-il protégé ?",
      ar: "كيف يحمى حسابي؟",
    },
    answer: {
      de: "Der Zugriff erfolgt nur mit angemeldetem Konto, sensible Aktionen werden serverseitig geprüft und Ihre Daten sind pro Nutzer getrennt.",
      en: "Access is only possible with a signed-in account, sensitive actions are verified server-side and your data is separated per user.",
      fr: "L'accès n'est possible qu'avec un compte connecté, les actions sensibles sont vérifiées côté serveur et vos données sont séparées par utilisateur.",
      ar: "لا يتم الوصول إلا بحساب مسجّل الدخول، وتُفحص الإجراءات الحساسة على الخادم، وتُفصل بياناتك عن كل مستخدم.",
    },
    keywords: ["protected", "security", "account"],
  },
  {
    id: "pv-files-account",
    category: "privacy",
    question: {
      de: "Sind meine Dateien mit meinem Konto verknüpft?",
      en: "Are my files linked to my account?",
      fr: "Mes fichiers sont-ils liés à mon compte ?",
      ar: "هل ملفاتى مرتبطة بحسابي؟",
    },
    answer: {
      de: "Ja. Hochgeladene Dateien (z. B. aus dem Bewerbungsscan) sind an Ihr Konto gebunden und stehen nur Ihnen zur Verfügung.",
      en: "Yes. Uploaded files (e.g. from the Application Scanner) are bound to your account and are available only to you.",
      fr: "Oui. Les fichiers téléversés (p. ex. du Scan de candidature) sont liés à votre compte et disponibles uniquement pour vous.",
      ar: "نعم. الملفات المرفوعة (مثل تلك من ماسح الطلبات) مرتبطة بحسابك ومتاحة لك وحدك.",
    },
    keywords: ["files", "linked", "account"],
  },
  {
    id: "pv-other-user",
    category: "privacy",
    question: {
      de: "Kann ein anderer Nutzer meine Daten sehen?",
      en: "Can another user see my data?",
      fr: "Un autre utilisateur peut-il voir mes données ?",
      ar: "هل يمكن لمستخدم آخر رؤية بياناتي؟",
    },
    answer: {
      de: "Nein. Alle Ihre Inhalte sind pro Nutzer getrennt; ein anderer Nutzer hat keinen Zugriff darauf.",
      en: "No. All your content is separated per user; another user has no access to it.",
      fr: "Non. Tout votre contenu est séparé par utilisateur ; un autre utilisateur n'y a pas accès.",
      ar: "لا. كل محتوياتك مفصولة لكل مستخدم، ولا يملك مستخدم آخر وصولًا إليها.",
    },
    keywords: ["other user", "access", "no"],
  },
  {
    id: "pv-contact-invent",
    category: "privacy",
    question: {
      de: "Werden Kontaktdaten erfunden?",
      en: "Are contact details invented?",
      fr: "Les coordonnées sont-elles inventées ?",
      ar: "هل تُخترع بيانات التواصل؟",
    },
    answer: {
      de: "Nein. Die Plattform erfindet keine Kontaktdaten. Angaben werden nur übernommen, wenn sie in der Quelle tatsächlich vorhanden sind.",
      en: "No. The platform invents no contact details. Details are only taken over when they are actually present in the source.",
      fr: "Non. La plateforme n'invente aucune coordonnée. Les informations ne sont reprises que lorsqu'elles sont réellement présentes dans la source.",
      ar: "لا. لا تخترع المنصّة بيانات تواصل. تُعتمد البيانات فقط عندما تكون موجودة فعلًا في المصدر.",
    },
    keywords: ["contact", "invent", "no"],
  },
  {
    id: "pv-email-guess",
    category: "privacy",
    question: {
      de: "Werden E-Mails geraten?",
      en: "Are emails guessed?",
      fr: "Les e-mails sont-ils devinés ?",
      ar: "هل يُتخمَّن عناوين البريد؟",
    },
    answer: {
      de: "Nein. Es werden ausschließlich E-Mail-Adressen verwendet, die im Originaltext vorkommen und formal gültig sind. Die Plattform rät oder berechnet keine Adressen.",
      en: "No. Only email addresses that occur in the original text and are formally valid are used. The platform does not guess or compute addresses.",
      fr: "Non. Seules les adresses e-mail présentes dans le texte original et formellement valides sont utilisées. La plateforme ne devine et ne calcule aucune adresse.",
      ar: "لا. تُستخدم فقط عناوين البريد الموجودة في النص الأصلي وصحيحة الصيغة. لا تتخمن المنصّة ولا تحسب عناوين.",
    },
    keywords: ["email", "guess", "no"],
  },
  {
    id: "pv-sensitive",
    category: "privacy",
    question: {
      de: "Wie sollte ich mit sensiblen Daten umgehen?",
      en: "How should I handle sensitive data?",
      fr: "Comment gérer des données sensibles ?",
      ar: "كيف أتعامل مع البيانات الحساسة؟",
    },
    answer: {
      de: "Geben Sie nur Informationen weiter, die Sie für Ihre Bewerbung verwenden möchten. Prüfen Sie hochgeladene Dokumente vor dem Versenden, und nutzen Sie den Export sowie die Löschung unter Daten & Privacy, wenn Sie Daten entfernen wollen.",
      en: "Only share information you want to use for your application. Check uploaded documents before sending, and use the export and deletion under Data & Privacy to remove data.",
      fr: "Ne partagez que des informations que vous voulez utiliser pour votre candidature. Vérifiez les documents téléversés avant l'envoi et utilisez l'export et la suppression dans Données et confidentialité pour retirer des données.",
      ar: "شارك فقط المعلومات التي تريد استخدامها في طلبك. راجع المستندات المرفوعة قبل الإرسال، واستخدم التصدير والحذف ضمن البيانات والخصوصية إذا أردت إزالة بيانات.",
    },
    keywords: ["sensitive", "handle", "advice"],
  },
];
