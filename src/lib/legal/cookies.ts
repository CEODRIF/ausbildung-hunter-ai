import type { LegalDoc } from "./types";

/**
 * Cookie Policy content — grounded in verified browser technologies:
 * aha_lang cookie (language), Supabase session cookies (auth),
 * localStorage (aha:theme, aha:sidebar, aha:cv:<uid>, aha:cover-letter:<uid>
 * + started flags). No analytics / tracking / advertising exist in the code.
 */
export const cookiesDoc: LegalDoc = {
  slug: "cookies",
  title: {
    de: "Cookie Policy",
    en: "Cookie Policy",
    fr: "Politique relative aux cookies",
    ar: "سياسة ملفات الارتباط",
  },
  intro: {
    de: "Diese Cookie Policy erklärt, welche Cookies und verwandten Technologien Ausbildung Hunter AI verwendet, warum sie benötigt werden und wie Sie sie steuern können. Sie beschreibt ausschließlich Technologien, die in der Plattform tatsächlich eingesetzt werden.",
    en: "This Cookie Policy explains which cookies and related technologies Ausbildung Hunter AI uses, why they are needed, and how you can control them. It describes only technologies actually deployed in the platform.",
    fr: "La présente politique relative aux cookies explique quels cookies et quelles technologies connexes Ausbildung Hunter AI utilise, pourquoi ils sont nécessaires et comment vous pouvez les contrôler. Elle ne décrit que les technologies réellement déployées dans la plateforme.",
    ar: "تشرح سياسة ملفات الارتباط هذه الكوكيز والتقنيات المرتبطة التي تستخدمها منصّة Ausbildung Hunter AI، ولماذا هي ضرورية، وكيف تتحكم بها. وهي تصف فقط التقنيات المستخدمة فعلًا في المنصّة.",
  },
  sections: [
    {
      id: "what-are",
      title: {
        de: "Was sind Cookies?",
        en: "What are cookies?",
        fr: "Que sont les cookies ?",
        ar: "ما هي ملفات الارتباط؟",
      },
      p: [
        {
          de: "Cookies sind kleine Textdateien, die Ihr Browser lokal speichert, wenn Sie eine Website besuchen. Sie ermöglichen es, Informationen (z. B. Ihre Sitzung oder Ihre Sprache) zwischen Besuchen zu behalten. Verwandt sind localStorage-Einträge, die ebenfalls nur in Ihrem Browser bleiben.",
          en: "Cookies are small text files that your browser stores locally when you visit a website. They let the site keep information (e.g. your session or your language) between visits. Related are localStorage entries, which also stay only in your browser.",
          fr: "Les cookies sont de petits fichiers texte que votre navigateur stocke localement lors d'une visite. Ils permettent au site de conserver des informations (p. ex. votre session ou votre langue) d'une visite à l'autre. Ils sont apparentés aux entrées localStorage, qui elles aussi restent uniquement dans votre navigateur.",
          ar: "ملفات الارتباط (الكوكيز) ملفات نصية صغيرة يخزّنها متصفحك محليًا عند زيارتك الموقع. وهي تتيح للموقع الاحتفاظ بمعلومات (مثل جلستك أو لغتك) بين الزيارات. ومن التقنيات المشابهة إدخالات localStorage التي تبقى أيضًا في متصفحك فقط.",
        },
      ],
    },
    {
      id: "why",
      title: {
        de: "Warum wir Cookies verwenden",
        en: "Why we use cookies",
        fr: "Pourquoi nous utilisons des cookies",
        ar: "لماذا نستخدم ملفات الارتباط",
      },
      p: [
        {
          de: "Wir verwenden ausschließlich Cookies, die für den Betrieb der Plattform erforderlich sind oder Ihre Einstellungen abbilden. Wir verwenden keine Marketing-, Werbe- oder Tracking-Cookies.",
          en: "We use only cookies that are necessary for the platform to operate or that reflect your preferences. We do not use marketing, advertising or tracking cookies.",
          fr: "Nous n'utilisons que des cookies nécessaires au fonctionnement de la plateforme ou reflétant vos préférences. Nous n'utilisons aucun cookie de marketing, de publicité ou de suivi.",
          ar: "نستخدم فقط الكوكيز اللازمة لتشغيل المنصّة أو التي تعكس تفضيلاتك. ولا نستخدم كوكيز تسويقية أو إعلانية أو لتتبّع.",
        },
      ],
    },
    {
      id: "essential",
      title: {
        de: "Erforderliche Funktionen",
        en: "Essential functionality",
        fr: "Fonctionnalités essentielles",
        ar: "الوظائف الأساسية",
      },
      li: [
        {
          de: "Sitzung/Cookie (Supabase): Hält Ihre Anmeldung aufrecht und schützt Ihre Kontoaktionen. Ohne diese Cookies bleibt eine Sitzung im Browser nicht aufrechterhalten – Sie müssten sich bei jedem Besuch erneut anmelden.",
          en: "Session cookies (Supabase): keep your sign-in alive and protect your account actions. Without these cookies a session cannot be maintained in the browser – you would have to sign in again on every visit.",
          fr: "Cookies de session (Supabase) : maintiennent votre connexion et protègent vos actions sur le compte. Sans ces cookies, une session ne peut pas être maintenue dans le navigateur – vous devriez vous reconnecter à chaque visite.",
          ar: "كوكيز الجلسة (Supabase): تحافظ على تسجيل دخولك وتحمي إجراءات حسابك. وبغير هذه الكوكيز لا يمكن الحفاظ على الجلسة في المتصفح — وستتطلب منك كل زيارة تسجيل الدخول مجددًا.",
        },
        {
          de: "Cookie aha_lang: Merkt sich Ihre gewählte Anzeigesprache (Deutsch, English, Français, العربية) und stellt sie bei Ihren nächsten Besuchen wieder her.",
          en: "Cookie aha_lang: remembers your chosen display language (German, English, French, Arabic) and restores it on your next visits.",
          fr: "Cookie aha_lang : mémorise votre langue d'affichage choisie (allemand, anglais, français, arabe) et la restaure à vos prochaines visites.",
          ar: "كوكي aha_lang: يتذكّر لغة العرض التي اخترتها (الألمانية، الإنجليزية، الفرنسية، العربية) ويعيدها في زياراتك التالية.",
        },
      ],
    },
    {
      id: "auth",
      title: {
        de: "Authentifizierung und Sitzung",
        en: "Authentication and session",
        fr: "Authentification et session",
        ar: "المصادقة والجلسة",
      },
      p: [
        {
          de: "Ihre Anmeldung wird über Supabase Auth abgewickelt. Die zugehörigen Sitzungs-Cookies (Namensschema sb-…-auth-token) werden in Ihrem Browser gesetzt und verschlüsselt gehalten; die Plattform prüft sie serverseitig, um Ihre Identität festzustellen. Sie enthalten keine frei lesbaren persönlichen Inhalte wie Namen oder E-Mail-Texte.",
          en: "Your sign-in is handled by Supabase Auth. The associated session cookies (naming pattern sb-…-auth-token) are set in your browser and kept encrypted; the platform verifies them server-side to establish your identity. They do not contain free-text personal content such as names or email bodies.",
          fr: "Votre connexion est gérée par Supabase Auth. Les cookies de session associés (schéma de nommage sb-…-auth-token) sont placés dans votre navigateur et conservés chiffrés ; la plateforme les vérifie côté serveur pour établir votre identité. Ils ne contiennent pas de contenu personnel en texte libre comme des noms ou des corps d'e-mail.",
          ar: "يتم تسجيل دخولك عبر Supabase Auth. وتُضبط كوكيز الجلسة المرتبطة (بنمط تسمية sb-…-auth-token) في متصفحك وتُحفظ مشفرة؛ وتتحقق المنصّة منها على الخادم لتحديد هويتك. ولا تحتوي على محتوى شخصي بنص حر مثل الأسماء أو نصوص البريد.",
        },
      ],
    },
    {
      id: "preferences",
      title: {
        de: "Einstellungen (Präferenzen)",
        en: "Preferences",
        fr: "Préférences",
        ar: "التفضيلات",
      },
      li: [
        {
          de: "Sprache: Cookie aha_lang (siehe oben) plus ein lokaler Spiegel im Browser (aha:lang).",
          en: "Language: cookie aha_lang (see above) plus a local mirror in the browser (aha:lang).",
          fr: "Langue : cookie aha_lang (voir ci-dessus) plus un miroir local dans le navigateur (aha:lang).",
          ar: "اللغة: كوكي aha_lang (انظر أعلاه) بالإضافة إلى نسخة محلية في المتصفح (aha:lang).",
        },
        {
          de: "Erscheinungsbild: Ihr Auswahl Hell / Dunkel / System wird lokal im Browser gespeichert (aha:theme).",
          en: "Appearance: your Light / Dark / System choice is stored locally in the browser (aha:theme).",
          fr: "Apparence : votre choix Clair / Sombre / Système est stocké localement dans le navigateur (aha:theme).",
          ar: "المظهر: يُحفظ اختيارك (فاتح/داكن/حسب النظام) محليًا في المتصفح (aha:theme).",
        },
        {
          de: "Seitenleiste: Der Zustand (eingeklappt/ausgeklappt) wird lokal gespeichert (aha:sidebar).",
          en: "Sidebar: the collapsed/expanded state is stored locally (aha:sidebar).",
          fr: "Barre latérale : l'état (repliée/dépliée) est stocké localement (aha:sidebar).",
          ar: "الشريط الجانبي: يُحفظ حالته (مطوي/موسّع) محليًا (aha:sidebar).",
        },
      ],
    },
    {
      id: "local-storage",
      title: {
        de: "Lokaler Speicher (localStorage)",
        en: "Local Storage (localStorage)",
        fr: "Stockage local (localStorage)",
        ar: "التخزين المحلي (localStorage)",
      },
      p: [
        {
          de: "Zusätzlich zu Cookies nutzt die Plattform localStorage in Ihrem Browser. Das betrifft insbesondere:",
          en: "In addition to cookies, the platform uses localStorage in your browser. This concerns in particular:",
          fr: "En plus des cookies, la plateforme utilise le localStorage dans votre navigateur. Il s'agit notamment de :",
          ar: "إلى جانب الكوكيز، تستخدم المنصّة localStorage في متصفحك. ويشمل على سبيل الخصوص:",
        },
      ],
      li: [
        {
          de: "CV-Entwurf (aha:cv:…): Ihr Lebenslauf-Entwurf, lokal in Ihrem Browser gespeichert, so dass er nach einem Neuladen wiederhergestellt wird.",
          en: "CV draft (aha:cv:…): your CV draft, stored locally in your browser so it is restored after a reload.",
          fr: "Brouillon de CV (aha:cv:…) : votre brouillon de CV, stocké localement dans votre navigateur afin d'être restauré après rechargement.",
          ar: "مسودة السيرة الذاتية (aha:cv:…): مسودة سيرتك، محفوظة محليًا في متصفحك لتُستعاد بعد إعادة التحميل.",
        },
        {
          de: "Anschreiben-Entwurf (aha:cover-letter:…): Ihr Anschreiben-Entwurf, ebenfalls lokal.",
          en: "Cover letter draft (aha:cover-letter:…): your cover letter draft, also local.",
          fr: "Brouillon de lettre (aha:cover-letter:…) : votre brouillon de lettre, également local.",
          ar: "مسودة خطاب التقديم (aha:cover-letter:…): مسودة خطابك، وهي أيضًا محلية.",
        },
        {
          de: "Sprache und Erscheinungsbild (aha:lang, aha:theme) sowie der Zustand der Seitenleiste (aha:sidebar).",
          en: "Language and appearance (aha:lang, aha:theme) as well as the sidebar state (aha:sidebar).",
          fr: "La langue et l'apparence (aha:lang, aha:theme) ainsi que l'état de la barre latérale (aha:sidebar).",
          ar: "اللغة والمظهر (aha:lang وaha:theme) بالإضافة إلى حالة الشريط الجانبي (aha:sidebar).",
        },
      ],
      pAfter: [
        {
          de: "localStorage-Inhalte verbleiben ausschließlich auf Ihrem Gerät und werden nicht an die Plattform übertragen. Sie entfernen sie, indem Sie den Browser-Speicher leeren.",
          en: "localStorage content remains exclusively on your device and is not transmitted to the platform. You remove it by clearing browser storage.",
          fr: "Le contenu du localStorage reste exclusivement sur votre appareil et n'est pas transmis à la plateforme. Vous le supprimez en effaçant le stockage du navigateur.",
          ar: "تبقى محتويات localStorage على جهازك حصريًا ولا تُرسَل إلى المنصّة. وتزيلها بتمسح تخزين المتصفح.",
        },
      ],
    },
    {
      id: "analytics",
      title: {
        de: "Analytics und Tracking",
        en: "Analytics and Tracking",
        fr: "Analytics et suivi",
        ar: "التحليل والتتبّع",
      },
      p: [
        {
          de: "Die Plattform verwendet keine Analytics-, Tracking- oder Werbedienste (z. B. kein Google Analytics, kein Pixel, kein Fingerprinting). Es werden keine Nutzungsprofile zu Werbezwecken erstellt und keine Daten zu diesem Zweck an Dritte übertragen.",
          en: "The platform uses no analytics, tracking or advertising services (e.g. no Google Analytics, no pixel, no fingerprinting). No usage profiles are created for advertising purposes and no data is transmitted to third parties for that purpose.",
          fr: "La plateforme n'utilise aucun service d'analytics, de suivi ou de publicité (p. ex. pas de Google Analytics, pas de pixel, pas de fingerprinting). Aucun profil d'utilisation n'est créé à des fins publicitaires et aucune donnée n'est transmise à des tiers à cette fin.",
          ar: "لا تستخدم المنصّة أي خدمات تحليل أو تتبّع أو إعلانات (لا Google Analytics، ولا بكسل، ولا بصمة رقمية). ولا تُنشأ ملفات استخدام لأغراض إعلانية ولا تُرسَل أي بيانات إلى أطراف ثالثة لهذا الغرض.",
        },
      ],
    },
    {
      id: "control",
      title: {
        de: "Steuerung der Cookies",
        en: "Controlling Cookies",
        fr: "Contrôle des cookies",
        ar: "التحكم في ملفات الارتباط",
      },
      p: [
        {
          de: "Sie können Cookies über die Einstellungen Ihres Browsers verwalten – etwa sie generell blockieren, bestehende löschen oder pro Website entscheiden. Bitte beachten Sie, dass das Deblockieren/Löschen bestimmte Funktionen der Plattform beeinflusst (siehe unten).",
          en: "You can manage cookies through your browser settings – e.g. block them generally, delete existing ones or decide per website. Please note that blocking/deleting affects certain platform features (see below).",
          fr: "Vous pouvez gérer les cookies via les réglages de votre navigateur – par exemple les bloquer globalement, supprimer les existants ou décider par site. Veuillez noter que le blocage/suppression affecte certaines fonctionnalités de la plateforme (voir ci-dessous).",
          ar: "يمكنك إدارة الكوكيز من إعدادات متصفحك — مثل حظرها كليًا، أو حذف الموجودة، أو اتخاذ القرار لكل موقع. وقدّر أن الحظر/الحذف يؤثر على بعض ميزات المنصّة (انظر أدناه).",
        },
      ],
    },
    {
      id: "disabled",
      title: {
        de: "Was passiert, wenn Cookies deaktiviert sind?",
        en: "What happens if cookies are disabled?",
        fr: "Que se passe-t-il si les cookies sont désactivés ?",
        ar: "ماذا يحدث إذا عطّلت ملفات الارتباط؟",
      },
      li: [
        {
          de: "Ohne Sitzungs-Cookies können Sie sich nicht angemeldet halten – die Anmeldung wäre bei jedem Vorgang neu erforderlich.",
          en: "Without session cookies you cannot stay signed in – sign-in would be required again for every operation.",
          fr: "Sans cookies de session, vous ne pouvez pas rester connecté – la connexion serait requise à nouveau pour chaque opération.",
          ar: "بدون كوكيز الجلسة لا يمكنك البقاء مسجّل الدخول — فسيُطلب تسجيل الدخول من جديد في كل عملية.",
        },
        {
          de: "Ihre gewählte Sprache wird nicht gemerkt und auf die Standardsprache (Deutsch) zurückgesetzt.",
          en: "Your chosen language is not remembered and resets to the default language (German).",
          fr: "Votre langue choisie n'est pas mémorisée et revient à la langue par défaut (allemand).",
          ar: "لا يُتذكَّر اختيار اللغة وتعود إلى اللغة الافتراضية (الألمانية).",
        },
        {
          de: "Lokale Entwürfe (CV, Anschreiben) und Einstellungen werden nicht wiederhergestellt, bis Sie den lokalen Speicher wieder erlauben.",
          en: "Local drafts (CV, cover letter) and settings are not restored until you allow local storage again.",
          fr: "Les brouillons locaux (CV, lettre) et les réglages ne sont pas restaurés tant que vous n'autorisez pas à nouveau le stockage local.",
          ar: "لا تُستعاد المسودات المحلية (السيرة، خطاب التقديم) ولا الإعدادات حتى تسمح بالتخزين المحلي من جديد.",
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
          de: "Fragen zu Cookies und verwandten Technologien können Sie über die Kontaktseite stellen.",
          en: "Questions about cookies and related technologies can be submitted via the Contact page.",
          fr: "Les questions sur les cookies et les technologies connexes peuvent être soumises via la page Contact.",
          ar: "يمكنك تقديم الأسئلة المتعلقة بالكوكيز والتقنيات المرتبطة عبر صفحة الاتصال.",
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
