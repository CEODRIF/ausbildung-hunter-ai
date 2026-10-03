import type { LegalDoc } from "./types";

/**
 * Contact page content.
 * CONTACT_EMAIL is the dedicated support address shown on /contact.
 */
export const CONTACT_EMAIL = "drif@berlin.com";

export const contactDoc: LegalDoc = {
  slug: "contact",
  title: {
    de: "Kontakt",
    en: "Contact",
    fr: "Contact",
    ar: "اتصل بنا",
  },
  intro: {
    de: "Sie haben eine Frage, ein Problem oder ein Anliegen? Nutzen Sie die folgenden Themen, um uns zu schreiben. Wir erreichen Sie über die unten genannte E-Mail-Adresse.",
    en: "You have a question, a problem or a concern? Use the topics below to write to us. You can reach us via the email address listed below.",
    fr: "Vous avez une question, un problème ou un sujet ? Utilisez les thèmes ci-dessous pour nous écrire. Vous pouvez nous joindre à l'adresse e-mail indiquée ci-dessous.",
    ar: "لديك سؤال أو مشكلة أو طلب؟ استخدم المواضيع التالية للكتابة إلينا. وتصل إلينا عبر عنوان البريد المذكور أدناه.",
  },
  contactEmail: CONTACT_EMAIL,
  sections: [
    {
      id: "topics",
      title: {
        de: "Themen",
        en: "Topics",
        fr: "Sujets",
        ar: "المواضيع",
      },
      p: [
        {
          de: "Wählen Sie in Ihrer Betreffzeile oder am Anfang Ihrer Nachricht ein Thema:",
          en: "Choose a topic in your subject line or at the start of your message:",
          fr: "Choisissez un sujet dans votre ligne d'objet ou au début de votre message :",
          ar: "اختر موضوعًا في سطر الموضوع أو في بداية رسالتك:",
        },
      ],
      li: [
        {
          de: "Allgemeiner Support: Fragen zu Funktionen, Nutzung oder Angeboten der Plattform.",
          en: "General Support: questions about features, usage or the platform's offerings.",
          fr: "Assistance générale : questions sur les fonctionnalités, l'utilisation ou l'offre de la plateforme.",
          ar: "الدعم العام: أسئلة حول الميزات أو الاستخدام أو ما توفره المنصّة.",
        },
        {
          de: "Technische Probleme: Fehler, Ausfälle oder ungewöhnliches Verhalten – beschreiben Sie bitte den Schritt, an dem das Problem auftritt.",
          en: "Technical Issues: errors, outages or unusual behavior – please describe the step where the problem occurs.",
          fr: "Problèmes techniques : erreurs, pannes ou comportement inhabituel – veuillez décrire l'étape à laquelle le problème survient.",
          ar: "مشكلات تقنية: أخطاء أو أعطال أو سلوك غير معتاد — يرجى وصف الخطوة التي تحدث عندها المشكلة.",
        },
        {
          de: "Konto-Probleme: Anmeldung, Bestätigungs-E-Mail, Zugangsverlust.",
          en: "Account Issues: sign-in, confirmation email, lost access.",
          fr: "Problèmes de compte : connexion, e-mail de confirmation, perte d'accès.",
          ar: "مشكلات الحساب: تسجيل الدخول، بريد التأكيد، فقدان الوصول.",
        },
        {
          de: "Löschungsanfragen: Bitte löschen Sie Ihr Konto idealerweise direkt über Einstellungen → Daten & Privacy; schreiben Sie uns, wenn das nicht möglich ist.",
          en: "Data Deletion Requests: please delete your account directly via Settings → Data & Privacy if possible; write to us when that is not possible.",
          fr: "Demandes de suppression : veuillez supprimer votre compte directement via Réglages → Données et confidentialité si possible ; écrivez-nous quand ce n'est pas possible.",
          ar: "طلبات حذف البيانات: يرجى حذف حسابك مباشرة عبر الإعدادات ← البيانات والخصوصية إذا أمكن؛ وراسلنا عندما لا يكون ذلك ممكنًا.",
        },
        {
          de: "Fragen zur Privatsphäre: Fragen zu gesammelten Daten, Ihrer Einwilligung oder Ihren Rechten.",
          en: "Privacy Questions: questions about collected data, your consent or your rights.",
          fr: "Questions de confidentialité : questions sur les données collectées, votre consentement ou vos droits.",
          ar: "أسئلة الخصوصية: أسئلة عن البيانات المجمعة أو موافقتك أو حقوقك.",
        },
        {
          de: "Rechtliche Fragen: Fragen zu den Nutzungsbedingungen oder den Policy-Seiten.",
          en: "Legal Questions: questions about the Terms of Service or the policy pages.",
          fr: "Questions juridiques : questions sur les conditions d'utilisation ou les pages de politique.",
          ar: "أسئلة قانونية: أسئلة حول شروط الخدمة أو صفحات السياسة.",
        },
        {
          de: "Missbrauchsberichte: Melden Sie Spam, Phishing, illegale Inhalte oder Missbrauch des E-Mail-Versands.",
          en: "Abuse Reports: report spam, phishing, illegal content or abuse of the email sending.",
          fr: "Signalements d'abus : signalez le spam, le phishing, les contenus illégaux ou l'abus de l'envoi d'e-mails.",
          ar: "بلاغات الإساءة: أبلغ عن الإرسال العشوائي أو التصيّد أو المحتويات غير المشروعة أو إساءة استخدام الإرسال.",
        },
      ],
    },
    {
      id: "how",
      title: {
        de: "So erreichen Sie uns",
        en: "How to Reach Us",
        fr: "Comment nous joindre",
        ar: "كيف تصل إلينا",
      },
      li: [
        {
          de: "Per E-Mail an die oben angegebene Adresse – das ist der zentrale Kontaktkanal der Plattform.",
          en: "By email to the address above – this is the platform's central contact channel.",
          fr: "Par e-mail à l'adresse ci-dessus – c'est le canal de contact central de la plateforme.",
          ar: "عبر البريد إلى العنوان المذكور أعلاه — وهو قناة الاتصال المركزية في المنصّة.",
        },
        {
          de: "Für viele Anliegen gibt es eine direkte Lösung in der Plattform selbst (z. B. Export oder Löschung unter Einstellungen → Daten & Privacy).",
          en: "For many concerns there is a direct solution in the platform itself (e.g. export or deletion under Settings → Data & Privacy).",
          fr: "Pour beaucoup de sujets, il existe une solution directe dans la plateforme elle-même (p. ex. export ou suppression sous Réglages → Données et confidentialité).",
          ar: "لكثير من الطلبات توجد حل مباشر داخل المنصّة نفسها (مثل التصدير أو الحذف في الإعدادات ← البيانات والخصوصية).",
        },
        {
          de: "Es gibt keinen Telefonsupport und keine Chat-Leitung; E-Mail ist der vorgesehen Weg.",
          en: "There is no phone support or chat line; email is the intended channel.",
          fr: "Il n'y a pas d'assistance téléphonique ni de ligne de discussion ; l'e-mail est le canal prévu.",
          ar: "لا يوجد دعم هاتفي ولا قناة محادثة؛ والبريد هو القناة المخصصة.",
        },
      ],
    },
    {
      id: "include",
      title: {
        de: "Was in Ihre Nachricht gehören sollte",
        en: "What to Include in Your Message",
        fr: "Ce que votre message doit contenir",
        ar: "ما يجب أن تتضمنه رسالتك",
      },
      li: [
        {
          de: "Ihr Thema (siehe oben) und eine kurze Beschreibung des Anliegens.",
          en: "Your topic (see above) and a short description of the concern.",
          fr: "Votre sujet (voir ci-dessus) et une brève description du sujet.",
          ar: "موضوعك (انظر أعلاه) ووصف موجز لطلبك.",
        },
        {
          de: "Die E-Mail-Adresse Ihres Kontos, damit wir Ihre Anfrage zuordnen können.",
          en: "Your account's email address, so we can match your request.",
          fr: "L'adresse e-mail de votre compte, afin que nous puissions associer votre demande.",
          ar: "بريد حسابك، حتى نتمكن من مطابقة طلبك.",
        },
        {
          de: "Falls technisch: Gerät/Browser, Schrittfolge und – falls angezeigt – die Fehlermeldung.",
          en: "If technical: device/browser, step sequence and – if shown – the error message.",
          fr: "Si technique : appareil/navigateur, séquence d'étapes et – le cas échéant – le message d'erreur.",
          ar: "إذا كانت تقنية: الجهاز/المتصفح، وتسلسل الخطوات، ورسالة الخطأ إن ظهرت.",
        },
        {
          de: "Bitte senden Sie keine sensiblen Daten (Passwörter, vollständige Dokumentinhalte), es sei denn, es ist für die Lösung zwingend erforderlich.",
          en: "Please do not send sensitive data (passwords, full document contents) unless strictly required for resolution.",
          fr: "Veuillez ne pas envoyer de données sensibles (mots de passe, contenus de documents complets) sauf si c'est strictement nécessaire à la résolution.",
          ar: "يرجى عدم إرسال بيانات حساسة (كلمات مرور، محتوى مستندات كامل) إلا إذا كان ضروريًا للحل.",
        },
      ],
    },
    {
      id: "note",
      title: {
        de: "Hinweise",
        en: "Notes",
        fr: "Remarques",
        ar: "ملاحظات",
      },
      p: [
        {
          de: "Wir antworten so zügig wie möglich; es gibt keine fest zugesagte Reaktionsfrist. Diese Seite stellt keine Rechtsberatung dar; für rechtliche Fragen wenden Sie sich bei Bedarf an eine dafür geeignete Stelle.",
          en: "We reply as promptly as possible; there is no committed response deadline. This page does not provide legal advice; for legal questions, consult a suitable authority when needed.",
          fr: "Nous répondons aussi rapidement que possible ; il n'y a pas de délai de réponse engagé. Cette page ne fournit pas de conseil juridique ; pour les questions juridiques, consultez une autorité compétente si besoin.",
          ar: "نرد بأقرب وقت ممكن؛ ولا توجد مدة زمنية مُلتزم بها للرد. وهذه الصفحة لا تقدم استشارة قانونية؛ وللسئلة القانونية استشر الجهة المختصة عند الحاجة.",
        },
      ],
    },
  ],
};
