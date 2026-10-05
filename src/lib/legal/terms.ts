import type { LegalDoc } from "./types";
import { PLACEHOLDERS } from "./types";

/**
 * Terms of Service content.
 * No job/apprenticeship guarantee, no invented legal entity / address /
 * court / applicable law; feature sections describe actual functionality,
 * Deckblatt is explicitly marked as not currently available.
 */
export const termsDoc: LegalDoc = {
  slug: "terms",
  title: {
    de: "Nutzungsbedingungen",
    en: "Terms of Service",
    fr: "Conditions d'utilisation",
    ar: "شروط الخدمة",
  },
  intro: {
    de: "Diese Nutzungsbedingungen regeln die Verwendung der Plattform AusbildungsWeg durch Sie. Durch die Registrierung oder die Nutzung der Plattform erklären Sie sich mit diesen Bedingungen einverstanden.",
    en: "These Terms of Service govern your use of the AusbildungsWeg platform. By registering for or using the platform, you agree to these terms.",
    fr: "Les présentes conditions d'utilisation régissent votre utilisation de la plateforme AusbildungsWeg. En vous inscrivant ou en utilisant la plateforme, vous acceptez ces conditions.",
    ar: "تنظّم شروط الخدمة هذه استخدامك لمنصّة AusbildungsWeg. وبقيامك بالتسجيل أو استخدام المنصّة، فإنك توافق على هذه الشروط.",
  },
  sections: [
    {
      id: "acceptance",
      title: {
        de: "Annahme der Bedingungen",
        en: "Acceptance of Terms",
        fr: "Acceptation des conditions",
        ar: "القبول بالشروط",
      },
      p: [
        {
          de: "Sie müssen die Nutzungsbedingungen akzeptieren, um ein Konto zu erstellen und die Plattform zu nutzen. Anbieter dieser Bedingungen ist " + PLACEHOLDERS.LEGAL_ENTITY + " (Anschrift: " + PLACEHOLDERS.BUSINESS_ADDRESS + "). Diese Bedingungen gelten zusätzlich zu den Hinweisen in der Datenschutzerklärung und den übrigen Policy-Seiten der Plattform.",
          en: "You must accept the Terms of Service to create an account and use the platform. You are dealing with " + PLACEHOLDERS.LEGAL_ENTITY + " (address: " + PLACEHOLDERS.BUSINESS_ADDRESS + "). These terms apply in addition to the notices in the Privacy Policy and the other policy pages of the platform.",
          fr: "Vous devez accepter les conditions d'utilisation pour créer un compte et utiliser la plateforme. Vous avez affaire à " + PLACEHOLDERS.LEGAL_ENTITY + " (adresse : " + PLACEHOLDERS.BUSINESS_ADDRESS + "). Ces conditions s'appliquent en plus des mentions de la politique de confidentialité et des autres pages de politique de la plateforme.",
          ar: "يجب عليك قبول شروط الخدمة لإنشاء حساب واستخدام المنصّة. وأنت تتعامل مع " + PLACEHOLDERS.LEGAL_ENTITY + " (العنوان: " + PLACEHOLDERS.BUSINESS_ADDRESS + "). وتطبق هذه الشروط إضافةً إلى التنبيهات الواردة في سياسة الخصوصية وبقية صفحات السياسة في المنصّة.",
        },
      ],
    },
    {
      id: "service",
      title: {
        de: "Über die Dienstleistung",
        en: "About the Service",
        fr: "À propos du service",
        ar: "عن الخدمة",
      },
      p: [
        {
          de: "AusbildungsWeg ist ein Arbeitsbereich für die Suche nach Ausbildung und Jobs in Deutschland. Die Plattform bietet unter anderem: klassische Suche (Quelle: Jobbörse der Bundesagentur für Arbeit), KI-Suche, gespeicherte Stellen, Bewerbungsscan, CV-Builder, Anschreiben-Builder, E-Mail-Tools (Sammlung und Versand), Bewerbungen und Benachrichtigungen.",
          en: "AusbildungsWeg is a workspace for searching apprenticeships and jobs in Germany. The platform offers, among others: classic search (source: Federal Employment Agency Jobbörse), AI Search, saved opportunities, Application Scanner, CV Builder, Cover Letter Builder, email tools (collector and sending), applications and notifications.",
          fr: "AusbildungsWeg est un espace de travail pour la recherche d'alternance et d'emplois en Allemagne. La plateforme propose notamment : recherche classique (source : Jobbörse de l'Agence fédérale), Recherche IA, offres enregistrées, Scan de candidature, éditeur de CV, éditeur de lettre, outils e-mail (collecteur et envoi), candidatures et notifications.",
          ar: "AusbildungsWeg هي مساحة عمل للبحث عن التدريب المهني والوظائف في ألمانيا. وتوفر المنصّة على سبيل المثال: البحث العادي (المصدر: لوحة وظائف وكالة العمل)، والبحث بالذكاء الاصطناعي، والوظائف المحفوظة، وماسح الطلبات، ومنشئ السيرة الذاتية، ومنشئ خطاب التقديم، وأدوات البريد (الجمع والإرسال)، وطلبات التقديم، والإشعارات.",
        },
      ],
    },
    {
      id: "registration",
      title: {
        de: "Konto-Registrierung",
        en: "Account Registration",
        fr: "Inscription au compte",
        ar: "تسجيل الحساب",
      },
      p: [
        {
          de: "Für die Nutzung benötigen Sie ein Konto. Bei der Registrierung geben Sie Name, E-Mail-Adresse und ein Passwort an; danach bestätigen Sie Ihr Konto per E-Mail. Sie sind dafür verantwortlich, dass die Angaben wahrheitsgemäß sind und dass Sie Zugang zur angegebenen E-Mail-Adresse haben. Ein Konto ist persönlich und darf nicht weitergegeben werden.",
          en: "You need an account to use the platform. At registration you provide your name, email address and a password; afterwards you confirm your account by email. You are responsible for the truthfulness of the information and for having access to the stated email address. An account is personal and must not be shared.",
          fr: "Vous avez besoin d'un compte pour utiliser la plateforme. À l'inscription, vous fournissez votre nom, votre e-mail et un mot de passe ; vous confirmez ensuite votre compte par e-mail. Vous êtes responsable de la véracité des informations et de l'accès à l'adresse e-mail indiquée. Un compte est personnel et ne doit pas être partagé.",
          ar: "تحتاج إلى حساب لاستخدام المنصّة. وعند التسجيل توفّر اسمك وبريدك الإلكتروني وكلمة مرور، ثم توثّق حسابك عبر البريد. وأنت المسؤول عن صحة المعلومات وعن امتلاكك وصولًا إلى البريد المذكور. الحساب شخصي ولا يجوز مشاركته.",
        },
      ],
    },
    {
      id: "responsibilities",
      title: {
        de: "Verantwortung des Nutzers",
        en: "User Responsibilities",
        fr: "Responsabilités de l'utilisateur",
        ar: "مسؤوليات المستخدم",
      },
      li: [
        {
          de: "Sie sind verantwortlich für alle Aktivitäten in Ihrem Konto.",
          en: "You are responsible for all activity in your account.",
          fr: "Vous êtes responsable de toute activité dans votre compte.",
          ar: "أنت المسؤول عن جميع النشاطات في حسابك.",
        },
        {
          de: "Sie halten Ihre Zugangsdaten geheim und melden uns unbefugte Nutzung über die Kontaktseite.",
          en: "You keep your credentials secret and report unauthorized use via the Contact page.",
          fr: "Vous gardez vos identifiants secrets et nous signalez toute utilisation non autorisée via la page Contact.",
          ar: "تحافظ على سرية بيانات دخولك وتبلغنا عن أي استخدام غير مصرّح به عبر صفحة الاتصال.",
        },
        {
          de: "Sie stellen sicher, dass die von Ihnen hochgeladenen Inhalte und die E-Mails, die Sie versenden, rechtmäßig sind.",
          en: "You ensure that the content you upload and the emails you send are lawful.",
          fr: "Vous vous assurez que les contenus que vous téléversez et les e-mails que vous envoyez sont licites.",
          ar: "تتأكد من أن المحتويات التي ترفعها والرسائل التي ترسلها مشروعة.",
        },
        {
          de: "Sie prüfen Informationen (z. B. zu Stellen oder Unternehmen) vor der Verwendung selbst – die Plattform stellt keine Beschäftigungszusage dar.",
          en: "You verify information yourself (e.g. about jobs or companies) before use – the platform is not an employment offer.",
          fr: "Vous vérifiez vous-même les informations (p. ex. sur les postes ou les entreprises) avant de les utiliser – la plateforme ne constitue pas une promesse d'embauche.",
          ar: "تحقّق بنفسك من المعلومات (مثل معلومات الوظائف أو الشركات) قبل استخدامها — فالمنصّة ليست عرض توظيف.",
        },
      ],
    },
    {
      id: "acceptable",
      title: {
        de: "Zulässige Nutzung",
        en: "Acceptable Use",
        fr: "Utilisation licite",
        ar: "الاستخدام المشروع",
      },
      p: [
        {
          de: "Sie dürfen die Plattform für die rechtmäßige Suche nach Ausbildung und Jobs sowie für die damit verbundenen Bewerbungsvorbereitungen nutzen – allein oder gemeinsam mit Ihrem Team bzw. Ihren Mitbewerbern, soweit Sie selbst für Ihr Konto verantwortlich sind.",
          en: "You may use the platform for the lawful search for apprenticeships and jobs and for the related application preparation – individually or together with your team or fellow candidates, as long as you are responsible for your own account.",
          fr: "Vous pouvez utiliser la plateforme pour la recherche licite d'alternance et d'emplois et pour la préparation de candidature associée – individuellement ou avec votre équipe ou vos co-candidats, dès lors que vous êtes responsable de votre propre compte.",
          ar: "يجوزك استخدام المنصّة للبحث المشروع عن التدريب والوظائف وللحضيرات المرتبطة بالتقديم — فرديًا أو مع فريقك أو مع مرشّحين آخرين، ما دمت مسؤولًا عن حسابك.",
        },
      ],
    },
    {
      id: "prohibited",
      title: {
        de: "Verbotene Aktivitäten",
        en: "Prohibited Activities",
        fr: "Activités interdites",
        ar: "الأنشطة المحظورة",
      },
      li: [
        {
          de: "Missbrauch der Plattform für Spam, Phishing oder andere illegale Aktivitäten – insbesondere der E-Mail-Versand an Personen, die nicht willens sind, Kontakt zu erhalten.",
          en: "Abusing the platform for spam, phishing or other illegal activities – in particular emailing people who do not wish to be contacted.",
          fr: "Utiliser la plateforme pour du spam, du phishing ou toute autre activité illégale – en particulier envoyer des e-mails à des personnes qui ne souhaitent pas être contactées.",
          ar: "إساءة استخدام المنصّة للإرسال العشوائي (سبام) أو التصيّد أو أي أنشطة غير مشروعة — ولا سيما إرسال رسائل إلى أشخاص لا يودون التواصل.",
        },
        {
          de: "Umgehung von Zugangskontrollen, Limits oder Sicherheitsmechanismen.",
          en: "Bypassing access controls, limits or security mechanisms.",
          fr: "Contourner les contrôles d'accès, les limites ou les mécanismes de sécurité.",
          ar: "التحايل على ضوابط الوصول أو الحدود أو آليات الأمان.",
        },
        {
          de: "Hochladen von Inhalten, für die Sie keine Rechte haben, oder von schädlicher Software.",
          en: "Uploading content you have no rights to, or malware.",
          fr: "Téléverser des contenus dont vous ne détenez pas les droits, ou des logiciels malveillants.",
          ar: "رفع محتويات لا تملك حقوقها، أو برامج خبيثة.",
        },
        {
          de: "Versuch, in die Daten anderer Nutzer oder in die Plattforminfrastruktur einzudringen.",
          en: "Attempting to access other users' data or the platform infrastructure.",
          fr: "Tenter d'accéder aux données d'autres utilisateurs ou à l'infrastructure de la plateforme.",
          ar: "محاولة الوصول إلى بيانات مستخدمين آخرين أو إلى بنية المنصّة التحتية.",
        },
        {
          de: "Verkauf oder gewerbliche Weitergabe von über die Plattform erlangten Daten ohne Einwilligung der Betroffenen.",
          en: "Selling or commercially redistributing data obtained through the platform without the affected persons' consent.",
          fr: "Vendre ou redistribuer commercialement des données obtenues via la plateforme sans le consentement des personnes concernées.",
          ar: "بيع أو إعادة توزيع تجاري للبيانات المكتسبة عبر المنصّة دون موافقة المعنيين.",
        },
      ],
    },
    {
      id: "ai-assistant",
      title: {
        de: "KI-Assistent",
        en: "AI Assistant",
        fr: "Assistant IA",
        ar: "المساعد الذكي",
      },
      p: [
        {
          de: "Der KI-Assistent ist auf den Bereich der Plattform spezialisiert (Ausbildung, Jobs in Deutschland, Bewerbungen, Lebenslauf, Anschreiben, Nutzung der Plattform). Fragen, die deutlich außerhalb dieses Bereichs liegen, werden abgelehnt oder auf das Thema zurückgeführt. Der Assistent ist kein allgemeiner Chatbot und keine Ersatzperson für Fachberatung.",
          en: "The AI Assistant is specialized to the platform's domain (apprenticeships, jobs in Germany, applications, CV, cover letter, platform usage). Questions clearly outside this domain are declined or redirected. The assistant is not a general chatbot and not a substitute for professional advice.",
          fr: "L'Assistant IA est spécialisé dans le domaine de la plateforme (alternance, emplois en Allemagne, candidatures, CV, lettre de motivation, utilisation de la plateforme). Les questions clairement hors de ce domaine sont refusées ou redirigées. L'assistant n'est pas un chatbot général et ne remplace pas un conseil professionnel.",
          ar: "المساعد الذكي متخصص في مجال المنصّة (التدريب، العمل في ألمانيا، طلبات التقديم، السيرة الذاتية، خطاب التقديم، استخدام المنصّة). والأسئلة البعيدة عن هذا المجال تُرفض أو يُعاد توجيهها. والمساعد ليس روبوت محادثة عامًا ولا بديلًا عن الاستشارة المتخصصة.",
        },
      ],
      to: "/ai-usage",
      toLabel: {
        de: "Alle Angaben zur KI-Nutzung",
        en: "All information about AI Usage",
        fr: "Toutes les informations sur l'utilisation de l'IA",
        ar: "جميع المعلومات عن استخدام الذكاء الاصطناعي",
      },
    },
    {
      id: "ai-content",
      title: {
        de: "KI-generierte Inhalte",
        en: "AI-Generated Content",
        fr: "Contenus générés par IA",
        ar: "المحتوى المولّد بالذكاء الاصطناعي",
      },
      p: [
        {
          de: "KI-generierte Inhalte (z. B. Antworten des Assistenten, gescannte Profilangaben, KI-Anschreiben) sind Ausgangspunkte, keine fertigen Erzeugnisse: Sie prüfen, korrigieren und übernehmen sie vor der Verwendung in Ihre eigene Verantwortung. Die KI kann sich irren; es gibt keine Garantie für Richtigkeit, Vollständigkeit oder Eignung.",
          en: "AI-generated content (e.g. assistant answers, scanned profile details, AI cover letters) is a starting point, not a finished product: you review, correct and adopt it at your own responsibility before use. The AI can be wrong; there is no guarantee of accuracy, completeness or fitness.",
          fr: "Les contenus générés par IA (p. ex. réponses de l'assistant, informations de profil scannées, lettres IA) sont un point de départ, non un produit fini : vous les vérifiez, les corrigez et les adoptez sous votre propre responsabilité avant usage. L'IA peut se tromper ; aucune garantie de justesse, d'exhaustivité ou d'adéquation n'est donnée.",
          ar: "المحتوى المولّد بالذكاء الاصطناعي (مثل إجابات المساعد، البيانات المستخرجة من المسح، خطابات التقديم المولّدة) هو نقطة انطلاق وليس منتجًا مكتملًا: تراجع وتحقّق وتبناه بمسؤوليتك قبل الاستخدام. وقد يخطئ الذكاء الاصطناعي؛ ولا توجد ضمانات على الدقة أو الاكتمال أو الملاءمة.",
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
          de: "Die Suche liefert Angebote von externen Quellen (klassisch: Jobbörse der Bundesagentur für Arbeit; KI-Suche zusätzlich: öffentliche Webquellen). Die Plattform leitet, filtert und präsentiert diese Angebote – sie ist nicht Anbieter der Stellen.",
          en: "The search provides listings from external sources (classic: Federal Employment Agency Jobbörse; AI Search additionally: public web sources). The platform retrieves, filters and presents these listings – it is not the employer of the positions.",
          fr: "La recherche fournit des offres provenant de sources externes (classique : Jobbörse de l'Agence fédérale ; Recherche IA en plus : sources web publiques). La plateforme récupère, filtre et présente ces offres – elle n'est pas l'employeur des postes.",
          ar: "يوفر البحث إعلانات من مصادر خارجية (عادي: لوحة وظائف وكالة العمل؛ وبحث الذكاء الاصطناعي إضافة: مصادر ويب عامة). وتقوم المنصّة بجلب هذه الإعلانات وتصفيتها وعرضها — وهي ليست جهة توظيف لهذه المناصب.",
        },
      ],
      li: [
        {
          de: "Angebote können sich ändern, gelöscht oder abgelaufen sein. Sie stimmen zu, alle Angaben (Bewerbungsfrist, Anforderungen, Kontakt) vor der Bewerbung direkt bei der Quelle bzw. beim Unternehmen zu prüfen.",
          en: "Listings can change, be removed or expire. You agree to verify all details (deadline, requirements, contact) directly with the source or company before applying.",
          fr: "Les offres peuvent changer, être supprimées ou expirer. Vous vous engagez à vérifier tous les détails (délai, exigences, contact) directement auprès de la source ou de l'entreprise avant de postuler.",
          ar: "قد تتغير الإعلانات أو تُحذف أو تنتهي مهلتها. وأنت توافق على التحقق من جميع التفاصيل (الموعد النهائي، المتطلبات، جهة التواصل) مباشرةً من المصدر أو الشركة قبل التقديم.",
        },
        {
          de: "Die Plattform gibt keine Garantie für den Erhalt einer Ausbildung oder einer Stelle und vermittelt keine Beschäftigung.",
          en: "The platform gives no guarantee of obtaining an apprenticeship or a job and does not arrange employment.",
          fr: "La plateforme ne garantit pas l'obtention d'une alternance ou d'un emploi et ne procure pas d'emploi.",
          ar: "لا تقدم المنصّة أي ضمان للحصول على تدريب أو وظيفة، ولا تُرتّب توظيفًا.",
        },
      ],
    },
    {
      id: "scanner",
      title: {
        de: "Bewerbungsscan",
        en: "Application Scanner",
        fr: "Scan de candidature",
        ar: "ماسح الطلبات",
      },
      p: [
        {
          de: "Der Bewerbungsscan extrahiert Angaben aus Ihren hochgeladenen Dokumenten. Die Erkennung ist so genau wie die Quelle: Unleserliche, unvollständige oder unüblich formatierte Dokumente können zu unvollständigen Ergebnissen führen. Sie tragen für die Richtigkeit Ihrer Dokumente und der daraus erkannten Angaben die Verantwortung.",
          en: "The Application Scanner extracts details from your uploaded documents. Recognition is only as accurate as the source: unreadable, incomplete or unusually formatted documents can lead to incomplete results. You are responsible for the correctness of your documents and the details recognized from them.",
          fr: "Le Scan de candidature extrait des informations de vos documents téléversés. La reconnaissance n'est précise qu'en fonction de la source : des documents illisibles, incomplets ou au format inhabituel peuvent conduire à des résultats incomplets. Vous êtes responsable de l'exactitude de vos documents et des informations reconnues.",
          ar: "يستخرج ماسح الطلبات البيانات من مستنداتك المرفوعة. والدقة في التعرّف تعتمد على المصدر: المستندات غير القابلة للقراءة أو الناقصة أو غير المنظمة قد تؤدي إلى نتائج ناقصة. وأنت المسؤول عن صحة مستنداتك وعن البيانات المستخرجة منها.",
        },
      ],
    },
    {
      id: "cv",
      title: {
        de: "CV-Builder und Vorlagen",
        en: "CV Builder and Templates",
        fr: "Éditeur de CV et modèles",
        ar: "منشئ السيرة الذاتية والقوالب",
      },
      p: [
        {
          de: "Der CV-Builder mit der Vorlage Professional Classic hilft, einen strukturierten Lebenslauf zu erstellen. Der Import übernimmt erkannte Angaben aus Ihrem letzten Bewerbungsscan; Zusammenfassung, Projekte und Interessen bleiben beim Import bewusst leer. Der CV-Entwurf wird lokal in Ihrem Browser gespeichert – Sie sind für dessen Inhalt verantwortlich.",
          en: "The CV Builder with the Professional Classic template helps you create a structured CV. Import takes over the details recognized from your latest Application Scanner; summary, projects and interests are deliberately left empty on import. The CV draft is stored locally in your browser – you are responsible for its content.",
          fr: "L'éditeur de CV avec le modèle Professional Classic vous aide à créer un CV structuré. L'import reprend les informations reconnues de votre dernier Scan de candidature ; le résumé, les projets et les centres d'intérêt restent volontairement vides. Le brouillon de CV est stocké localement dans votre navigateur – vous êtes responsable de son contenu.",
          ar: "يساعدك منشئ السيرة الذاتية بالقالب Professional Classic على إنشاء سيرة منظمة. ويستورد البيانات المعترف بها من آخر مسح لطلباتك؛ ويبقى الملخص والمشاريع والهوايات فارغة عمدًا عند الاستيراد. وتُحفظ مسودة السيرة محليًا في متصفحك — وأنت المسؤول عن محتواها.",
        },
      ],
    },
    {
      id: "cover-letter",
      title: {
        de: "Anschreiben",
        en: "Cover Letter",
        fr: "Lettre de motivation",
        ar: "خطاب التقديم",
      },
      p: [
        {
          de: "Der Anschreiben-Builder erstellt Ihren Text manuell oder mit KI. Der KI-Entwurf stützt sich auf Ihre tatsächlichen Angaben; Sie überarbeiten und übernehmen ihn in eigener Verantwortung. Der Entwurf wird lokal in Ihrem Browser gespeichert.",
          en: "The Cover Letter Builder creates your text manually or with AI. The AI draft relies on your real details; you revise and adopt it at your own responsibility. The draft is stored locally in your browser.",
          fr: "L'éditeur de lettre crée votre texte manuellement ou avec l'IA. Le brouillon IA s'appuie sur vos informations réelles ; vous le révisez et l'adoptez sous votre propre responsabilité. Le brouillon est stocké localement dans votre navigateur.",
          ar: "ينشئ منشئ خطاب التقديم نصك يدويًا أو بالذكاء الاصطناعي. وتعتمد المسودة المولّدة على بياناتك الحقيقية؛ وتراجعها وتبناها بمسؤوليتك. وتُحفظ المسودة محليًا في متصفحك.",
        },
      ],
    },
    {
      id: "deckblatt",
      title: {
        de: "Deckblatt",
        en: "Cover Page (Deckblatt)",
        fr: "Page de couverture (Deckblatt)",
        ar: "الغلاف (Deckblatt)",
      },
      p: [
        {
          de: "Ein Deckblatt-Builder ist derzeit nicht Teil der Plattform. Für dieses Thema gilt daher keine Leistungspflicht; es werden keine Funktionen in Aussicht gestellt, die nicht existieren.",
          en: "A cover page (Deckblatt) builder is currently not part of the platform. No service obligation applies to this topic; no features are promised that do not exist.",
          fr: "Un éditeur de page de couverture (Deckblatt) n'est actuellement pas une partie de la plateforme. Aucune obligation de service ne s'applique à ce sujet ; aucune fonctionnalité n'est promise sans exister.",
          ar: "أداة إنشاء الغلاف (Deckblatt) ليست حاليًا جزءًا من المنصّة. وبالتالي لا توجد التزامات خدمية تجاه هذا الموضوع؛ ولا تُعهد ميزات غير موجودة.",
        },
      ],
    },
    {
      id: "email-tools",
      title: {
        de: "E-Mail-Tools (Sammlung und Versand)",
        en: "Email Tools (Collector and Sending)",
        fr: "Outils e-mail (collecteur et envoi)",
        ar: "أدوات البريد (الجمع والإرسال)",
      },
      p: [
        {
          de: "Die E-Mail-Sammlung erfasst nur Adressen, die in Stellenangeboten tatsächlich angegeben sind; sie erfindet und rät keine Adressen. Der E-Mail-Versand erfolgt über Ihr eigenes verknüpftes Gmail- oder Outlook-Konto.",
          en: "The Email Collector captures only addresses actually stated in job listings; it invents and guesses no addresses. Email sending happens through your own connected Gmail or Outlook account.",
          fr: "Le collecteur d'e-mails ne capture que des adresses réellement indiquées dans les offres ; il n'invente et ne devine aucune adresse. L'envoi d'e-mails s'effectue via votre propre compte Gmail ou Outlook connecté.",
          ar: "يجمع جهاز جمع البريد فقط العناوين المذكورة فعلًا في إعلانات الوظائف؛ ولا يخترع ولا يتخمن عناوين. ويتم الإرسال عبر حساب Gmail أو Outlook الخاص بك والمربوط.",
        },
      ],
      li: [
        {
          de: "Sie haften für die Rechtmäßigkeit Ihrer Empfängerliste und Ihrer Nachrichten – insbesondere für die Einhaltung der geltenden Regeln gegen unerwünschte Werbung. Der Versand an Personen, die keinen Kontakt wünschen, ist untersagt.",
          en: "You are liable for the lawfulness of your recipient list and your messages – in particular for complying with the applicable rules against unsolicited advertising. Sending to people who do not wish contact is prohibited.",
          fr: "Vous êtes responsable de la licéité de votre liste de destinataires et de vos messages – en particulier du respect des règles applicables contre la publicité non sollicitée. L'envoi à des personnes qui ne souhaitent pas être contactées est interdit.",
          ar: "أنت المسؤول عن مشروعية قائمة المستلمين ورسائلك — خاصة عن مراعاة القواعد السارية ضد الإعلانات غير المرغوب فيها. وإرسال الرسائل إلى أشخاص لا يريدون التواصل ممنوع.",
        },
        {
          de: "Versandmengen sind durch tägliche Limits begrenzt; die konkreten Werte hängen von Ihrem Plan ab.",
          en: "Sending volumes are bounded by daily limits; the exact values depend on your plan.",
          fr: "Les volumes d'envoi sont limités par des quotas quotidiens ; les valeurs exactes dépendent de votre plan.",
          ar: "تخضع كميات الإرسال لحدود يومية؛ والقيم الدقيقة تعتمد على خطتك.",
        },
      ],
    },
    {
      id: "applications",
      title: {
        de: "Bewerbungen",
        en: "Applications",
        fr: "Candidatures",
        ar: "طلبات التقديم",
      },
      p: [
        {
          de: "Sie können Bewerbungen vorbereiten und über Ihr verknüpftes E-Mail-Konto versenden. Die Plattform sendet technisch korrekt, garantiert aber kein Ergebnis der Bewerbung. Ihre Bewerbungen und deren Verlauf werden in Ihrem Konto gespeichert.",
          en: "You can prepare applications and send them through your connected email account. The platform sends them technically correctly, but guarantees no application outcome. Your applications and their history are stored in your account.",
          fr: "Vous pouvez préparer des candidatures et les envoyer via votre compte e-mail connecté. La plateforme les envoie techniquement correctement, mais ne garantit aucun résultat de candidature. Vos candidatures et leur historique sont stockées dans votre compte.",
          ar: "يمكنك تجهيز الطلبات وإرسالها عبر حساب بريدك المربوط. وتقوم المنصّة بالإرسال بشكل صحيح تقنيًا، لكنها لا تضمن نتيجة الطلب. وتُحفظ طلباتك وسجلها في حسابك.",
        },
      ],
    },
    {
      id: "saved",
      title: {
        de: "Gespeicherte Stellenangebote",
        en: "Saved Opportunities",
        fr: "Offres enregistrées",
        ar: "الوظائف المحفوظة",
      },
      p: [
        {
          de: "Ihre gespeicherten Stellen sind ein privater Merkpunkt in Ihrem Konto. Sie sind keine Garantie, dass das Angebot weiterhin verfügbar ist – prüfen Sie vor der Bewerbung das Originalangebot.",
          en: "Your saved jobs are a private bookmark in your account. They are no guarantee that the listing is still available – check the original listing before applying.",
          fr: "Vos offres enregistrées sont un signet privé dans votre compte. Elles ne garantissent pas que l'offre est toujours disponible – vérifiez l'offre originale avant de postuler.",
          ar: "وظائفك المحفوظة نقطة إحفاظ خاصة في حسابك. وهي ليست ضمانًا على أن العرض ما زال متاحًا — تحقق من الإعلان الأصلي قبل التقديم.",
        },
      ],
    },
    {
      id: "notifications",
      title: {
        de: "Benachrichtigungen",
        en: "Notifications",
        fr: "Notifications",
        ar: "الإشعارات",
      },
      p: [
        {
          de: "Die Plattform kann Ihnen in-app-Mitteilungen anzeigen (z. B. Plattform-Updates). Benachrichtigungen werden nicht per E-Mail, SMS oder Push zugestellt. Regelmäßige Nutzer können keine Benachrichtigungen versenden; Plattform-Mitteilungen stammen vom Betreiber.",
          en: "The platform can show you in-app messages (e.g. platform updates). Notifications are not delivered by email, SMS or push. Regular users cannot send notifications; platform messages come from the operator.",
          fr: "La plateforme peut vous afficher des messages dans l'application (p. ex. mises à jour de la plateforme). Les notifications ne sont pas livrées par e-mail, SMS ou push. Les utilisateurs ordinaires ne peuvent pas envoyer de notifications ; les messages de plateforme proviennent de l'opérateur.",
          ar: "يمكن للمنصّة عرض رسائل داخل التطبيق عليك (مثل تحديثات المنصّة). ولا تُسلَّم الإشعارات عبر البريد أو الرسائل النصية أو الدفع. ولا يمكن للمستخدمين العاديين إرسال إشعارات؛ ورسائل المنصّة تأتي من المشغّل.",
        },
      ],
    },
    {
      id: "accuracy",
      title: {
        de: "Genauigkeit der Informationen",
        en: "Accuracy of Information",
        fr: "Exactitude des informations",
        ar: "دقة المعلومات",
      },
      p: [
        {
          de: "Die Plattform strebt nach Genauigkeit, übernimmt aber keine Gewähr für die Richtigkeit, Vollständigkeit oder Aktualität von Informationen externer Quellen (Stellenangebote, Unternehmen, Websites). Änderungen werden nicht aktiv überwacht. Sie nehmen an, dass Informationen sich ändern können, und tragen die Verantwortung, sie bei Bedarf direkt bei der Quelle zu prüfen.",
          en: "The platform strives for accuracy but gives no warranty for the correctness, completeness or currency of information from external sources (job listings, companies, websites). Changes are not actively monitored. You acknowledge that information can change and accept the responsibility to verify it directly with the source when needed.",
          fr: "La plateforme s'efforce d'être exacte, mais ne donne aucune garantie sur la justesse, l'exhaustivité ou l'actualité des informations provenant de sources externes (offres, entreprises, sites web). Les changements ne sont pas activement surveillés. Vous reconnaissez que les informations peuvent changer et acceptez la responsabilité de les vérifier directement auprès de la source si nécessaire.",
          ar: "تسعى المنصّة إلى الدقة، لكنها لا تتحمل أي ضمان بشأن صحة أو اكتمال أو حيوية المعلومات من المصادر الخارجية (إعلانات الوظائف، الشركات، المواقع). ولا تُراقب التغييرات بشكل نشط. وأنت تقرّ بأن المعلومات قد تتغير، وتتحمّل مسؤولية التحقق منها مباشرةً من المصدر عند الحاجة.",
        },
      ],
    },
    {
      id: "user-content",
      title: {
        de: "Von Ihnen erstellte Inhalte und hochgeladene Dokumente",
        en: "User-Generated Content and Uploaded Documents",
        fr: "Contenus que vous créez et documents téléversés",
        ar: "المحتوى الذي تنشئه والمستندات المرفوعة",
      },
      p: [
        {
          de: "Sie behalten das Eigentum an allen Inhalten, die Sie erstellen oder hochladen (CV, Anschreiben, Dokumente, Texte). Sie gewähren der Plattform lediglich die technischen Rechte, die für die Bereitstellung und Ihren eigenen Zugriff auf die Funktionen erforderlich sind (Speichern, Auswertung für Sie, Anzeige in Ihrem Konto).",
          en: "You retain ownership of all content you create or upload (CV, cover letters, documents, texts). You grant the platform only the technical rights required to provide the features and your own access (storing, processing for you, displaying in your account).",
          fr: "Vous conservez la propriété de tous les contenus que vous créez ou téléversez (CV, lettres, documents, textes). Vous accordez à la plateforme uniquement les droits techniques nécessaires à la fourniture des fonctionnalités et à votre propre accès (stockage, traitement pour vous, affichage dans votre compte).",
          ar: "تحتفظ بملكية جميع المحتويات التي تنشئها أو ترفعها (السيرة، خطابات التقديم، المستندات، النصوص). وتُمنح المنصّة فقط الصلاحيات التقنية اللازمة لتوفير الميزات ولوصولك الخاص (التخزين، المعالجة من أجلك، العرض في حسابك).",
        },
      ],
      li: [
        {
          de: "Sie stellen sicher, dass Sie das Recht haben, die Inhalte zu verwenden und zu verarbeiten.",
          en: "You ensure you have the right to use and process the content.",
          fr: "Vous vous assurez que vous avez le droit d'utiliser et de traiter les contenus.",
          ar: "تتأكد من أنك تملك الحق في استخدام المحتويات ومعالجتها.",
        },
        {
          de: "Geben Sie nur persönliche Daten weiter, die Sie für die Bewerbung verwenden möchten.",
          en: "Share only personal data you want to use for your application.",
          fr: "Ne partagez que des données personnelles que vous voulez utiliser pour votre candidature.",
          ar: "شارك فقط البيانات الشخصية التي تريد استخدامها في طلبك.",
        },
      ],
    },
    {
      id: "ip",
      title: {
        de: "Geistiges Eigentum",
        en: "Intellectual Property",
        fr: "Propriété intellectuelle",
        ar: "الملكية الفكرية",
      },
      p: [
        {
          de: "Die Plattform (Design, Code, Vorlagen, Marken, Texte) ist Eigentum von " + PLACEHOLDERS.LEGAL_ENTITY + " und durch das geltende Recht geschützt. Ihnen wird kein Recht an diesen Bestandteilen eingeräumt. KI-generierte Inhalte, die Sie erstellen oder übernehmen, nutzt und verwaltet jede Partei nach eigenem Ermessen, soweit keine Vereinbarung entgegensteht.",
          en: "The platform (design, code, templates, trademarks, texts) is the property of " + PLACEHOLDERS.LEGAL_ENTITY + " and protected by applicable law. You are granted no rights in these elements. AI-generated content you create or adopt is used and managed by each party at its discretion, unless otherwise agreed.",
          fr: "La plateforme (design, code, modèles, marques, textes) est la propriété de " + PLACEHOLDERS.LEGAL_ENTITY + " et protégée par la loi applicable. Aucun droit sur ces éléments ne vous est cédé. Les contenus générés par IA que vous créez ou adoptez sont utilisés et gérés par chaque partie à sa discrétion, sauf accord contraire.",
          ar: "تُمثّل المنصّة (التصميم، الكود، القوالب، العلامات التجارية، النصوص) ملكية " + PLACEHOLDERS.LEGAL_ENTITY + " ومحمية بالقانون الساري. ولا يُمنحك أي حق في هذه العناصر. والمحتوى المولّد بالذكاء الاصطناعي الذي تنشئه أو تتبناه تستخدمه وتديره كل طرف حسب تقديرها، ما لم يُتفق على غير ذلك.",
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
          de: "Die Plattform arbeitet mit Diensten Dritter zusammen (u. a. Supabase, KI-Dienste, Google Gemini, die Jobbörse der Bundesagentur für Arbeit, öffentliche Webquellen, Google/Microsoft für E-Mail-Verknüpfungen). Für den Inhalt, die Verfügbarkeit und die Richtlinien dieser externen Dienste übernehmen wir keine Verantwortung. Die Nutzung externer Angebote unterliegt zusätzlich den Bedingungen der jeweiligen Anbieter.",
          en: "The platform works with third-party services (incl. Supabase, AI services, Google Gemini, the Federal Employment Agency Jobbörse, public web sources, Google/Microsoft for email connections). We accept no responsibility for the content, availability or policies of these external services. Using external listings is additionally subject to the respective providers' terms.",
          fr: "La plateforme travaille avec des services tiers (notamment Supabase, services IA, Google Gemini, la Jobbörse de l'Agence fédérale, sources web publiques, Google/Microsoft pour les connexions e-mail). Nous n'acceptons aucune responsabilité quant au contenu, à la disponibilité ou aux politiques de ces services externes. L'utilisation d'offres externes est en outre soumise aux conditions des prestataires respectifs.",
          ar: "تعمل المنصّة مع خدمات خارجية (بما فيها Supabase وخدمات الذكاء الاصطناعي وGoogle Gemini ولوحة وظائف وكالة العمل ومصادر الويب العامة وGoogle/Microsoft لربط البريد). ولا نتحمل أي مسؤولية عن محتوى هذه الخدمات الخارجية أو توافرها أو سياساتها. والاستخدام الإضافي للإعلانات الخارجية يخضع أيضًا لشروط المزودين المعنيين.",
        },
      ],
    },
    {
      id: "availability",
      title: {
        de: "Verfügbarkeit des Dienstes",
        en: "Service Availability",
        fr: "Disponibilité du service",
        ar: "توفّر الخدمة",
      },
      p: [
        {
          de: "Die Plattform wird bestmöglich betrieben; es besteht jedoch keine Garantie für eine dauerhafte, ununterbrochene oder fehlerfreie Verfügbarkeit. Wartung, Ausfälle externer Quellen (z. B. der Jobbörse) oder technische Störungen können die Funktionen vorübergehend beeinträchtigen. Die Plattform zeigt solche Zustände transparent an, wo es technisch möglich ist.",
          en: "The platform is operated on a best-effort basis; however, there is no guarantee of continuous, uninterrupted or error-free availability. Maintenance, outages of external sources (e.g. the Jobbörse) or technical faults may temporarily affect the features. The platform displays such states transparently where technically possible.",
          fr: "La plateforme est exploitée au mieux ; toutefois, aucune garantie de disponibilité continue, ininterrompue ou sans erreur n'est donnée. La maintenance, les pannes de sources externes (p. ex. la Jobbörse) ou les dysfonctionnements techniques peuvent affecter temporairement les fonctionnalités. La plateforme signale ces états de manière transparente lorsque c'est techniquement possible.",
          ar: "تُشغَّل المنصّة بأقصى جهد؛ لكن لا يوجد ضمان لتوفّر مستمر أو دون انقطاع أو دون أخطاء. وقد تؤثر الصيانة أو أعطال المصادر الخارجية (مثل لوحة الوظائف) أو الأعطال التقنية مؤقتًا على الميزات. وتعرض المنصّة هذه الحالات بشفافية عندما يكون ذلك ممكنًا تقنيًا.",
        },
      ],
    },
    {
      id: "termination",
      title: {
        de: "Sperrung oder Beendigung des Kontos",
        en: "Account Suspension or Termination",
        fr: "Suspension ou résiliation du compte",
        ar: "إيقاف الحساب أو إنهائه",
      },
      p: [
        {
          de: "Wir behalten uns vor, ein Konto vorübergehend zu sperren oder zu beenden, wenn Sie gegen diese Bedingungen, die verbotenen Aktivitäten oder geltende Rechtsvorschriften verstoßen. Sie können Ihr Konto jederzeit selbst endgültig löschen (siehe Datenlöschung).",
          en: "We reserve the right to temporarily suspend or terminate an account if you violate these terms, the prohibited activities or applicable regulations. You can permanently delete your account yourself at any time (see Data Deletion).",
          fr: "Nous nous réservons le droit de suspendre ou de résilier temporairement un compte si vous violez ces conditions, les activités interdites ou les réglementations applicables. Vous pouvez supprimer définitivement votre compte vous-même à tout moment (voir Suppression des données).",
          ar: "نحتفظ بحق إيقاف حساب مؤقتًا أو إنهائه إذا خالفت هذه الشروط أو الأنشطة المحظورة أو اللوائح السارية. ويمكنك حذف حسابك نهائيًا بنفسك في أي وقت (انظر حذف البيانات).",
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
      id: "changes",
      title: {
        de: "Änderungen des Dienstes und der Bedingungen",
        en: "Changes to the Service and Terms",
        fr: "Modifications du service et des conditions",
        ar: "تغييرات الخدمة والشروط",
      },
      p: [
        {
          de: "Die Plattform kann Funktionen hinzufügen, anpassen oder entfernen und diese Bedingungen aktualisieren. Wesentliche Änderungen werden über die Plattform (z. B. Benachrichtigungen) bekannt gemacht. Ihre weitere Nutzung gilt als Einverständnis mit den geänderten Bedingungen.",
          en: "The platform may add, adjust or remove features and may update these terms. Material changes are announced through the platform (e.g. notifications). Your continued use constitutes agreement with the amended terms.",
          fr: "La plateforme peut ajouter, ajuster ou supprimer des fonctionnalités et mettre à jour ces conditions. Les modifications importantes sont annoncées via la plateforme (p. ex. notifications). Votre utilisation continue vaut accord aux conditions modifiées.",
          ar: "قد تضيف المنصّة ميزات أو تعدّلها أو تزيلها، وقد تحدّث هذه الشروط. وتُعلَن التغييرات الجوهرية عبر المنصّة (مثل الإشعارات). واستمرارك في الاستخدام يعني موافقتك على الشروط المعدّلة.",
        },
      ],
    },
    {
      id: "liability",
      title: {
        de: "Haftungsbegrenzung",
        en: "Limitation of Liability",
        fr: "Limitation de responsabilité",
        ar: "تقييد المسؤولية",
      },
      p: [
        {
          de: "Die Plattform und " + PLACEHOLDERS.LEGAL_ENTITY + " stellen den Dienst so bereit, wie er ist, ohne Garantien jeglicher Art, ausdrücklich oder stillschweigend. Im Rahmen der geltenden Rechtsvorschriften schließen wir Haftung für mittelbare Schäden, entgangene Gewinne, Datenverlust durch eigenes Verschulden des Nutzers oder Folgeschäden aus Bewerbungen aus. Die Haftung für Vorsatz und grobe Fahrlässigkeit bleibt davon unberührt, soweit gesetzlich nicht anders bestimmt.",
          en: "The platform and " + PLACEHOLDERS.LEGAL_ENTITY + " provide the service as is, without warranties of any kind, express or implied. Within the bounds of applicable regulations, we exclude liability for indirect damages, lost profits, data loss caused by the user's own fault, or consequential damages arising from applications. Liability for intent and gross negligence remains unaffected to the extent not otherwise provided by law.",
          fr: "La plateforme et " + PLACEHOLDERS.LEGAL_ENTITY + " fournissent le service en l'état, sans garantie d'aucune sorte, expresse ou implicite. Dans les limites des réglementations applicables, nous excluons la responsabilité pour les dommages indirects, les bénéfices manqués, la perte de données imputable à l'utilisateur ou les dommages découlant de candidatures. La responsabilité pour dol et faute grave demeure inchangée dans la mesure où la loi ne dispose pas autrement.",
          ar: "تُقدَّم المنصّة و" + PLACEHOLDERS.LEGAL_ENTITY + " الخدمة كما هي، دون أي ضمانات صريحة أو ضمنية. وفي حدود اللوائح السارية، نستثني المسؤولية عن الأضرار غير المباشرة، والأرباح الفائتة، وفقدان البيانات الناجم عن خطأ المستخدم نفسه، أو الأضرار المترتبة على طلبات التقديم. وتبقى المسؤولية عن القصد والخطأ الجسيم دون تغيير ما لم ينص القانون على غير ذلك.",
        },
        {
          de: "Diese Begrenzung stellt keine Rechtsberatung und keine Aussage über Ihr Recht auf Schadensersatz dar.",
          en: "This limitation is not legal advice and is not a statement about your right to damages.",
          fr: "Cette limitation ne constitue pas un conseil juridique et n'est pas une déclaration sur votre droit à réparation.",
          ar: "هذا التقييد ليس استشارة قانونية وليس بيانًا بشأن حقك في التعويض.",
        },
      ],
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
          de: "Fragen zu diesen Nutzungsbedingungen können Sie über die Kontaktseite stellen. Die zuständige Kontaktadresse ist dort angegeben.",
          en: "Questions about these Terms of Service can be submitted via the Contact page. The responsible contact address is listed there.",
          fr: "Les questions relatives aux présentes conditions peuvent être soumises via la page Contact. L'adresse de contact responsable y est indiquée.",
          ar: "يمكنك تقديم الأسئلة المتعلقة بشروط الخدمة هذه عبر صفحة الاتصال. والعنوان المسؤول مذكور هناك.",
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
