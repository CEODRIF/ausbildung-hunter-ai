import type { LegalDoc } from "./types";
import { PLACEHOLDERS } from "./types";

/**
 * Privacy Policy content — grounded in verified platform behavior:
 * data categories mirror the server-side export (account-data.ts),
 * AI processing mirrors ai-service/bewerbung-scanner/web-search,
 * third parties are only services the code actually uses.
 */
export const privacyDoc: LegalDoc = {
  slug: "privacy",
  title: {
    de: "Datenschutzerklärung",
    en: "Privacy Policy",
    fr: "Politique de confidentialité",
    ar: "سياسة الخصوصية",
  },
  intro: {
    de: "Diese Datenschutzerklärung erklärt, welche Informationen Ausbildung Hunter AI erhebt, warum und wie sie verwendet werden, wie sie gespeichert und geschützt sind, welche Dienste Dritter eingebunden sind und welche Rechte Ihnen zustehen. Jede Aussage beschreibt das tatsächliche Verhalten der Plattform.",
    en: "This Privacy Policy explains what information Ausbildung Hunter AI collects, why and how it is used, how it is stored and protected, which third-party services are involved, and what rights you have. Every statement describes the platform's actual behavior.",
    fr: "La présente politique de confidentialité explique quelles informations Ausbildung Hunter AI collecte, pourquoi et comment elles sont utilisées, comment elles sont stockées et protégées, quels services tiers sont impliqués et quels droits vous sont reconnus. Chaque affirmation décrit le comportement réel de la plateforme.",
    ar: "تشرح سياسة الخصوصية هذه المعلومات التي تجمعها منصّة Ausbildung Hunter AI، ولماذا وكيف تُستخدم، وكيف تُخزَّن وتُحمى، وأي خدمات خارجية مستخدمة، وما الحقوق المتاحة لك. كل عبارة تصف السلوك الفعلي للمنصّة.",
  },
  sections: [
    {
      id: "responsible",
      title: {
        de: "Verantwortliche Stelle",
        en: "Responsible Party",
        fr: "Responsable du traitement",
        ar: "الجهة المسؤولة",
      },
      p: [
        {
          de: "Verantwortlich für die Verarbeitung Ihrer Daten auf dieser Plattform ist " + PLACEHOLDERS.LEGAL_ENTITY + " (Anschrift: " + PLACEHOLDERS.BUSINESS_ADDRESS + "). Für Fragen zur Datenverarbeitung erreichen Sie uns über die Kontaktseite mit der dort angegebenen E-Mail-Adresse.",
          en: "The party responsible for the processing of your data on this platform is " + PLACEHOLDERS.LEGAL_ENTITY + " (address: " + PLACEHOLDERS.BUSINESS_ADDRESS + "). For questions about data processing, reach us via the Contact page using the email address listed there.",
          fr: "Le responsable du traitement de vos données sur cette plateforme est " + PLACEHOLDERS.LEGAL_ENTITY + " (adresse : " + PLACEHOLDERS.BUSINESS_ADDRESS + "). Pour toute question sur le traitement des données, contactez-nous via la page Contact à l'adresse e-mail indiquée.",
          ar: "الجهة المسؤولة عن معالجة بياناتك على هذه المنصّة هي " + PLACEHOLDERS.LEGAL_ENTITY + " (العنوان: " + PLACEHOLDERS.LEGAL_ENTITY + "). للاستفسار عن معالجة البيانات، راسلنا عبر صفحة الاتصال باستخدام البريد المذكور هناك.",
        },
      ],
    },
    {
      id: "collect",
      title: {
        de: "Welche Informationen wir erheben",
        en: "What Information We Collect",
        fr: "Quelles informations nous collectons",
        ar: "المعلومات التي نجمعها",
      },
      p: [
        {
          de: "Wir erheben nur Informationen, die für den Betrieb Ihres Kontos und die von Ihnen genutzten Funktionen erforderlich sind. Das umfasst folgende Kategorien:",
          en: "We only collect information that is needed to operate your account and the features you use. This includes the following categories:",
          fr: "Nous ne collectons que les informations nécessaires au fonctionnement de votre compte et aux fonctionnalités que vous utilisez. Cela comprend les catégories suivantes :",
          ar: "نجمع فقط المعلومات اللازمة لتشغيل حسابك والميزات التي تستخدمها. وتشمل الفئات التالية:",
        },
      ],
      li: [
        {
          de: "Kontodaten: Ihr Name, Ihre E-Mail-Adresse, eine interne Benutzer-ID, der Kontostatus und Ihr gewähltes Ziel (Ausbildung oder Arbeit).",
          en: "Account data: your name, your email address, an internal user ID, the account status and your chosen goal (apprenticeship or job).",
          fr: "Données de compte : votre nom, votre adresse e-mail, un identifiant utilisateur interne, le statut du compte et l'objectif choisi (alternance ou emploi).",
          ar: "بيانات الحساب: اسمك، عنوان بريدك الإلكتروني، معرّف مستخدم داخلي، حالة الحساب، والهدف الذي اخترته (التدريب المهني أو العمل).",
        },
        {
          de: "Authentifizierungs- und Sitzungsdaten: Ihre Anmeldung wird über Supabase Auth verwaltet; die Sitzung wird über sichere Sitzungs-Cookies aufrechterhalten.",
          en: "Authentication and session data: your sign-in is managed by Supabase Auth; the session is maintained via secure session cookies.",
          fr: "Données d'authentification et de session : votre connexion est gérée par Supabase Auth ; la session est maintenue par des cookies de session sécurisés.",
          ar: "بيانات المصادقة والجلسة: تُدار دخولك عبر Supabase Auth، وتُحافظ على الجلسة عبر كوكيز جلسة آمنة.",
        },
        {
          de: "Hochgeladene Dateien: Lebenslauf (CV), Bewerbungen, Anschreiben, Zertifikate und Bilder, die Sie in den Tools (Bewerbungsscan, KI-Assistent, CV-Builder, Anschreiben-Builder) hochladen.",
          en: "Uploaded files: your CV, applications, cover letters, certificates and images that you upload in the tools (Application Scanner, AI Assistant, CV Builder, Cover Letter Builder).",
          fr: "Fichiers téléversés : votre CV, vos candidatures, vos lettres de motivation, vos certifications et vos images téléversées dans les outils (Scan de candidature, Assistant IA, éditeur de CV, éditeur de lettre).",
          ar: "الملفات المرفوعة: سيرتك الذاتية، طلباتك، خطابات التقديم، الشهادات والصور التي ترفعها في الأدوات (ماسح الطلبات، المساعد الذكي، منشئ السيرة، منشئ خطاب التقديم).",
        },
        {
          de: "KI-Daten: Ihre Gespräche und Nachrichten im KI-Assistenten sowie die aus Ihren Dokumenten erkannten Profilangaben (Bewerbungsscan).",
          en: "AI data: your conversations and messages in the AI Assistant, plus the profile details recognized from your documents (Application Scanner).",
          fr: "Données IA : vos conversations et messages dans l'Assistant IA, ainsi que les informations de profil reconnues depuis vos documents (Scan de candidature).",
          ar: "بيانات الذكاء الاصطناعي: محادثاتك ورسائلك في المساعد الذكي، بالإضافة إلى بيانات الملف الشخصي المستخرجة من مستنداتك (ماسح الطلبات).",
        },
        {
          de: "Bewerbungs- und E-Mail-Daten: Entwürfe, Kampagnen, Empfänger, Betreff, Text, Anhänge und Versandstatus Ihrer Bewerbungen und E-Mails.",
          en: "Application and email data: drafts, campaigns, recipients, subject, body, attachments and delivery status of your applications and emails.",
          fr: "Données de candidature et d'e-mail : brouillons, campagnes, destinataires, objet, corps, pièces jointes et statut d'envoi de vos candidatures et e-mails.",
          ar: "بيانات الطلبات والبريد: المسودات، الحملات، المستلمون، الموضوع، النص، المرفقات، وحالة إرسال طلباتك ورسائلك.",
        },
        {
          de: "Gespeicherte Stellenangebote (Saved Opportunities) aus der Suche.",
          en: "Saved Opportunities from your searches.",
          fr: "Offres enregistrées (Saved Opportunities) issues de vos recherches.",
          ar: "الوظائف المحفوظة من عمليات البحث.",
        },
        {
          de: "Daten des E-Mail-Tools: Ihr verknüpftes E-Mail-Konto (OAuth-Zugriff für den Versand) sowie Kampagnen- und Nachrichtenprotokolle.",
          en: "Email tool data: your connected email account (OAuth access for sending) plus campaign and message logs.",
          fr: "Données de l'outil e-mail : votre compte e-mail connecté (accès OAuth pour l'envoi) ainsi que les journaux de campagnes et de messages.",
          ar: "بيانات أداة البريد: حساب بريدك المربوط (وصول OAuth للإرسال) بالإضافة إلى سجلات الحملات والرسائل.",
        },
        {
          de: "Benachrichtigungen: Ihr Lesezustand der Plattform-Benachrichtigungen.",
          en: "Notifications: the read status of your platform notifications.",
          fr: "Notifications : votre statut de lecture des notifications de la plateforme.",
          ar: "الإشعارات: حالة قراءة إشعارات المنصّة لديك.",
        },
        {
          de: "Nutzungsdaten: tägliche Zähler für gesendete E-Mails und KI-Anfragen sowie ein Aktivitätsprotokoll Ihrer Aktionen.",
          en: "Usage data: daily counters for sent emails and AI requests, plus an activity log of your actions.",
          fr: "Données d'utilisation : compteurs quotidiens d'e-mails envoyés et de requêtes IA, ainsi qu'un journal d'activité de vos actions.",
          ar: "بيانات الاستخدام: عدادات يومية للرسائل المرسلة وطلبات الذكاء الاصطناعي، بالإضافة إلى سجل نشاطاتك.",
        },
        {
          de: "Einstellungen: Sprache und Erscheinungsbild – lokal in Ihrem Browser gespeichert, dazu die Sprachauswahl im Cookie aha_lang.",
          en: "Preferences: language and appearance – stored locally in your browser, plus the language choice in the aha_lang cookie.",
          fr: "Préférences : langue et apparence – stockées localement dans votre navigateur, plus le choix de langue dans le cookie aha_lang.",
          ar: "التفضيلات: اللغة والمظهر — تُخزَّن محليًا في متصفحك، بالإضافة إلى اختيار اللغة في كوكي aha_lang.",
        },
      ],
    },
    {
      id: "use",
      title: {
        de: "Wofür wir Informationen verwenden",
        en: "How We Use Information",
        fr: "Comment nous utilisons les informations",
        ar: "كيف نستخدم المعلومات",
      },
      p: [
        {
          de: "Jede Datenkategorie wird ausschließlich für den jeweiligen Funktionszweck verwendet:",
          en: "Each data category is used exclusively for its respective functional purpose:",
          fr: "Chaque catégorie de données est utilisée exclusivement pour sa fonction respective :",
          ar: "تُستخدم كل فئة من البيانات لغرضها الوظيفي فقط:",
        },
      ],
      li: [
        {
          de: "Kontodaten: Anmelden, Identifizierung, Personalisierung (Ziel Ausbildung oder Arbeit) und Verwaltung Ihres Kontos.",
          en: "Account data: sign-in, identification, personalization (apprenticeship or job goal) and account management.",
          fr: "Données de compte : connexion, identification, personnalisation (objectif alternance ou emploi) et gestion de votre compte.",
          ar: "بيانات الحساب: تسجيل الدخول، التعرّف على هويتك، التخصيص (هدف التدريب أو العمل)، وإدارة حسابك.",
        },
        {
          de: "Authentifizierungs- und Sitzungsdaten: Aufrechterhaltung Ihrer angemeldeten Sitzung und Schutz Ihrer Kontoaktionen.",
          en: "Authentication and session data: keeping your signed-in session alive and protecting your account actions.",
          fr: "Données d'authentification et de session : maintenir votre session connectée et protéger vos actions sur le compte.",
          ar: "بيانات المصادقة والجلسة: الحفاظ على جلستك المسجّلة الدخول وحماية إجراءات حسابك.",
        },
        {
          de: "Hochgeladene Dateien: Auswertung durch die Tools (Scan, KI-Assistent), Anzeige in der Vorschau und Wiederherstellung in Ihrem Konto.",
          en: "Uploaded files: processing by the tools (Scanner, AI Assistant), display in previews and restoration in your account.",
          fr: "Fichiers téléversés : traitement par les outils (Scan, Assistant IA), affichage en aperçu et restauration dans votre compte.",
          ar: "الملفات المرفوعة: المعالجة عبر الأدوات (الماسح، المساعد الذكي)، العرض في المعاينة، والاستعادة في حسابك.",
        },
        {
          de: "KI-Daten: Beantwortung Ihrer Fragen, Auswertung Ihrer Dokumente und Vervollständigung der Bereiche beim CV-Import.",
          en: "AI data: answering your questions, analyzing your documents and pre-filling sections on CV import.",
          fr: "Données IA : répondre à vos questions, analyser vos documents et préremplir les sections lors de l'import du CV.",
          ar: "بيانات الذكاء الاصطناعي: الإجابة عن أسئلتك، تحليل مستنداتك، وملء الأقسام تلقائيًا عند استيراد السيرة الذاتية.",
        },
        {
          de: "Bewerbungs- und E-Mail-Daten: Vorbereitung, Versand und Protokollierung Ihrer Bewerbungen über Ihr verknüpftes E-Mail-Konto.",
          en: "Application and email data: preparing, sending and logging your applications through your connected email account.",
          fr: "Données de candidature et d'e-mail : préparation, envoi et suivi de vos candidatures via votre compte e-mail connecté.",
          ar: "بيانات الطلبات والبريد: تجهيز طلباتك وإرسالها وتسجيلها عبر حساب بريدك المربوط.",
        },
        {
          de: "Gespeicherte Stellen: Bereitstellung Ihrer Merkliste und Vorbereitung von Bewerbungen aus einer Stelle heraus.",
          en: "Saved jobs: providing your bookmark list and preparing applications from a listing.",
          fr: "Offres enregistrées : mettre à disposition votre liste de signets et préparer une candidature depuis une offre.",
          ar: "الوظائف المحفوظة: عرض قائمتك المحفوظة وتجهيز طلب من إعلان وظيفة.",
        },
        {
          de: "Benachrichtigungen: Anzeige von Plattform-Mitteilungen und Nachweis Ihres Lesezustands.",
          en: "Notifications: displaying platform messages and tracking their read state.",
          fr: "Notifications : afficher les messages de la plateforme et suivre leur statut de lecture.",
          ar: "الإشعارات: عرض رسائل المنصّة وتتبّع حالتها كمقروءة.",
        },
        {
          de: "Nutzungsdaten: Anwendung der täglichen Limits für E-Mails und KI-Anfragen sowie die transparente Anzeige unter Verbrauch.",
          en: "Usage data: enforcing the daily limits for emails and AI requests, and the transparent display under Usage.",
          fr: "Données d'utilisation : application des limites quotidiennes pour les e-mails et les requêtes IA, et l'affichage transparent sous Utilisation.",
          ar: "بيانات الاستخدام: تطبيق الحدود اليومية للبريد وطلبات الذكاء الاصطناعي، وعرضها بشفافية في صفحة الاستخدام.",
        },
        {
          de: "Einstellungen: Anzeige der Plattform in Ihrer bevorzugten Sprache und Ihrem bevorzugten Erscheinungsbild.",
          en: "Preferences: showing the platform in your preferred language and appearance.",
          fr: "Préférences : afficher la plateforme dans votre langue et votre apparence préférées.",
          ar: "التفضيلات: عرض المنصّة بلغتك ومظهرك المفضلين.",
        },
      ],
    },
    {
      id: "ai",
      title: {
        de: "Verarbeitung durch KI",
        en: "AI Processing",
        fr: "Traitement par IA",
        ar: "المعالجة بالذكاء الاصطناعي",
      },
      p: [
        {
          de: "Bestimmte Funktionen verarbeiten Ihre Daten mit KI-Diensten. Die Verarbeitung erfolgt ausschließlich so, wie die jeweilige Funktion technisch arbeitet:",
          en: "Some features process your data with AI services. Processing happens exactly as each feature technically works:",
          fr: "Certaines fonctionnalités traitent vos données avec des services IA. Le traitement se fait exactement comme chaque fonctionnalité fonctionne techniquement :",
          ar: "بعض الميزات تعالج بياناتك عبر خدمات الذكاء الاصطناعي. وتتم المعالجة بالطريقة التي تعمل بها كل ميزة تقنيًا:",
        },
      ],
      li: [
        {
          de: "KI-Assistent: Ihre Nachrichten und die Inhalte hochgeladener Dateien (bis zu fünf Dateien pro Anfrage) werden an den konfigurierten KI-Dienst übermittelt, um eine Antwort zu erzeugen.",
          en: "AI Assistant: your messages and the contents of uploaded files (up to five files per request) are sent to the configured AI service to generate an answer.",
          fr: "Assistant IA : vos messages et le contenu des fichiers téléversés (jusqu'à cinq fichiers par requête) sont transmis au service IA configuré pour générer une réponse.",
          ar: "المساعد الذكي: تُرسَل رسائلك ومحتوى الملفات المرفوعة (حتى خمسة ملفات في كل طلب) إلى خدمة الذكاء الاصطناعي المهيأة لتوليد إجابة.",
        },
        {
          de: "Bewerbungsscan: Der Text Ihrer hochgeladenen Dokumente wird an den KI-Dienst übermittelt, um strukturierte Angaben (Ausbildung, Erfahrung, Kenntnisse, Sprachen, Kontaktdaten) zu extrahieren.",
          en: "Application Scanner: the text of your uploaded documents is sent to the AI service to extract structured details (education, experience, skills, languages, contact info).",
          fr: "Scan de candidature : le texte de vos documents téléversés est transmis au service IA pour extraire des informations structurées (formation, expérience, compétences, langues, coordonnées).",
          ar: "ماسح الطلبات: يُرسَل نص مستنداتك المرفوعة إلى خدمة الذكاء الاصطناعي لاستخراج بيانات منظمة (التعليم، الخبرة، المهارات، اللغات، بيانات التواصل).",
        },
        {
          de: "CV-Analyse / Import: Der CV-Builder übernimmt die aus dem Bewerbungsscan erkannten Profilangaben; es findet dabei keine zusätzliche KI-Analyse statt.",
          en: "CV analysis / import: the CV Builder takes over the profile details recognized by the Application Scanner; no additional AI analysis takes place.",
          fr: "Analyse / import du CV : l'éditeur de CV reprend les informations de profil reconnues par le Scan de candidature ; aucune analyse IA supplémentaire n'a lieu.",
          ar: "تحليل السيرة الذاتية/الاستيراد: يستلم منشئ السيرة الذاتية البيانات المعترف بها من ماسح الطلبات، ولا يتم أي تحليل إضافي بالذكاء الاصطناعي.",
        },
        {
          de: "Dokumentenanalyse: Anhänge im KI-Assistenten (PDF, DOC, DOCX, TXT, Bilder) werden gelesen und in die Antwort einbezogen.",
          en: "Document analysis: attachments in the AI Assistant (PDF, DOC, DOCX, TXT, images) are read and incorporated into the answer.",
          fr: "Analyse de documents : les pièces jointes dans l'Assistant IA (PDF, DOC, DOCX, TXT, images) sont lues et intégrées à la réponse.",
          ar: "تحليل المستندات: تُقرأ المرفقات في المساعد الذكي (PDF، DOC، DOCX، TXT، صور) وتُدمج في الإجابة.",
        },
        {
          de: "KI-generierte Inhalte: Das Anschreiben kann per KI erstellt werden. Die KI stützt sich dabei auf Ihre tatsächlichen Angaben aus Profil, Lebenslauf und Eingaben und erfindet keine Inhalte.",
          en: "AI-generated content: the cover letter can be created with AI. It relies on your real details from your profile, CV and inputs, and invents no content.",
          fr: "Contenus générés par IA : la lettre de motivation peut être créée par IA. Elle s'appuie sur vos informations réelles de profil, de CV et de saisies, et n'invente aucun contenu.",
          ar: "المحتوى المولّد بالذكاء الاصطناعي: يمكن إنشاء خطاب التقديم بالذكاء الاصطناعي، ويعتمد على بياناتك الحقيقية من ملفك وسيرتك ومدخلاتك، ولا يخترع أي محتوى.",
        },
        {
          de: "KI-Suche: Eine KI plant Ihre Suchanfrage und strukturiert die Ergebnisse. Die Web-Erkundung nutzt zusätzlich Google Gemini als Grounding-Dienst.",
          en: "AI Search: an AI plans your search query and structures the results. The web exploration additionally uses Google Gemini as a grounding service.",
          fr: "Recherche IA : une IA planifie votre requête et structure les résultats. L'exploration web utilise en plus Google Gemini comme service de grounding.",
          ar: "البحث بالذكاء الاصطناعي: يخطّط الذكاء الاصطناعي لطلبك البحثي وينظّم النتائج. ويستخدم الاستكشاف في الويب Google Gemini كخدمة تثبيت للمصادر.",
        },
      ],
      pAfter: [
        {
          de: "Die KI erfindet keine Fakten: E-Mail-Adressen, Firmen und Links werden weder berechnet noch geraten – es werden nur Angaben aus den durchsuchten Quellen bzw. aus Ihren eigenen Dokumenten übernommen. Ausführliche Informationen finden Sie auf der Seite KI-Nutzung.",
          en: "The AI invents no facts: email addresses, companies and links are neither computed nor guessed – only details from the searched sources or from your own documents are taken over. For full details, see the AI Usage page.",
          fr: "L'IA n'invente aucun fait : les adresses e-mail, les entreprises et les liens ne sont ni calculés ni devinés – seules les informations issues des sources consultées ou de vos propres documents sont reprises. Pour les détails complets, voir la page Utilisation de l'IA.",
          ar: "لا يخترع الذكاء الاصطناعي الوقائع: لا تُحسب عناوين البريد ولا الشركات ولا الروابط ولا تُتخمَّن — بل تُعتمد فقط المعلومات من المصادر المستفتاة أو من مستنداتك الخاصة. والتفاصيل الكاملة في صفحة استخدام الذكاء الاصطناعي.",
        },
      ],
      to: "/ai-usage",
      toLabel: {
        de: "Mehr zur KI-Nutzung",
        en: "More about AI Usage",
        fr: "En savoir plus sur l'Utilisation de l'IA",
        ar: "المزيد عن استخدام الذكاء الاصطناعي",
      },
    },
    {
      id: "files",
      title: {
        de: "Hochgeladene Dateien",
        en: "Uploaded Files",
        fr: "Fichiers téléversés",
        ar: "الملفات المرفوعة",
      },
      p: [
        {
          de: "Sie können Dateien hochladen (PDF, DOC, DOCX, TXT sowie Bilder wie PNG, JPG, JPEG, WEBP). Die Größenbegrenzung beträgt 10 MB pro Datei; das Foto im CV-Builder ist auf 1 MB begrenzt.",
          en: "You can upload files (PDF, DOC, DOCX, TXT and images such as PNG, JPG, JPEG, WEBP). The size limit is 10 MB per file; the CV Builder photo is limited to 1 MB.",
          fr: "Vous pouvez téléverser des fichiers (PDF, DOC, DOCX, TXT et des images comme PNG, JPG, JPEG, WEBP). La limite de taille est de 10 Mo par fichier ; la photo de l'éditeur de CV est limitée à 1 Mo.",
          ar: "يمكنك رفع ملفات (PDF، DOC، DOCX، TXT وصور مثل PNG، JPG، JPEG، WEBP). الحد الأقصى 10 ميغابايت لكل ملف؛ وصورة السيرة الذاتية محدودة بـ 1 ميغابايت.",
        },
      ],
      li: [
        {
          de: "Dateien werden in privaten Supabase-Storage-Buckets unter einem Pfad Ihrer Benutzer-ID gespeichert und sind nur für Ihr Konto zugänglich.",
          en: "Files are stored in private Supabase Storage buckets under your user ID path and are accessible only to your account.",
          fr: "Les fichiers sont stockés dans des buckets privés Supabase Storage sous un chemin de votre identifiant utilisateur et ne sont accessibles que par votre compte.",
          ar: "تُخزَّن الملفات في مستودعات Supabase الخاصة تحت مسار معرّف مستخدمك، ولا يمكن الوصول إليها إلا من حسابك.",
        },
        {
          de: "Ihre Inhalte werden von den jeweiligen Tools ausgewertet (Bewerbungsscan, KI-Assistent) und als strukturierte Daten in Ihrem Konto gespeichert.",
          en: "Their contents are processed by the respective tools (Application Scanner, AI Assistant) and stored in your account as structured data.",
          fr: "Leur contenu est traité par les outils respectifs (Scan de candidature, Assistant IA) et stocké dans votre compte sous forme de données structurées.",
          ar: "يُعالَج محتوى هذه الملفات بالأدوات المعنية (ماسح الطلبات، المساعد الذكي) ويُحفظ في حسابك كبيانات منظمة.",
        },
        {
          de: "Es gilt keine fest definierte Aufbewahrungsfrist: Dateien bleiben so lange, wie Ihr Konto existiert, und werden bei der Kontolöschung zusammen mit allen anderen Daten gelöscht.",
          en: "There is no fixed retention period: files remain for as long as your account exists and are deleted together with all other data on account deletion.",
          fr: "Aucune durée de conservation fixe n'est définie : les fichiers restent aussi longtemps que votre compte existe et sont supprimés avec toutes les autres données lors de la suppression du compte.",
          ar: "لا توجد مدة احتفاظ محددة سلفًا: تبقى الملفات ما دام حسابك قائمًا، وتُحذف مع جميع البيانات الأخرى عند حذف الحساب.",
        },
        {
          de: "Privatdateien werden nie öffentlich verlinkt. Sie werden nur an die KI-Dienste übermittelt, wenn eine Funktion sie zur Verarbeitung benötigt (siehe Abschnitt KI-Verarbeitung).",
          en: "Private files are never publicly linked. They are only transmitted to the AI services when a feature needs them for processing (see the AI Processing section).",
          fr: "Les fichiers privés ne sont jamais liés publiquement. Ils ne sont transmis aux services IA que lorsqu'une fonctionnalité en a besoin pour le traitement (voir la section Traitement par IA).",
          ar: "لا تُربط الملفات الخاصة بربط عام أبدًا. ولا تُرسل إلى خدمات الذكاء الاصطناعي إلا عند الحاجة إليها للمعالجة (انظر قسم المعالجة بالذكاء الاصطناعي).",
        },
      ],
    },
    {
      id: "search",
      title: {
        de: "Ausbildungs- und Jobsuche",
        en: "Apprenticeship & Job Search",
        fr: "Recherche d'alternance et d'emploi",
        ar: "البحث عن التدريب والوظائف",
      },
      p: [
        {
          de: "Während der Suche verarbeiten wir Ihre Suchbegriffe, Ihre Filter (z. B. Ort, Radius, Aktualität), Ihr gewähltes Ziel und die daraus abgeleiteten Suchanfragen.",
          en: "While searching, we process your search terms, your filters (e.g. location, radius, freshness), your chosen goal and the derived search requests.",
          fr: "Pendant la recherche, nous traitons vos termes de recherche, vos filtres (p. ex. lieu, rayon, fraîcheur), votre objectif choisi et les requêtes dérivées.",
          ar: "أثناء البحث، نعالج كلمات بحثك وعوامل التصفية (مثل الموقع والنطاق والأصالة) والهدف الذي اخترته والاستعلامات المشتقة منها.",
        },
      ],
      li: [
        {
          de: "Die klassische Suche nutzt als externe Quelle die Jobbörse der Bundesagentur für Arbeit.",
          en: "The classic search uses the Federal Employment Agency's Jobbörse as its external source.",
          fr: "La recherche classique utilise la Jobbörse de l'Agence fédérale pour l'emploi comme source externe.",
          ar: "يعتمد البحث العادي على لوحة وظائف وكالة العمل الاتحادية كمصدر خارجي.",
        },
        {
          de: "Die KI-Suche befragt zusätzlich öffentliche Webquellen (Jobportale, offizielle Websites). Dafür werden Ihre Suchbegriffe an die KI- und Webdienste übermittelt.",
          en: "The AI Search additionally queries public web sources (job portals, official websites). For this, your search terms are transmitted to the AI and web services.",
          fr: "La Recherche IA interroge en plus des sources web publiques (portails d'emploi, sites officiels). À cet effet, vos termes de recherche sont transmis aux services IA et web.",
          ar: "ويستفتي البحث بالذكاء الاصطناعي أيضًا مصادر ويب عامة (بوابات التوظيف، المواقع الرسمية). لذلك تُرسَل كلمات بحثك إلى خدمات الذكاء الاصطناعي والويب.",
        },
        {
          de: "E-Mail-Adressen werden ausschließlich aus dem Text der Originalangebote entnommen und formal geprüft – sie werden niemals berechnet, geraten oder erfunden.",
          en: "Email addresses are extracted exclusively from the original listing text and formally validated – they are never computed, guessed or invented.",
          fr: "Les adresses e-mail sont extraites exclusivement du texte de l'offre originale et validées formellement – elles ne sont jamais calculées, devinées ou inventées.",
          ar: "تُستخلص عناوين البريد حصريًا من نص الإعلان الأصلي وتُفحص صيغتها — ولا تُحسب أو تتخمن أو تخترع أبدًا.",
        },
        {
          de: "Gespeicherte Stellen werden in Ihrer Merkliste in Ihrem Konto abgelegt; Suchanfragen werden nicht getrennt davon dauerhaft gespeichert.",
          en: "Saved jobs are stored in your bookmark list in your account; search requests are not persistently stored separately from it.",
          fr: "Les offres enregistrées sont stockées dans votre liste de signets dans votre compte ; les requêtes de recherche ne sont pas stockées durablement de manière séparée.",
          ar: "تُحفظ الوظائف في قائمتك المحفوظة داخل حسابك، ولا تُخزَّن استعلامات البحث بشكل دائم ومستقل عنها.",
        },
      ],
    },
    {
      id: "email",
      title: {
        de: "E-Mail-Funktionen",
        en: "Email Features",
        fr: "Fonctions e-mail",
        ar: "ميزات البريد الإلكتروني",
      },
      p: [
        {
          de: "Die E-Mail-Funktionen verarbeiten folgende Daten:",
          en: "The email features process the following data:",
          fr: "Les fonctions e-mail traitent les données suivantes :",
          ar: "تعالج ميزات البريد الإلكتروني البيانات التالية:",
        },
      ],
      li: [
        {
          de: "E-Mail-Sammlung (Email Collector): Es werden nur E-Mail-Adressen erfasst, die im Text von Stellenangeboten vorkommen und formal gültig sind. Duplikate werden entfernt; ungültige Adressen werden gekennzeichnet und nicht übernommen.",
          en: "Email Collector: only email addresses that appear in job listing text and are formally valid are captured. Duplicates are removed; invalid addresses are flagged and not taken over.",
          fr: "Collecteur d'e-mails : seules les adresses présentes dans le texte des offres et formellement valides sont capturées. Les doublons sont retirés ; les adresses invalides sont signalées et non reprises.",
          ar: "جهاز جمع البريد: يُلتقط فقط العناوين الموجودة في نص إعلانات الوظائف وصحيحة الصيغة. وتُحذف المكررات، وتُعلَّم العناوين غير الصالحة ولا تُعتمد.",
        },
        {
          de: "E-Mail-Versand und Bewerbungen: Sie geben Empfänger, Betreff, Text und Anhänge an. Der Versand erfolgt sequenziell über Ihr verknüpftes Gmail- oder Outlook-Konto (OAuth 2.0).",
          en: "Email sending and applications: you provide recipients, subject, body and attachments. Sending happens sequentially through your connected Gmail or Outlook account (OAuth 2.0).",
          fr: "Envoi d'e-mails et candidatures : vous fournissez destinataires, objet, corps et pièces jointes. L'envoi s'effectue séquentiellement via votre compte Gmail ou Outlook connecté (OAuth 2.0).",
          ar: "إرسال البريد وطلبات التقديم: أنت من يحدد المستلمين والموضوع والنص والمرفقات. ويتم الإرسال بالتسلسل عبر حساب Gmail أو Outlook المربوط (OAuth 2.0).",
        },
        {
          de: "Ihr E-Mail-Zugang: Wir speichern keine Zugangsdaten (kein Passwort, keine SMTP-Daten). Der OAuth-Zugriff wird verschlüsselt in Ihrem Konto aufbewahrt und dient ausschließlich dem Versand über Ihr eigenes Konto.",
          en: "Your email access: we do not store any credentials (no password, no SMTP data). The OAuth access is stored encrypted in your account and is used exclusively for sending through your own account.",
          fr: "Votre accès e-mail : nous ne stockons aucune identifiante (ni mot de passe, ni données SMTP). L'accès OAuth est stocké chiffré dans votre compte et sert exclusivement à l'envoi via votre propre compte.",
          ar: "وصولك إلى البريد: لا نخزّن أي بيانات دخول (لا كلمة مرور ولا بيانات SMTP). ويُحفظ وصول OAuth مشفرًا في حسابك ويُستخدم حصريًا للإرسال عبر حسابك الخاص.",
        },
        {
          de: "Kampagnen- und Nachrichtenprotokolle: Status, Zeitpunkte und eventuelle Fehler pro Empfänger werden in Ihrem Konto protokolliert und können in der Kampagne-Übersicht eingesehen werden.",
          en: "Campaign and message logs: status, timestamps and any errors per recipient are logged in your account and can be reviewed in the campaign overview.",
          fr: "Journaux de campagnes et de messages : statut, horodatage et éventuelles erreurs par destinataire sont journalisés dans votre compte et consultables dans la vue de campagne.",
          ar: "سجلات الحملات والرسائل: تُسجَّل الحالة والأوقات وأي أخطاء لكل مستلم في حسابك ويمكن مراجعتها في صفحة الحملة.",
        },
      ],
    },
    {
      id: "third-party",
      title: {
        de: "Dienste Dritter",
        en: "Third-Party Services",
        fr: "Services tiers",
        ar: "خدمات الطرف الثالث",
      },
      p: [
        {
          de: "Die Plattform verwendet ausschließlich die folgenden Dienste, die nachweislich im Code eingebunden sind:",
          en: "The platform uses only the following services, which are demonstrably integrated in the code:",
          fr: "La plateforme n'utilise que les services suivants, dont l'intégration dans le code est démontrable :",
          ar: "تستخدم المنصّة فقط الخدمات التالية، والمثبت اندماجها في الكود:",
        },
      ],
      li: [
        {
          de: "Supabase: Authentifizierung, PostgreSQL-Datenbank und Dateispeicher für Ihre Daten und Dateien.",
          en: "Supabase: authentication, PostgreSQL database and file storage for your data and files.",
          fr: "Supabase : authentification, base de données PostgreSQL et stockage de fichiers pour vos données et fichiers.",
          ar: "Supabase: المصادقة، وقاعدة بيانات PostgreSQL، وتخزين الملفات لبياناتك وملفاتك.",
        },
        {
          de: "KI-Dienst (OpenAI-kompatible API): KI-Assistent, Bewerbungsscan, KI-generierte Inhalte und Auswertungen.",
          en: "AI service (OpenAI-compatible API): AI Assistant, Application Scanner, AI-generated content and evaluations.",
          fr: "Service IA (API compatible OpenAI) : Assistant IA, Scan de candidature, contenus générés par IA et évaluations.",
          ar: "خدمة الذكاء الاصطناعي (API متوافقة مع OpenAI): المساعد الذكي، ماسح الطلبات، المحتوى المولّد بالذكاء الاصطناعي، والتقييمات.",
        },
        {
          de: "Google Gemini API: Web-Grounding für die KI-Suche.",
          en: "Google Gemini API: web grounding for the AI Search.",
          fr: "Google Gemini API : grounding web pour la Recherche IA.",
          ar: "Google Gemini API: تثبيت المصادر في الويب للبحث بالذكاء الاصطناعي.",
        },
        {
          de: "Jobbörse der Bundesagentur für Arbeit: externe Datenquelle der klassischen Suche.",
          en: "Federal Employment Agency Jobbörse: external data source of the classic search.",
          fr: "Jobbörse de l'Agence fédérale pour l'emploi : source de données externe de la recherche classique.",
          ar: "لوحة وظائف وكالة العمل الاتحادية: مصدر بيانات خارجي للبحث العادي.",
        },
        {
          de: "Öffentliche Webquellen: Stellenangebote und Websites, die die KI-Suche abfragt.",
          en: "Public web sources: job listings and websites queried by the AI Search.",
          fr: "Sources web publiques : offres d'emploi et sites web interrogés par la Recherche IA.",
          ar: "مصادر ويب عامة: إعلانات الوظائف والمواقع التي يستفتيها البحث بالذكاء الاصطناعي.",
        },
        {
          de: "Google (Gmail) und Microsoft (Outlook): OAuth-Verbindung für den E-Mail-Versand – ausschließlich, wenn Sie ein Konto verknüpfen.",
          en: "Google (Gmail) and Microsoft (Outlook): OAuth connection for email sending – only when you connect an account.",
          fr: "Google (Gmail) et Microsoft (Outlook) : connexion OAuth pour l'envoi d'e-mails – uniquement si vous connectez un compte.",
          ar: "Google (Gmail) وMicrosoft (Outlook): اتصال OAuth لإرسال البريد — فقط عند ربطك حسابًا.",
        },
      ],
      pAfter: [
        {
          de: "Es werden keine Analytics-, Tracking- oder Werbedienste eingebunden. Die Cookie Policy listet die eingesetzten Technologien im Detail.",
          en: "No analytics, tracking or advertising services are used. The Cookie Policy lists the technologies employed in detail.",
          fr: "Aucun service d'analytics, de suivi ou de publicité n'est utilisé. La politique relative aux cookies détaille les technologies employées.",
          ar: "لا تُستخدم أي خدمات تحليل أو تتبّع أو إعلانات. وتدرج سياسة ملفات الارتباط التقنيات المستخدمة بالتفصيل.",
        },
      ],
      to: "/cookies",
      toLabel: {
        de: "Zur Cookie Policy",
        en: "To the Cookie Policy",
        fr: "Vers la politique relative aux cookies",
        ar: "إلى سياسة ملفات الارتباط",
      },
    },
    {
      id: "storage",
      title: {
        de: "Speicherung und Sicherheit",
        en: "Storage & Security",
        fr: "Stockage et sécurité",
        ar: "التخزين والأمان",
      },
      p: [
        {
          de: "Ihre Daten werden in der PostgreSQL-Datenbank und im Dateispeicher von Supabase gespeichert. Die Plattform wird über HTTPS ausgeliefert, sodass die Übertragung zwischen Ihrem Browser und der Plattform verschlüsselt ist.",
          en: "Your data is stored in Supabase's PostgreSQL database and file storage. The platform is served over HTTPS, so the transfer between your browser and the platform is encrypted.",
          fr: "Vos données sont stockées dans la base PostgreSQL et le stockage de fichiers de Supabase. La plateforme est servie via HTTPS, si bien que le transfert entre votre navigateur et la plateforme est chiffré.",
          ar: "تُخزَّن بياناتك في قاعدة بيانات PostgreSQL ومستودع ملفات Supabase. وتُقدَّم المنصّة عبر HTTPS، لذا يكون النقل بين متصفحك والمنصّة مشفرًا.",
        },
      ],
      li: [
        {
          de: "Alle Daten sind an Ihre Benutzer-ID geknüpft. Der Zugriff auf API-Endpunkte wird serverseitig anhand Ihrer Sitzung geprüft.",
          en: "All data is bound to your user ID. Access to API endpoints is checked server-side based on your session.",
          fr: "Toutes les données sont liées à votre identifiant utilisateur. L'accès aux points d'API est vérifié côté serveur sur la base de votre session.",
          ar: "كل البيانات مرتبطة بمعرّف مستخدمك. ويُفحص الوصول إلى نقاط الـ API على الخادم بناءً على جلستك.",
        },
        {
          de: "Sensible Aktionen (z. B. Kontolöschung) sind zusätzlich geschwindigkeitsbegrenzt und erfordern eine Bestätigung.",
          en: "Sensitive actions (e.g. account deletion) are additionally rate-limited and require a confirmation.",
          fr: "Les actions sensibles (p. ex. suppression du compte) sont en outre limitées en fréquence et exigent une confirmation.",
          ar: "الإجراءات الحساسة (مثل حذف الحساب) تخضع أيضًا لحدود المعدل وتتطلب تأكيدًا.",
        },
        {
          de: "Der OAuth-Zugriff auf Ihr E-Mail-Konto wird mit einem dedizierten Schlüssel verschlüsselt gespeichert.",
          en: "The OAuth access to your email account is stored encrypted with a dedicated key.",
          fr: "L'accès OAuth à votre compte e-mail est stocké chiffré avec une clé dédiée.",
          ar: "يُخزَّن وصول OAuth إلى حساب بريدك مشفرًا بمفتاح مخصص.",
        },
        {
          de: "Hochgeladene Dateien liegen in privaten Buckets und sind nicht öffentlich erreichbar.",
          en: "Uploaded files are in private buckets and are not publicly reachable.",
          fr: "Les fichiers téléversés se trouvent dans des buckets privés et ne sont pas accessibles publiquement.",
          ar: "الملفات المرفوعة محفوظة في مستودعات خاصة ولا يمكن الوصول إليها علنًا.",
        },
        {
          de: "Wir erheben keine pauschalen Sicherheitsbehauptungen: Sicherheitsmaßnahmen reduzieren Risiken, geben aber keine absolute Garantie.",
          en: "We make no blanket security claims: security measures reduce risks but give no absolute guarantee.",
          fr: "Nous n'avancons aucune affirmation de sécurité globale : les mesures de sécurité réduisent les risques mais n'offrent aucune garantie absolue.",
          ar: "لا نقدم ادعاءات أمنية شاملة: تدابير الأمان تقلل المخاطر لكنها لا تمنح ضمانًا مطلقًا.",
        },
      ],
    },
    {
      id: "retention",
      title: {
        de: "Aufbewahrung",
        en: "Data Retention",
        fr: "Conservation des données",
        ar: "الاحتفاظ بالبيانات",
      },
      p: [
        {
          de: "Es ist keine feste Aufbewahrungsfrist für einzelne Datenkategorien definiert. Die Daten werden so lange aufbewahrt, wie Ihr Konto existiert.",
          en: "No fixed retention period is defined for individual data categories. Data is kept for as long as your account exists.",
          fr: "Aucune durée de conservation fixe n'est définie pour les catégories de données individuelles. Les données sont conservées aussi longtemps que votre compte existe.",
          ar: "لا توجد مدة احتفاظ محددة مسبقًا لفئات البيانات المختلفة. وتُحتفظ بالبيانات ما دام حسابك قائمًا.",
        },
      ],
      li: [
        {
          de: "Bei der Kontolöschung werden die mit dem Konto verknüpften Daten und Dateien gelöscht (siehe Datenlöschung).",
          en: "On account deletion, the data and files linked to the account are deleted (see Data Deletion).",
          fr: "Lors de la suppression du compte, les données et fichiers liés au compte sont supprimés (voir Suppression des données).",
          ar: "عند حذف الحساب تُحذف البيانات والملفات المرتبطة به (انظر حذف البيانات).",
        },
        {
          de: "Lokale Entwurfsdaten in Ihrem Browser (CV- und Anschreiben-Entwürfe, Einstellungen) verbleiben auf Ihrem Gerät, bis Sie den Browser-Speicher leeren. Sie werden nicht an uns übertragen.",
          en: "Local draft data in your browser (CV and cover letter drafts, settings) remains on your device until you clear browser storage. It is not transmitted to us.",
          fr: "Les données de brouillon locales dans votre navigateur (brouillons de CV et de lettre, réglages) restent sur votre appareil jusqu'à ce que vous effaciez le stockage du navigateur. Elles ne nous sont pas transmises.",
          ar: "تبقى بيانات المسودات المحلية في متصفحك (مسودات السيرة وخطاب التقديم، الإعدادات) على جهازك حتى تمسح تخزين المتصفح. وهي لا تُرسل إلينا.",
        },
        {
          de: "Sollten sich Aufbewahrungsregeln ändern, wird diese Erklärung entsprechend angepasst.",
          en: "If retention rules change, this policy will be updated accordingly.",
          fr: "Si les règles de conservation changent, la présente politique sera mise à jour en conséquence.",
          ar: "إذا تغيّرت قواعد الاحتفاظ، ستُحدَّث هذه السياسة تبعًا لذلك.",
        },
      ],
    },
    {
      id: "rights",
      title: {
        de: "Ihre Rechte",
        en: "Your Rights",
        fr: "Vos droits",
        ar: "حقوقك",
      },
      p: [
        {
          de: "Sie haben folgende Rechte in Bezug auf Ihre Daten:",
          en: "You have the following rights regarding your data:",
          fr: "Vous disposez des droits suivants concernant vos données :",
          ar: "لديك الحقوق التالية فيما يخص بياناتك:",
        },
      ],
      li: [
        {
          de: "Auskunft und Export: Sie können jederzeit unter Einstellungen → Daten & Privacy alle Ihre Daten als JSON-Datei herunterladen.",
          en: "Access and export: at any time under Settings → Data & Privacy, you can download all your data as a JSON file.",
          fr: "Accès et export : à tout moment dans Réglages → Données et confidentialité, vous pouvez télécharger toutes vos données au format JSON.",
          ar: "الاطلاع والتصدير: في أي وقت من الإعدادات ← البيانات والخصوصية يمكنك تنزيل جميع بياناتك كملف JSON.",
        },
        {
          de: "Löschung: Sie können Ihr Konto und alle verknüpften Daten über denselben Bereich endgültig löschen (siehe Datenlöschung).",
          en: "Erasure: you can permanently delete your account and all linked data through the same area (see Data Deletion).",
          fr: "Suppression : vous pouvez supprimer définitivement votre compte et toutes les données liées via la même section (voir Suppression des données).",
          ar: "الحذف: يمكنك حذف حسابك وجميع البيانات المرتبطة به نهائيًا من نفس القسم (انظر حذف البيانات).",
        },
        {
          de: "Berichtigung: Melden Sie unrichtige Angaben über die Kontaktseite; wir prüfen sie und passen sie an, soweit technisch möglich.",
          en: "Rectification: report incorrect details via the Contact page; we review them and correct them where technically possible.",
          fr: "Rectification : signalez les informations inexactes via la page Contact ; nous les examinons et les corrigeons dans la mesure du possible techniquement.",
          ar: "التصحيح: أبلغ عن أي معلومات غير صحيحة عبر صفحة الاتصال؛ وسنراجعها ونصححها بما هو ممكن تقنيًا.",
        },
        {
          de: "Einschränkung und Widerspruch: Richten Sie entsprechende Anliegen über die Kontaktseite an uns.",
          en: "Restriction and objection: direct such requests to us via the Contact page.",
          fr: "Restriction et opposition : adressez-nous de telles demandes via la page Contact.",
          ar: "القيود والاعتراض: وجّه مثل هذه الطلبات إلينا عبر صفحة الاتصال.",
        },
      ],
      pAfter: [
        {
          de: "Diese Plattform stellt keine Rechtsberatung dar und nimmt in dieser Erklärung keine Aussage zu gesetzlichen Fristen oder Zuständigkeiten vor. Im Zweifel wenden Sie sich an eine dafür geeignete Stelle.",
          en: "This platform does not provide legal advice, and this policy makes no statement about statutory deadlines or jurisdictions. When in doubt, consult a suitable authority.",
          fr: "Cette plateforme ne fournit pas de conseil juridique, et la présente politique ne se prononce sur aucun délai légal ni juridiction. En cas de doute, consultez l'autorité compétente.",
          ar: "لا تقدم هذه المنصّة استشارة قانونية، ولا تتناول هذه السياسة أي مواعيد قانونية أو اختصاصات قضائية. وفي حال الشك، استشر الجهة المختصة.",
        },
      ],
    },
    {
      id: "deletion",
      title: {
        de: "Kontolöschung",
        en: "Account Deletion",
        fr: "Suppression du compte",
        ar: "حذف الحساب",
      },
      p: [
        {
          de: "Sie können Ihr Konto über die Plattform endgültig löschen. Der vollständige Ablauf, welche Daten betroffen sind und welche Alternativen bestehen, erklären wir auf der Seite „Löschung von Daten' – dort finden Sie auch, wie ein Antrag über die Kontaktseite gestellt wird.",
          en: "You can permanently delete your account through the platform. The full process, the data affected and the available alternatives are explained on the 'Data Deletion' page – including how to submit a request via the Contact page.",
          fr: "Vous pouvez supprimer définitivement votre compte via la plateforme. Le processus complet, les données concernées et les alternatives disponibles sont expliqués sur la page « Suppression des données » – y compris la façon de soumettre une demande via la page Contact.",
          ar: "يمكنك حذف حسابك نهائيًا عبر المنصّة. ويُشرح الإجراء الكامل والبيانات المتأثرة والبدائل المتاحة في صفحة «حذف البيانات» — بما في ذلك كيفية تقديم طلب عبر صفحة الاتصال.",
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
      id: "contact",
      title: {
        de: "Kontakt",
        en: "Contact",
        fr: "Contact",
        ar: "الاتصال",
      },
      p: [
        {
          de: "Fragen zur Datenverarbeitung, Anfragen zu Ihren Rechten oder Hinweise zum Datenschutz können Sie über die Kontaktseite stellen. Die zuständige Kontaktadresse ist dort angegeben.",
          en: "Questions about data processing, requests regarding your rights, or privacy-related reports can be submitted via the Contact page. The responsible contact address is listed there.",
          fr: "Les questions sur le traitement des données, les demandes relatives à vos droits ou les signalements liés à la confidentialité peuvent être soumis via la page Contact. L'adresse de contact responsable y est indiquée.",
          ar: "يمكنك تقديم الأسئلة عن معالجة البيانات، أو الطلبات المتعلقة بحقوقك، أو الملاحظات المتعلقة بالخصوصية عبر صفحة الاتصال. والعنوان المسؤول مذكور هناك.",
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
