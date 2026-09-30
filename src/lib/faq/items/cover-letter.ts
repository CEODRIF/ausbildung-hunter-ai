import type { FaqItem } from "../types";

/** Category 11 — Cover Letter / Anschreiben */
export const coverLetterItems: FaqItem[] = [
  {
    id: "cl-what",
    category: "cover-letter",
    question: {
      de: "Was ist ein Anschreiben?",
      en: "What is a cover letter?",
      fr: "Qu'est-ce qu'une lettre de motivation ?",
      ar: "ما هو خطاب التقديم؟",
    },
    answer: {
      de: "Das Anschreiben ist ein kurzer Brief zu Ihrer Bewerbung, in dem Sie erklären, warum Sie für die Stelle oder Ausbildung passen – zusätzlich zu Lebenslauf und Unterlagen.",
      en: "A cover letter is a short letter with your application explaining why you suit the job or apprenticeship – in addition to your CV and documents.",
      fr: "La lettre de motivation est une courte lettre avec votre candidature expliquant pourquoi vous convienez au poste ou à la formation – en plus du CV et des documents.",
      ar: "خطاب التقديم هو رسالة قصيرة مرفقة بطلبك تشرح فيها لماذا يناسبك المنصب أو التدريب — إضافة إلى سيرتك والمستندات.",
    },
    keywords: ["cover letter", "anschreiben", "what"],
  },
  {
    id: "cl-vs-cv",
    category: "cover-letter",
    question: {
      de: "Was ist der Unterschied zwischen CV und Anschreiben?",
      en: "What is the difference between CV and cover letter?",
      fr: "Quelle est la différence entre CV et lettre de motivation ?",
      ar: "ما الفرق بين السيرة الذاتية وخطاب التقديم؟",
    },
    answer: {
      de: "Der Lebenslauf listet Ihre Fakten (Ausbildung, Erfahrung, Skills) auf. Das Anschreiben erzählt, warum Sie diese Person sind und warum Sie zu dieser Stelle passen.",
      en: "The CV lists your facts (education, experience, skills). The cover letter tells why you are this person and why you fit this position.",
      fr: "Le CV liste vos faits (formation, expérience, compétences). La lettre raconte pourquoi vous êtes cette personne et pourquoi vous correspondez à ce poste.",
      ar: "تُدرج السيرة الذاتية حقائقك (التعليم والخبرة والمهارات). أما خطاب التقديم فيروي لماذا أنت هذه الشخصية ولماذا تناسب هذا المنصب.",
    },
    keywords: ["difference", "cv", "cover letter"],
  },
  {
    id: "cl-how",
    category: "cover-letter",
    question: {
      de: "Wie erstelle ich ein Anschreiben?",
      en: "How do I create a cover letter?",
      fr: "Comment créer une lettre de motivation ?",
      ar: "كيف أنشئ خطاب تقديم؟",
    },
    answer: {
      de: "Öffnen Sie Anschreiben. Sie können den Text selbst schreiben oder die KI mit Angaben wie Stelle, Unternehmen und Tonfall erstellen lassen.",
      en: "Open Cover Letter. You can write the text yourself or let the AI create it with details such as position, company and tone.",
      fr: "Ouvrez Lettre de motivation. Vous pouvez écrire le texte vous-même ou laisser l'IA le créer avec des détails comme le poste, l'entreprise et le ton.",
      ar: "افتح خطاب التقديم. يمكنك كتابة النص بنفسك أو توكيل ذلك للذكاء الاصطناعي مع تفاصيل مثل المنصب والشركة والأسلوب.",
    },
    keywords: ["create", "how", "ai"],
  },
  {
    id: "cl-edit",
    category: "cover-letter",
    question: {
      de: "Wie bearbeite ich den Text?",
      en: "How do I edit the text?",
      fr: "Comment modifier le texte ?",
      ar: "كيف أعدّل النص؟",
    },
    answer: {
      de: "Das Anschreiben ist in klare Bereiche gegliedert (Absender, Datum, Empfänger, Betreff, Anrede, Haupttext, Grußformel, Unterschrift). Sie können jeden Bereich direkt bearbeiten.",
      en: "The cover letter is split into clear sections (sender, date, recipient, subject, salutation, main text, closing, signature). You can edit each section directly.",
      fr: "La lettre est divisée en sections claires (expéditeur, date, destinataire, objet, salutation, corps, formule de politesse, signature). Vous pouvez modifier chaque section directement.",
      ar: "يُقسَّم خطاب التقديم إلى أقسام واضحة (المرسل، التاريخ، المستلم، الموضوع، التحية، النص الرئيسي، الخاتمة، التوقيع). يمكنك تعديل كل قسم مباشرةً.",
    },
    keywords: ["edit", "sections", "text"],
  },
  {
    id: "cl-customize",
    category: "cover-letter",
    question: {
      de: "Wie passe ich es für ein Unternehmen an?",
      en: "How do I tailor it for a company?",
      fr: "Comment l'adapter à une entreprise ?",
      ar: "كيف أخصصه لشركة معينة؟",
    },
    answer: {
      de: "Geben Sie die konkrete Stelle und das Unternehmen an und formulieren Sie, warum Sie genau dort passen. So wird das Anschreiben persönlich statt generisch.",
      en: "Provide the specific position and company and phrase why you fit exactly there. This makes the letter personal instead of generic.",
      fr: "Indiquez le poste précis et l'entreprise et formulez pourquoi vous correspondez exactement là. Cela rend la lettre personnelle plutôt que générique.",
      ar: "أضف المنصب المحدد والشركة وصرّح لماذا تناسب تلك المكانة تحديدًا. بهذا يصبح الخطاب شخصيًا بدلًا من العام.",
    },
    keywords: ["customize", "company", "tailor"],
  },
  {
    id: "cl-save",
    category: "cover-letter",
    question: {
      de: "Wie speichere ich es?",
      en: "How do I save it?",
      fr: "Comment l'enregistrer ?",
      ar: "كيف أحفظه؟",
    },
    answer: {
      de: "Ihr Text wird automatisch gespeichert (lokal in Ihrem Browser, pro Nutzer), sobald Sie aufhören zu tippen.",
      en: "Your text is saved automatically (locally in your browser, per user) as soon as you stop typing.",
      fr: "Votre texte est enregistré automatiquement (localement dans votre navigateur, par utilisateur) dès que vous cessez de taper.",
      ar: "يُحفظ نصك تلقائيًا (محليًا في متصفحك، لكل مستخدم) بمجرد توقفك عن الكتابة.",
    },
    keywords: ["save", "autosave", "local"],
  },
  {
    id: "cl-download",
    category: "cover-letter",
    question: {
      de: "Wie lade ich es herunter?",
      en: "How do I download it?",
      fr: "Comment le télécharger ?",
      ar: "كيف أنزله؟",
    },
    answer: {
      de: "Klicken Sie auf den PDF-Download. Es öffnet sich die Druck-/Speichern-Ansicht, aus der Sie das Anschreiben als PDF speichern.",
      en: "Click the PDF download. The print/save view opens, from which you save the cover letter as PDF.",
      fr: "Cliquez sur le téléchargement PDF. La vue d'impression/sauvegarde s'ouvre, depuis laquelle vous enregistrez la lettre en PDF.",
      ar: "انقر على تنزيل PDF. ستُفتح واجهة الطباعة/الحفظ التي تحفظ منها خطاب التقديم كملف PDF.",
    },
    keywords: ["download", "pdf", "print"],
  },
  {
    id: "cl-print",
    category: "cover-letter",
    question: {
      de: "Wie drucke ich es?",
      en: "How do I print it?",
      fr: "Comment l'imprimer ?",
      ar: "كيف أطبعه؟",
    },
    answer: {
      de: "Über dieselbe Druck-/Speichern-Ansicht, die beim PDF-Download geöffnet wird, können Sie das Anschreiben auch direkt drucken.",
      en: "Via the same print/save view that opens on PDF download, you can also print the cover letter directly.",
      fr: "Via la même vue d'impression/sauvegarde qui s'ouvre au téléchargement PDF, vous pouvez aussi imprimer la lettre directement.",
      ar: "عبر نفس واجهة الطباعة/الحفظ التي تفتح عند تنزيل PDF، يمكنك أيضًا طباعة خطاب التقديم مباشرةً.",
    },
    keywords: ["print", "download", "pdf"],
  },
  {
    id: "cl-data",
    category: "cover-letter",
    question: {
      de: "Welche Angaben kann ich verwenden?",
      en: "Which details can I use?",
      fr: "Quelles informations puis-je utiliser ?",
      ar: "ما البيانات التي يمكنني استخدامها؟",
    },
    answer: {
      de: "Sie geben an, was Sie verwenden: Absender, Empfänger, Betreff, Anrede, Ihren Text sowie eine Signatur als Text oder Bild. Alles bleibt bearbeitbar.",
      en: "You provide what you use: sender, recipient, subject, salutation, your text and a signature as text or image. Everything stays editable.",
      fr: "Vous fournissez ce que vous utilisez : expéditeur, destinataire, objet, salutation, votre texte et une signature en texte ou en image. Tout reste modifiable.",
      ar: "تزوّد بما تستخدمه: المرسل والمستلم والموضوع والتحية ونصك وتوقيعًا كنص أو صورة. وكله قابل للتعديل.",
    },
    keywords: ["data", "fields", "signature"],
  },
  {
    id: "cl-ai-invent",
    category: "cover-letter",
    question: {
      de: "Erfindet die KI Informationen?",
      en: "Does the AI invent information?",
      fr: "L'IA invente-t-elle des informations ?",
      ar: "هل يخرع الذكاء الاصطناعي معلومات؟",
    },
    answer: {
      de: "Nein. Die KI stützt sich auf Ihre echten Angaben aus Profil und Lebenslauf sowie Ihre Eingaben. Fehlende Informationen werden nicht erfunden – der Text bleibt vollständig von Ihnen editierbar.",
      en: "No. The AI relies on your real data from your profile and CV plus your input. Missing information is not invented – the text remains fully editable by you.",
      fr: "Non. L'IA s'appuie sur vos vraies données de profil et de CV ainsi que sur vos saisies. Les informations manquantes ne sont pas inventées – le texte reste entièrement modifiable par vous.",
      ar: "لا. يعتمد الذكاء الاصطناعي على بياناتك الحقيقية من ملفك وسيرتك بالإضافة إلى مدخلاتك. لا تُخترع المعلومات المفقودة — ويبقى النص قابلاً للتعديل بالكامل من قبلك.",
    },
    keywords: ["ai", "invent", "no"],
  },
  {
    id: "cl-ausbildung",
    category: "cover-letter",
    question: {
      de: "Wie verwende ich es mit einer Ausbildung?",
      en: "How do I use it with an apprenticeship?",
      fr: "Comment l'utiliser avec une alternance ?",
      ar: "كيف أستخدمه مع تدريب مهني؟",
    },
    answer: {
      de: "Wählen Sie die Ausbildung als Stelle, geben Sie das Unternehmen an und beschreiben Sie, warum Sie diese Ausbildung in diesem Betrieb machen möchten. So passt das Anschreiben zum Ziel.",
      en: "Choose the apprenticeship as the position, provide the company and describe why you want this apprenticeship at this employer. This makes the letter fit the goal.",
      fr: "Choisissez l'alternance comme poste, indiquez l'entreprise et décrivez pourquoi vous voulez cette formation chez cet employeur. Cela adapte la lettre à l'objectif.",
      ar: "اختر التدريب المهني كمنصب وحدد الشركة وشرّح لماذا تريد هذا التدريب في تلك الشركة. بهذا يناسب خطابك هدفك.",
    },
    keywords: ["ausbildung", "apprenticeship", "use"],
  },
];
