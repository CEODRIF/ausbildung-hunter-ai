import type { FaqItem } from "../types";

/** Category 4 — Saved Opportunities / Gespeicherte Stellen */
export const savedItems: FaqItem[] = [
  {
    id: "saved-how",
    category: "saved",
    question: {
      de: "Wie speichere ich eine Ausbildung?",
      en: "How do I save an apprenticeship?",
      fr: "Comment enregistrer une alternance ?",
      ar: "كيف أحفظ تدريبًا مهنيًا؟",
    },
    answer: {
      de: "Klicken Sie auf das Lesezeichen-Symbol beim Suchergebnis oder auf der Detailseite. Die Stelle wird in Ihrem Konto gespeichert.",
      en: "Click the bookmark icon on the search result or on the detail page. The job is saved to your account.",
      fr: "Cliquez sur l'icône signet sur le résultat ou sur la page de détail. L'offre est enregistrée dans votre compte.",
      ar: "انقر على أيقونة الإحفظ في نتيجة البحث أو في صفحة التفاصيل. تُحفظ الوظيفة في حسابك.",
    },
    keywords: ["save", "bookmark", "ausbildung"],
  },
  {
    id: "saved-where",
    category: "saved",
    question: {
      de: "Wo finde ich meine gespeicherten Stellen?",
      en: "Where do I find my saved jobs?",
      fr: "Où trouver mes offres enregistrées ?",
      ar: "أين أجد الوظائف المحفوظة؟",
    },
    answer: {
      de: "Unter Gespeicherte Stellen in der Seitenleiste – alle Ihre gemerkten Angebote auf einer Seite.",
      en: "Under Saved Opportunities in the sidebar – all your bookmarked listings on one page.",
      fr: "Sous Offres enregistrées dans la barre latérale – toutes vos offres signalées sur une page.",
      ar: "ضمن «الوظائف المحفوظة» في الشريط الجانبي — كل إعلاناتك المحفوظة في صفحة واحدة.",
    },
    keywords: ["saved", "where", "list"],
  },
  {
    id: "saved-tied-account",
    category: "saved",
    question: {
      de: "Sind meine gespeicherten Stellen mit meinem Konto verknüpft?",
      en: "Are my saved jobs linked to my account?",
      fr: "Mes offres enregistrées sont-elles liées à mon compte ?",
      ar: "هل الوظائف المحفوظة مرتبطة بحسابي؟",
    },
    answer: {
      de: "Ja. Gespeicherte Stellen gehören zu Ihrem Konto und sind nur für Sie sichtbar.",
      en: "Yes. Saved jobs belong to your account and are visible only to you.",
      fr: "Oui. Les offres enregistrées appartiennent à votre compte et ne sont visibles que par vous.",
      ar: "نعم. الوظائف المحفوظة تابعة لحسابك ولا يراها إلا أنت.",
    },
    keywords: ["account", "linked", "private"],
  },
  {
    id: "saved-after-logout",
    category: "saved",
    question: {
      de: "Verschwinden sie nach dem Logout?",
      en: "Do they disappear after logging out?",
      fr: "Disparaissent-elles après la déconnexion ?",
      ar: "هل تختفي بعد تسجيل الخروج؟",
    },
    answer: {
      de: "Nein. Gespeicherte Stellen bleiben in Ihrem Konto, auch wenn Sie sich abmelden. Sie finden sie nach dem erneuten Anmelden wieder.",
      en: "No. Saved jobs stay in your account even when you sign out. You will find them again after signing back in.",
      fr: "Non. Les offres enregistrées restent dans votre compte, même après la déconnexion. Vous les retrouverez à la reconnexion.",
      ar: "لا. تبقى الوظائف المحفوظة في حسابك حتى بعد تسجيل الخروج. ستجدها عند تسجيل الدخول مجددًا.",
    },
    keywords: ["logout", "retention", "persist"],
  },
  {
    id: "saved-delete",
    category: "saved",
    question: {
      de: "Wie lösche ich eine gespeicherte Stelle?",
      en: "How do I delete a saved job?",
      fr: "Comment supprimer une offre enregistrée ?",
      ar: "كيف أحذف وظيفة محفوظة؟",
    },
    answer: {
      de: "Öffnen Sie Gespeicherte Stellen und entfernen Sie die gewünschte Stelle. Sie wird aus Ihrer Liste gelöscht.",
      en: "Open Saved Opportunities and remove the job you want. It is deleted from your list.",
      fr: "Ouvrez Offres enregistrées et supprimez l'offre voulue. Elle est retirée de votre liste.",
      ar: "افتح الوظائف المحفوظة واحذف الوظيفة المطلوبة. ستُحذف من قائمتك.",
    },
    keywords: ["delete", "remove", "saved"],
  },
  {
    id: "saved-open-original",
    category: "saved",
    question: {
      de: "Kann ich das Originalangebot öffnen?",
      en: "Can I open the original listing?",
      fr: "Puis-je ouvrir l'offre originale ?",
      ar: "هل يمكنني فتح الإعلان الأصلي؟",
    },
    answer: {
      de: "Ja. Jede gespeicherte Stelle verlinkt auf das Originalangebot, das sich in einem neuen Tab öffnet.",
      en: "Yes. Each saved job links to the original listing, which opens in a new tab.",
      fr: "Oui. Chaque offre enregistrée renvoie vers l'offre originale, qui s'ouvre dans un nouvel onglet.",
      ar: "نعم. كل وظيفة محفوظة تحمل رابطًا إلى الإعلان الأصلي، ويفتح في تبويب جديد.",
    },
    keywords: ["original", "open", "link"],
  },
  {
    id: "saved-changed",
    category: "saved",
    question: {
      de: "Was passiert, wenn sich das Originalangebot ändert?",
      en: "What happens if the original listing changes?",
      fr: "Que se passe-t-il si l'offre originale change ?",
      ar: "ماذا يحدث إذا تغيّر الإعلان الأصلي؟",
    },
    answer: {
      de: "Ihr Eintrag speichert einen Momentaufnahme-Stand der Stelle. Die Details können sich im Original ändern oder die Stelle ausgeschrieben werden – der Link führt immer zur aktuellen Quelle.",
      en: "Your entry stores a snapshot of the job. The details may change or the listing may be withdrawn in the original – the link always leads to the current source.",
      fr: "Votre entrée conserve une image de l'offre à un instant. Les détails peuvent changer ou l'offre être retirée à l'origine – le lien mène toujours à la source actuelle.",
      ar: "تخزّن إدخالك لقطة من حالة الوظيفة. قد تتغيّر التفاصيل أو يُغلق الإعلان في الأصل — والرابط يظلّ يقود إلى المصدر الحالي.",
    },
    keywords: ["changed", "snapshot", "withdrawn"],
  },
  {
    id: "saved-apply-from",
    category: "saved",
    question: {
      de: "Kann ich von einer gespeicherten Stelle aus eine Bewerbung senden?",
      en: "Can I send an application from a saved job?",
      fr: "Puis-je envoyer une candidature depuis une offre enregistrée ?",
      ar: "هل يمكنني إرسال طلب من وظيفة محفوظة؟",
    },
    answer: {
      de: "Ja. Sie können aus einer Stelle eine Bewerbung vorbereiten – die verfügbaren Angaben des Angebots füllen Ihre Bewerbung automatisch vor, ohne dass etwas erfunden wird.",
      en: "Yes. You can prepare an application from a job – the available details of the listing pre-fill your application, with nothing invented.",
      fr: "Oui. Vous pouvez préparer une candidature depuis une offre – les détails disponibles de l'offre préremplissent votre candidature, sans rien inventer.",
      ar: "نعم. يمكنك تجهيز طلب من وظيفة — تُعبّأ بياناتك تلقائيًا من تفاصيل الإعلان المتوفرة دون اختراع أي شيء.",
    },
    keywords: ["apply", "prefill", "bewerbung"],
  },
];
