import type { LegalDoc } from "./types";

/**
 * Data Deletion content — grounded in the implemented erasure flow:
 * Settings → Data & Privacy (JSON export + delete with typed-email
 * confirmation); deleteUserAccount removes application drafts, then the
 * auth user (cascades all user FK tables), then a private storage sweep.
 * Aborts on failure — no partial deletion.
 */
export const dataDeletionDoc: LegalDoc = {
  slug: "data-deletion",
  title: {
    de: "Löschung von Daten",
    en: "Data Deletion",
    fr: "Suppression des données",
    ar: "حذف البيانات",
  },
  intro: {
    de: "Diese Seite erklärt, welche Daten zu Ihrem Konto gehören, wie Sie Ihr Konto und damit alle verknüpften Daten endgültig löschen, was davon nicht betroffen ist und wie Sie einen Antrag über die Kontaktseite stellen.",
    en: "This page explains which data belongs to your account, how to permanently delete your account and all linked data, what is not affected, and how to submit a request via the Contact page.",
    fr: "Cette page explique quelles données appartiennent à votre compte, comment supprimer définitivement votre compte et toutes les données liées, ce qui n'est pas affecté et comment soumettre une demande via la page Contact.",
    ar: "تشرح هذه الصفحة البيانات التابعة لحسابك، وكيف تحذف حسابك نهائيًا مع جميع البيانات المرتبطة به، وما الذي لا يتأثر، وكيفية تقديم طلب عبر صفحة الاتصال.",
  },
  sections: [
    {
      id: "what-belongs",
      title: {
        de: "Welche Daten zu Ihrem Konto gehören",
        en: "What Data Belongs to Your Account",
        fr: "Quelles données appartiennent à votre compte",
        ar: "البيانات التابعة لحسابك",
      },
      p: [
        {
          de: "Zu Ihrem Konto gehören insbesondere:",
          en: "Your account includes in particular:",
          fr: "Votre compte comprend notamment :",
          ar: "يشمل حسابك على سبيل الخصوص:",
        },
      ],
      li: [
        {
          de: "Kontoinformationen: Name, E-Mail-Adresse, Benutzer-ID, Kontostatus, gewähltes Ziel.",
          en: "Account information: name, email address, user ID, account status, chosen goal.",
          fr: "Informations du compte : nom, adresse e-mail, identifiant utilisateur, statut du compte, objectif choisi.",
          ar: "معلومات الحساب: الاسم، البريد الإلكتروني، معرّف المستخدم، حالة الحساب، الهدف المختار.",
        },
        {
          de: "CV / Lebenslauf: Ihr aus dem Bewerbungsscan erkanntes Profil und hochgeladene CV-Dateien.",
          en: "CV: your profile recognized from the Application Scanner and uploaded CV files.",
          fr: "CV : votre profil reconnu du Scan de candidature et les fichiers de CV téléversés.",
          ar: "السيرة الذاتية: ملفك المستخرج من ماسح الطلبات وملفات السيرة المرفوعة.",
        },
        {
          de: "Bewerbungen und Applications: Entwürfe, Kampagnen, Nachrichten, Empfänger, Anhänge und Versandstatus.",
          en: "Applications: drafts, campaigns, messages, recipients, attachments and delivery status.",
          fr: "Candidatures : brouillons, campagnes, messages, destinataires, pièces jointes et statut d'envoi.",
          ar: "طلبات التقديم: المسودات، الحملات، الرسائل، المستلمون، المرفقات، وحالة الإرسال.",
        },
        {
          de: "Gespeicherte Stellenangebote (Saved Opportunities).",
          en: "Saved Opportunities.",
          fr: "Offres enregistrées (Saved Opportunities).",
          ar: "الوظائف المحفوظة.",
        },
        {
          de: "KI-Gespräche: Ihre Konversationen und Nachrichten im KI-Assistenten sowie die hochgeladenen Anhänge.",
          en: "AI conversations: your conversations and messages in the AI Assistant plus the uploaded attachments.",
          fr: "Conversations IA : vos conversations et messages dans l'Assistant IA ainsi que les pièces jointes téléversées.",
          ar: "محادثات الذكاء الاصطناعي: محادثاتك ورسائلك في المساعد الذكي والمرفقات المرفوعة.",
        },
        {
          de: "Hochgeladene Dateien: Dokumente, Bilder und andere Dateien in Ihren privaten Bereichen.",
          en: "Uploaded files: documents, images and other files in your private areas.",
          fr: "Fichiers téléversés : documents, images et autres fichiers dans vos zones privées.",
          ar: "الملفات المرفوعة: المستندات والصور والملفات الأخرى في مناطقك الخاصة.",
        },
        {
          de: "E-Mail-Daten: Verknüpfungsdaten Ihres E-Mail-Kontos, Kampagnen und Nachrichtenprotokolle.",
          en: "Email data: your email account connection data, campaigns and message logs.",
          fr: "Données e-mail : données de connexion de votre compte e-mail, campagnes et journaux de messages.",
          ar: "بيانات البريد: بيانات ربط حساب بريدك، الحملات، وسجلات الرسائل.",
        },
        {
          de: "Benachrichtigungen und deren Lesezustand sowie Nutzungs- und Aktivitätsprotokolle.",
          en: "Notifications and their read state, plus usage and activity logs.",
          fr: "Notifications et leur statut de lecture, ainsi que les journaux d'utilisation et d'activité.",
          ar: "الإشعارات وحالتها كمقروءة، بالإضافة إلى سجلات الاستخدام والنشاط.",
        },
      ],
    },
    {
      id: "how-to-delete",
      title: {
        de: "So löschen Sie Ihr Konto",
        en: "How to Delete Your Account",
        fr: "Comment supprimer votre compte",
        ar: "كيف تحذف حسابك",
      },
      p: [
        {
          de: "Die Löschung ist direkt in der Plattform umgesetzt:",
          en: "Deletion is implemented directly in the platform:",
          fr: "La suppression est implémentée directement dans la plateforme :",
          ar: "الحذف مطبَّق مباشرة داخل المنصّة:",
        },
      ],
      li: [
        {
          de: "Melden Sie sich an und öffnen Sie Einstellungen → Daten & Privacy.",
          en: "Sign in and open Settings → Data & Privacy.",
          fr: "Connectez-vous et ouvrez Réglages → Données et confidentialité.",
          ar: "سجّل الدخول وافتح الإعدادات ← البيانات والخصوصية.",
        },
        {
          de: "Laden Sie vor der Löschung optional Ihren JSON-Export herunter, falls Sie eine Kopie Ihrer Daten behalten möchten.",
          en: "Optionally, before deletion, download your JSON export if you want to keep a copy of your data.",
          fr: "Facultativement, avant la suppression, téléchargez votre export JSON si vous souhaitez conserver une copie de vos données.",
          ar: "اختياريًا، قبل الحذف، نزّل نسخة التصدير JSON إذا أردت الاحتفاظ بنسخة من بياناتك.",
        },
        {
          de: "Starten Sie die Löschung und bestätigen Sie sie, indem Sie die E-Mail-Adresse Ihres Kontos exakt eingeben. Diese Bestätigung schützt vor versehentlichem Löschen.",
          en: "Start the deletion and confirm it by typing your account email address exactly. This confirmation protects against accidental deletion.",
          fr: "Lancez la suppression et confirmez-la en saisissant exactement l'adresse e-mail de votre compte. Cette confirmation protège d'une suppression accidentelle.",
          ar: "ابدأ الحذف وأكّده بكتابة بريد حسابك حرفيًا. هذا التأكيد يحمي من الحذف بالخطأ.",
        },
        {
          de: "Die Löschung erfolgt serverseitig: Zuerst werden die anhängigen Daten bereinigt, dann wird das Konto gelöscht (wobei alle verknüpften Datensätze mitgelöscht werden) und anschließend werden Ihre Dateien aus den privaten Speicherbereichen entfernt. Schlägt ein Schritt fehl, wird der Vorgang abgebrochen – es kommt nicht zu einem teilweisen Löschen.",
          en: "Deletion happens server-side: first pending data is cleaned up, then the account is deleted (with all linked records removed), and afterwards your files are removed from the private storage areas. If a step fails, the operation is aborted – there is no partial deletion.",
          fr: "La suppression a lieu côté serveur : d'abord les données pendants sont nettoyées, puis le compte est supprimé (avec tous les enregistrements liés), puis vos fichiers sont retirés des zones de stockage privé. Si une étape échoue, l'opération est interrompue – il n'y a pas de suppression partielle.",
          ar: "يتم الحذف من الخادم: أولًا تُنظَّف البيانات المعلقة، ثم يُحذف الحساب (مع حذف جميع السجلات المرتبطة)، وبعد ذلك تُزال ملفاتك من مناطق التخزين الخاصة. وإذا فشل أحد الخطوات يُوقف الإجراء — فلا يوجد حذف جزئي.",
        },
      ],
    },
    {
      id: "not-affected",
      title: {
        de: "Was nicht betroffen ist",
        en: "What Is Not Affected",
        fr: "Ce qui n'est pas affecté",
        ar: "ما الذي لا يتأثر",
      },
      li: [
        {
          de: "Bereits versendete E-Mails: Bewerbungen und E-Mails, die über Ihr eigenes Gmail- oder Outlook-Konto versendet wurden, verbleiben in Ihrem Postfach. Die Kontolöschung in der Plattform löscht nichts in Ihrem E-Mail-Postfach.",
          en: "Emails already sent: applications and emails sent through your own Gmail or Outlook account remain in your mailbox. Platform account deletion removes nothing from your email mailbox.",
          fr: "E-mails déjà envoyés : les candidatures et e-mails envoyés via votre propre compte Gmail ou Outlook restent dans votre boîte aux lettres. La suppression du compte dans la plateforme ne retire rien de votre boîte.",
          ar: "الرسائل المرسلة بالفعل: الطلبات والرسائل المرسلة عبر حساب Gmail أو Outlook الخاص بك تبقى في صندوق بريدك. حذف الحساب في المنصّة لا يحذف شيئًا من صندوق بريدك.",
        },
        {
          de: "Lokale Browserdaten: CV- und Anschreiben-Entwürfe sowie Einstellungen in Ihrem Browser (localStorage) verbleiben auf Ihrem Gerät, bis Sie den Browser-Speicher leeren.",
          en: "Local browser data: CV and cover letter drafts as well as settings in your browser (localStorage) remain on your device until you clear browser storage.",
          fr: "Données locales du navigateur : les brouillons de CV et de lettre ainsi que les réglages dans votre navigateur (localStorage) restent sur votre appareil jusqu'à ce que vous effaciez le stockage.",
          ar: "بيانات المتصفح المحلية: مسودات السيرة وخطاب التقديم والإعدادات في متصفحك تبقى على جهازك حتى تمسح تخزين المتصفح.",
        },
        {
          de: "Dienste Dritter: Die Löschung bezieht sich auf Ihre Daten in der Plattform. Daten, die an externe Dienste (z. B. KI-Anbieter) übermittelt wurden, unterliegen den jeweiligen Richtlinien dieser Anbieter.",
          en: "Third-party services: the deletion concerns your data in the platform. Data that was transmitted to external services (e.g. AI providers) is subject to those providers' respective policies.",
          fr: "Services tiers : la suppression concerne vos données dans la plateforme. Les données transmises à des services externes (p. ex. fournisseurs IA) relèvent des politiques respectives de ces fournisseurs.",
          ar: "خدمات الطرف الثالث: يخص الحذف بياناتك في المنصّة. والبيانات التي أُرسِلت إلى خدمات خارجية (مثل مزودي الذكاء الاصطناعي) تخضع لسياسات تلك المزودين.",
        },
      ],
    },
    {
      id: "request",
      title: {
        de: "Antrag über die Kontaktseite",
        en: "Request via the Contact Page",
        fr: "Demande via la page Contact",
        ar: "طلب عبر صفحة الاتصال",
      },
      p: [
        {
          de: "Wenn Sie sich nicht mehr anmelden können, Ihr Konto auf andere Weise löschen möchten oder Fragen haben, können Sie einen Löschungsantrag über die Kontaktseite stellen (Thema: Data Deletion Requests). Der Antrag wird über den dortigen Kanal bearbeitet; bitte nennen Sie in der Anfrage die E-Mail-Adresse des betroffenen Kontos, damit es zugeordnet werden kann.",
          en: "If you can no longer sign in, want to delete your account in another way, or have questions, you can submit a deletion request via the Contact page (topic: Data Deletion Requests). The request is processed through the channel provided there; please state the affected account's email address in the request so it can be matched.",
          fr: "Si vous ne pouvez plus vous connecter, souhaitez supprimer votre compte d'une autre manière ou avez des questions, vous pouvez soumettre une demande de suppression via la page Contact (sujet : Demandes de suppression de données). La demande est traitée via le canal indiqué ; veuillez indiquer dans la demande l'adresse e-mail du compte concerné afin qu'elle puisse être associée.",
          ar: "إذا تعذّر تسجيل دخولك، أو أردت حذف حسابك بطريقة أخرى، أو كان لديك أسئلة، يمكنك تقديم طلب حذف عبر صفحة الاتصال (الموضوع: طلبات حذف البيانات). ويُعالَج الطلب عبر القناة المذكورة هناك؛ ويرجى ذكر بريد الحساب المعني في الطلب ليُطابق.",
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
    {
      id: "before",
      title: {
        de: "Vor der Löschung: Export",
        en: "Before Deletion: Export",
        fr: "Avant la suppression : export",
        ar: "قبل الحذف: التصدير",
      },
      p: [
        {
          de: "Bevor Sie Ihr Konto löschen, können Sie Ihre Daten als JSON-Datei herunterladen (Einstellungen → Daten & Privacy). Der Export enthält Ihre Kerndaten (Profil, gespeicherte Stellen, Bewerbungen, Kampagnen, KI-Gespräche, Scans, Nutzungs- und Aktivitätsdaten sowie eine Inventarliste Ihrer Dateien). Es sind keine Zugangsdaten oder private Datei-Inhalte enthalten.",
          en: "Before deleting your account, you can download your data as a JSON file (Settings → Data & Privacy). The export contains your core data (profile, saved jobs, applications, campaigns, AI conversations, scans, usage and activity data, plus an inventory list of your files). It does not include credentials or private file contents.",
          fr: "Avant de supprimer votre compte, vous pouvez télécharger vos données au format JSON (Réglages → Données et confidentialité). L'export contient vos données de base (profil, offres enregistrées, candidatures, campagnes, conversations IA, scans, données d'utilisation et d'activité, plus une liste inventaire de vos fichiers). Il ne contient ni identifiants ni contenus de fichiers privés.",
          ar: "قبل حذف حسابك، يمكنك تنزيل بياناتك كملف JSON (الإعدادات ← البيانات والخصوصية). ويحتوي التصدير على بياناتك الأساسية (الملف، الوظائف المحفوظة، الطلبات، الحملات، محادثات الذكاء الاصطناعي، المسحات، بيانات الاستخدام والنشاط، بالإضافة إلى قائمة جرد ملفاتك). ولا يتضمن بيانات دخول أو محتوى ملفات خاصة.",
        },
      ],
    },
    {
      id: "questions",
      title: {
        de: "Fragen",
        en: "Questions",
        fr: "Questions",
        ar: "الأسئلة",
      },
      p: [
        {
          de: "Bei Fragen zur Löschung oder zu Ihren Daten wenden Sie sich über die Kontaktseite an uns.",
          en: "For questions about deletion or your data, contact us via the Contact page.",
          fr: "Pour toute question sur la suppression ou vos données, contactez-nous via la page Contact.",
          ar: "لأي أسئلة حول الحذف أو بياناتك، راسلنا عبر صفحة الاتصال.",
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
