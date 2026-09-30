import type { FaqItem } from "../types";

/** Category 13 — Applications / Bewerbungen */
export const applicationsItems: FaqItem[] = [
  {
    id: "app-how",
    category: "applications",
    question: {
      de: "Wie sende ich eine Bewerbung?",
      en: "How do I send an application?",
      fr: "Comment envoyer une candidature ?",
      ar: "كيف أرسل طلبًا؟",
    },
    answer: {
      de: "Erstellen Sie eine neue Bewerbung, geben Sie Empfänger, Betreff und Text ein (ggf. mit Anhängen) und senden Sie sie. Die Plattform erstellt daraus einen Versand und leitet Sie zur Übersicht weiter.",
      en: "Create a new application, enter recipient, subject and text (with attachments if needed) and send it. The platform turns this into a send and takes you to the overview.",
      fr: "Créez une nouvelle candidature, saisissez destinataire, objet et texte (avec pièces jointes le cas échéant) et envoyez-la. La plateforme en crée un envoi et vous mène à la vue d'ensemble.",
      ar: "أنشئ طلبًا جديدًا وأدخل المستلم والموضوع والنص (ومرفقات إذا لزم) ثم أرسله. تُحوّل المنصّة ذلك إلى عملية إرسال وتوجهك إلى الصفحة الرئيسية.",
    },
    keywords: ["send", "application", "how"],
  },
  {
    id: "app-need",
    category: "applications",
    question: {
      de: "Was brauche ich zum Senden?",
      en: "What do I need to send?",
      fr: "De quoi ai-je besoin pour envoyer ?",
      ar: "ما الذي أحتاجه للإرسال؟",
    },
    answer: {
      de: "Ein verknüpftes E-Mail-Konto (Gmail oder Outlook), eine gültige Empfänger-E-Mail sowie Betreff und Text. Anhänge wie Lebenslauf und Anschreiben sind möglich.",
      en: "A connected email account (Gmail or Outlook), a valid recipient email, and a subject and text. Attachments like CV and cover letter are possible.",
      fr: "Un compte e-mail connecté (Gmail ou Outlook), un e-mail de destinataire valide, ainsi qu'un objet et un texte. Les pièces jointes comme le CV et la lettre sont possibles.",
      ar: "حساب بريد مربوط (Gmail أو Outlook)، وبريد مستلم صحيح، وموضوع ونص. المرفقات مثل السيرة الذاتية وخطاب التقديم ممكنة.",
    },
    keywords: ["need", "requirement", "email"],
  },
  {
    id: "app-attachments",
    category: "applications",
    question: {
      de: "Wie füge ich Dateien hinzu?",
      en: "How do I add files?",
      fr: "Comment ajouter des fichiers ?",
      ar: "كيف أضيف ملفات؟",
    },
    answer: {
      de: "Im Composer der Bewerbung können Sie Anhänge hinzufügen. Unterstützt werden PDF, DOC, DOCX, PNG und JPG; pro Anhang gelten 10 MB.",
      en: "In the application composer you can add attachments. Supported are PDF, DOC, DOCX, PNG and JPG; 10 MB per attachment apply.",
      fr: "Dans le composeur de candidature, vous pouvez ajouter des pièces jointes. Sont pris en charge PDF, DOC, DOCX, PNG et JPG ; 10 Mo par pièce jointe s'appliquent.",
      ar: "في مُنشئ الطلب يمكنك إضافة مرفقات. الأنواع المدعومة: PDF وDOC وDOCX وPNG وJPG؛ والحد 10 ميغابايت لكل مرفق.",
    },
    keywords: ["attachments", "files", "add"],
  },
  {
    id: "app-cv-cl",
    category: "applications",
    question: {
      de: "Kann ich Lebenslauf und Anschreiben zusammen senden?",
      en: "Can I send CV and cover letter together?",
      fr: "Puis-je envoyer le CV et la lettre ensemble ?",
      ar: "هل يمكنني إرسال السيرة وخطاب التقديم معًا؟",
    },
    answer: {
      de: "Ja. Sie können beide Dokumente als Anhänge an Ihre Bewerbung hinzufügen und sie in einem Vorgang senden.",
      en: "Yes. You can add both documents as attachments to your application and send them in one go.",
      fr: "Oui. Vous pouvez ajouter les deux documents en pièces jointes à votre candidature et les envoyer d'un seul coup.",
      ar: "نعم. يمكنك إضافة المستنديّن كمرفقين لطلبك وإرسالهما معًا في عملية واحدة.",
    },
    keywords: ["cv", "cover letter", "together"],
  },
  {
    id: "app-sent-proof",
    category: "applications",
    question: {
      de: "Wie erkenne ich, dass die Nachricht gesendet wurde?",
      en: "How do I know the message was sent?",
      fr: "Comment savoir que le message a été envoyé ?",
      ar: "كيف أعرف أن الرسالة أُرسلت؟",
    },
    answer: {
      de: "Nach dem Versand sehen Sie den Status in der Kampagne-Übersicht. Dort wird pro Empfänger angezeigt, ob die E-Mail gesendet wurde.",
      en: "After sending, you see the status in the campaign overview. There, it is shown per recipient whether the email was sent.",
      fr: "Après l'envoi, vous voyez le statut dans la vue de la campagne. On y indique, par destinataire, si l'e-mail a été envoyé.",
      ar: "بعد الإرسال ترى الحالة في صفحة الحملة. وتُعرض حالة كل مستلم على حدة، سواء أُرسلت الرسالة أم لا.",
    },
    keywords: ["sent", "status", "proof"],
  },
  {
    id: "app-fail",
    category: "applications",
    question: {
      de: "Was passiert, wenn das Senden fehlschlägt?",
      en: "What happens if sending fails?",
      fr: "Que se passe-t-il si l'envoi échoue ?",
      ar: "ماذا يحدث إذا فشل الإرسال؟",
    },
    answer: {
      de: "Dann wird der Fehler in der Übersicht angezeigt. Bei vorübergehenden Anbieterfehlern wird der Versand automatisch wiederholt; ansonsten können Sie es erneut versuchen.",
      en: "Then the error is shown in the overview. For temporary provider errors, the send is retried automatically; otherwise you can try again.",
      fr: "Alors l'erreur est affichée dans la vue. En cas d'erreur temporaire du fournisseur, l'envoi est retenté automatiquement ; sinon, vous pouvez réessayer.",
      ar: "في هذه الحالة يظهر الخطأ في الصفحة. وفي أخطاء المزود العارضة يُعاد الإرسال تلقائيًا؛ وإلا يمكنك إعادة المحاولة.",
    },
    keywords: ["fail", "error", "retry"],
  },
  {
    id: "app-resend",
    category: "applications",
    question: {
      de: "Kann ich eine Bewerbung erneut senden?",
      en: "Can I resend an application?",
      fr: "Puis-je renvoyer une candidature ?",
      ar: "هل يمكنني إعادة إرسال الطلب؟",
    },
    answer: {
      de: "Ja. Für fehlschlagende oder vorübergehend fehlgeschlagene Empfänger kann der Versand wiederholt werden.",
      en: "Yes. For failed or temporarily failed recipients, the send can be retried.",
      fr: "Oui. Pour les destinataires en échec ou en échec temporaire, l'envoi peut être retenté.",
      ar: "نعم. يمكن إعادة الإرسال للمستلمين الذين فشلوا أو فشلت حالتهم مؤقتًا.",
    },
    keywords: ["resend", "retry", "failed"],
  },
  {
    id: "app-gmail-outlook",
    category: "applications",
    question: {
      de: "Kann ich Gmail oder Outlook verwenden?",
      en: "Can I use Gmail or Outlook?",
      fr: "Puis-je utiliser Gmail ou Outlook ?",
      ar: "هل يمكنني استخدام Gmail أو Outlook؟",
    },
    answer: {
      de: "Ja. Sie verknüpfen Ihr Gmail- oder Outlook-Konto unter Einstellungen, und die Bewerbungen werden über dieses Konto versendet.",
      en: "Yes. You connect your Gmail or Outlook account under Settings, and the applications are sent through that account.",
      fr: "Oui. Vous reliez votre compte Gmail ou Outlook dans Réglages, et les candidatures sont envoyées via ce compte.",
      ar: "نعم. تربط حساب Gmail أو Outlook من الإعدادات، وتُرسل الطلبات عبر ذلك الحساب.",
    },
    keywords: ["gmail", "outlook", "provider"],
  },
  {
    id: "app-saved",
    category: "applications",
    question: {
      de: "Werden meine Bewerbungen gespeichert?",
      en: "Are my applications saved?",
      fr: "Mes candidatures sont-elles enregistrées ?",
      ar: "هل تُحفظ طلباتي؟",
    },
    answer: {
      de: "Ja. Versendete Bewerbungen und deren Verlauf werden in Ihrem Konto gespeichert und stehen in Ihrer Liste bereit.",
      en: "Yes. Sent applications and their history are stored in your account and are available in your list.",
      fr: "Oui. Les candidatures envoyées et leur historique sont stockés dans votre compte et disponibles dans votre liste.",
      ar: "نعم. تُحفظ الطلبات المرسلة وسجلها في حسابك وتكون متاحة في قائمتك.",
    },
    keywords: ["saved", "history", "list"],
  },
  {
    id: "app-where",
    category: "applications",
    question: {
      de: "Wo finde ich meine bisherigen Bewerbungen?",
      en: "Where do I find my previous applications?",
      fr: "Où trouver mes candidatures précédentes ?",
      ar: "أين أجد طلباتي السابقة؟",
    },
    answer: {
      de: "Unter Bewerbungen in der Seitenleiste sehen Sie Ihre bisherigen Bewerbungen und können deren Versand verfolgen.",
      en: "Under Applications in the sidebar you see your previous applications and can track their delivery.",
      fr: "Sous Candidatures dans la barre latérale, vous voyez vos candidatures précédentes et pouvez suivre leur envoi.",
      ar: "ضمن «الطلبات» في الشريط الجانبي ترى طلباتك السابقة وتتبع حالة إرسالها.",
    },
    keywords: ["where", "list", "history"],
  },
  {
    id: "app-prefill",
    category: "applications",
    question: {
      de: "Kann ich eine Bewerbung aus einer Stellenanzeige vorausfüllen?",
      en: "Can I pre-fill an application from a job listing?",
      fr: "Puis-je préremplir une candidature depuis une offre ?",
      ar: "هل يمكنني ملء الطلب مسبقًا من إعلان وظيفة؟",
    },
    answer: {
      de: "Ja. Sie können aus einer Stellenanzeige eine Bewerbung vorbereiten. Dabei werden nur die tatsächlichen Angaben des Angebots übernommen – nichts wird erfunden.",
      en: "Yes. You can prepare an application from a job listing. Only the actual details of the listing are taken over – nothing is invented.",
      fr: "Oui. Vous pouvez préparer une candidature depuis une offre. Seules les informations réelles de l'offre sont reprises – rien n'est inventé.",
      ar: "نعم. يمكنك تجهيز طلب من إعلان وظيفة. تُلخَّص فقط البيانات الفعلية للإعلان — ولا يُخترع شيء.",
    },
    keywords: ["prefill", "listing", "application"],
  },
];
