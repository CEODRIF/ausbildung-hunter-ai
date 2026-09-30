import type { FaqItem } from "../types";

/** Category 2 — Account & Profile / Konto & Profil */
export const accountItems: FaqItem[] = [
  {
    id: "account-edit-profile",
    category: "account",
    question: {
      de: "Wie bearbeite ich mein Profil?",
      en: "How do I edit my profile?",
      fr: "Comment modifier mon profil ?",
      ar: "كيف أعدّل ملفي الشخصي؟",
    },
    answer: {
      de: "Ihr Name wird bei der Registrierung festgelegt und kann derzeit nicht direkt bearbeitet werden. Sprache, Erscheinungsbild, E-Mail-Konto und Daten verwalten Sie unter Einstellungen.",
      en: "Your name is set at registration and cannot currently be edited directly. You manage language, appearance, email account and data under Settings.",
      fr: "Votre nom est défini à l'inscription et ne peut pas être modifié directement pour l'instant. Gérez la langue, l'apparence, le compte e-mail et les données dans Réglages.",
      ar: "يُحدَّد اسمك عند التسجيل ولا يمكن تعديله مباشرةً حاليًا. تدير اللغة والمظهر وحساب البريد والبيانات من الإعدادات.",
    },
    keywords: ["profile", "edit", "name"],
  },
  {
    id: "account-change-language",
    category: "account",
    question: {
      de: "Wo kann ich die Sprache ändern?",
      en: "Where can I change the language?",
      fr: "Où puis-je changer la langue ?",
      ar: "أين يمكنني تغيير اللغة؟",
    },
    answer: {
      de: "In der Kopfzeile über die Sprachumschaltung – Deutsch, English, Français oder العربية.",
      en: "In the header, via the language switcher – German, English, French or Arabic.",
      fr: "Dans l'en-tête, via le sélecteur de langue – allemand, anglais, français ou arabe.",
      ar: "من الشريط العلوي عبر مبدّل اللغة — الألمانية أو الإنجليزية أو الفرنسية أو العربية.",
    },
    keywords: ["language", "settings"],
  },
  {
    id: "account-theme",
    category: "account",
    question: {
      de: "Wie ändere ich das Erscheinungsbild (hell/dunkel)?",
      en: "How do I change the theme (light/dark)?",
      fr: "Comment changer l'apparence (clair/sombre) ?",
      ar: "كيف أغيّر المظهر (فاتح/داكن)؟",
    },
    answer: {
      de: "Über den Schalter in der Kopfzeile: Hell, Dunkel oder System.",
      en: "Via the switch in the header: Light, Dark or System.",
      fr: "Via l'interrupteur dans l'en-tête : Clair, Sombre ou Système.",
      ar: "عبر المبدّل في الشريط العلوي: فاتح، داكن، أو حسب النظام.",
    },
    keywords: ["theme", "dark", "light"],
  },
  {
    id: "account-stored-data",
    category: "account",
    question: {
      de: "Welche Daten speichert die Plattform über mich?",
      en: "What data does the platform store about me?",
      fr: "Quelles données la plateforme stocke-t-elle sur moi ?",
      ar: "ما البيانات التي تخزّنها المنصّة عني؟",
    },
    answer: {
      de: "Ihr Profil, gespeicherte Stellen, Bewerbungsentwürfe, E-Mail-Kampagnen und -Nachrichten, KI-Gespräche, gescannte Unterlagen sowie Nutzungs- und Aktivitätsprotokolle.",
      en: "Your profile, saved jobs, application drafts, email campaigns and messages, AI conversations, scanned documents, plus usage and activity logs.",
      fr: "Votre profil, les offres enregistrées, les brouillons de candidature, les campagnes et messages e-mail, les conversations IA, les documents scannés, ainsi que les journaux d'utilisation et d'activité.",
      ar: "ملفك الشخصي، الوظائف المحفوظة، مسودات الطلبات، حملات البريد ورسائله، محادثات الذكاء الاصطناعي، المستندات الممسوحة، وسجلات الاستخدام والنشاط.",
    },
    keywords: ["data", "privacy", "stored"],
  },
  {
    id: "account-export",
    category: "account",
    question: {
      de: "Kann ich meine Daten exportieren?",
      en: "Can I export my data?",
      fr: "Puis-je exporter mes données ?",
      ar: "هل يمكنني تصدير بياناتي؟",
    },
    answer: {
      de: "Ja. Unter Einstellungen → Daten & Privacy können Sie alle Ihre Daten als JSON-Datei herunterladen.",
      en: "Yes. Under Settings → Data & Privacy you can download all your data as a JSON file.",
      fr: "Oui. Dans Réglages → Données et confidentialité, vous pouvez télécharger toutes vos données au format JSON.",
      ar: "نعم. من الإعدادات ← البيانات والخصوصية يمكنك تنزيل جميع بياناتك كملف JSON.",
    },
    keywords: ["export", "json", "data"],
  },
  {
    id: "account-delete",
    category: "account",
    question: {
      de: "Kann ich mein Konto löschen?",
      en: "Can I delete my account?",
      fr: "Puis-je supprimer mon compte ?",
      ar: "هل يمكنني حذف حسابي؟",
    },
    answer: {
      de: "Ja. Unter Einstellungen → Daten & Privacy können Sie Ihr Konto und Ihre Daten endgültig löschen. Zur Sicherheit geben Sie dabei Ihre Kontoe-Mail ein.",
      en: "Yes. Under Settings → Data & Privacy you can permanently delete your account and your data. For safety, you confirm by typing your account email.",
      fr: "Oui. Dans Réglages → Données et confidentialité, vous pouvez supprimer définitivement votre compte et vos données. Pour votre sécurité, vous confirmez en saisissant l'e-mail de votre compte.",
      ar: "نعم. من الإعدادات ← البيانات والخصوصية يمكنك حذف حسابك وبياناتك نهائيًا. ولأمانك تُؤكّد ذلك بكتابة بريد حسابك.",
    },
    keywords: ["delete", "account", "erase", "gdpr"],
  },
  {
    id: "account-isolation",
    category: "account",
    question: {
      de: "Wie sind meine Daten vor anderen Nutzern getrennt?",
      en: "How is my data isolated from other users?",
      fr: "Comment mes données sont-elles isolées des autres utilisateurs ?",
      ar: "كيف تُعزل بياناتي عن المستخدمين الآخرين؟",
    },
    answer: {
      de: "Alle Daten sind an Ihre Benutzer-ID geknüpft und durch serverseitige Zugriffskontrollen geschützt. Ein anderer Nutzer kann Ihre Daten nicht sehen.",
      en: "All data is bound to your user ID and protected by server-side access controls. Another user cannot see your data.",
      fr: "Toutes les données sont liées à votre identifiant et protégées par des contrôles d'accès côté serveur. Un autre utilisateur ne peut pas voir vos données.",
      ar: "كل البيانات مرتبطة بمعرّفك ومحمية بتحكّم في الوصول على الخادم. لا يمكن لمستخدم آخر رؤية بياناتك.",
    },
    keywords: ["isolation", "security", "privacy"],
  },
  {
    id: "account-logout",
    category: "account",
    question: {
      de: "Was passiert, wenn ich mich abmelde?",
      en: "What happens when I log out?",
      fr: "Que se passe-t-il quand je me déconnecte ?",
      ar: "ماذا يحدث عند تسجيل الخروج؟",
    },
    answer: {
      de: "Ihre Sitzung wird beendet, aber Ihre Daten bleiben sicher in Ihrem Konto gespeichert. Beim nächsten Anmelden finden Sie alles wieder.",
      en: "Your session ends, but your data stays safely stored in your account. When you sign in again, everything is there.",
      fr: "Votre session se termine, mais vos données restent stockées en sécurité dans votre compte. Lors de la prochaine connexion, tout est à sa place.",
      ar: "ينتهي تسجيل الدخول، لكن بياناتك تبقى محفوظة بأمان في حسابك. عند تسجيل الدخول مجددًا تجد كل شيء كما هو.",
    },
    keywords: ["logout", "session", "data"],
  },
  {
    id: "account-retention",
    category: "account",
    question: {
      de: "Bleiben meine Daten nach dem Logout erhalten?",
      en: "Is my data kept after logging out?",
      fr: "Mes données sont-elles conservées après la déconnexion ?",
      ar: "هل تُحفظ بياناتي بعد تسجيل الخروج؟",
    },
    answer: {
      de: "Ja. Der Logout beendet nur die Sitzung; Ihre Inhalte bleiben in Ihrem Konto und sind nach dem erneuten Anmelden verfügbar.",
      en: "Yes. Logging out only ends the session; your content stays in your account and is available when you sign back in.",
      fr: "Oui. La déconnexion ne met fin qu'à la session ; votre contenu reste dans votre compte et est disponible à la reconnexion.",
      ar: "نعم. تسجيل الخروج يُنهي الجلسة فقط؛ تبقى محتوياتك في حسابك وتكون متاحة عند تسجيل الدخول مجددًا.",
    },
    keywords: ["logout", "retention"],
  },
  {
    id: "account-secure",
    category: "account",
    question: {
      de: "Wie sicher ist mein Konto?",
      en: "How secure is my account?",
      fr: "Quelle est la sécurité de mon compte ?",
      ar: "ما مدى أمان حسابي؟",
    },
    answer: {
      de: "Der Zugriff erfolgt nur mit angemeldetem Konto, sensible Aktionen werden serverseitig geprüft und Ihre Daten sind pro Nutzer getrennt.",
      en: "Access is only possible with a signed-in account, sensitive actions are verified server-side, and your data is separated per user.",
      fr: "L'accès n'est possible qu'avec un compte connecté, les actions sensibles sont vérifiées côté serveur et vos données sont séparées par utilisateur.",
      ar: "لا يتم الوصول إلا بحساب مسجّل الدخول، وتُفحص الإجراءات الحساسة على الخادم، وتُفصل بياناتك عن كل مستخدم.",
    },
    keywords: ["security", "safe", "protection"],
  },
  {
    id: "account-problem",
    category: "account",
    question: {
      de: "Was tun, wenn es ein Problem mit meinem Konto gibt?",
      en: "What should I do if there is a problem with my account?",
      fr: "Que faire s'il y a un problème avec mon compte ?",
      ar: "ماذا أفعل إذا حدثت مشكلة في حسابي؟",
    },
    answer: {
      de: "Melden Sie sich ab und wieder an. Bei einem gesperrten oder fehlenden Konto wenden Sie sich an den Plattform-Betreiber.",
      en: "Sign out and sign back in. For a suspended or missing account, contact the platform owner.",
      fr: "Déconnectez-vous puis reconnectez-vous. En cas de compte suspendu ou manquant, contactez le propriétaire de la plateforme.",
      ar: "سجّل الخروج ثم ادخل مجددًا. وإذا كان الحساب موقوفًا أو مفقودًا، تواصل مع مالك المنصّة.",
    },
    keywords: ["account", "problem", "suspended"],
  },
];
