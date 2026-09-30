import type { FaqItem } from "../types";

/** Category 15 — Notifications / Benachrichtigungen */
export const notificationsItems: FaqItem[] = [
  {
    id: "ntf-what",
    category: "notifications",
    question: {
      de: "Was sind Benachrichtigungen?",
      en: "What are notifications?",
      fr: "Que sont les notifications ?",
      ar: "ما هي الإشعارات؟",
    },
    answer: {
      de: "Benachrichtigungen sind Hinweise der Plattform, die Ihnen direkt in der App angezeigt werden – etwa Updates oder wichtige Mitteilungen.",
      en: "Notifications are platform messages shown to you directly in the app – e.g. updates or important notices.",
      fr: "Les notifications sont des messages de la plateforme affichés directement dans l'application – par exemple des mises à jour ou des annonces importantes.",
      ar: "الإشعارات رسائل من المنصّة تظهر لك مباشرة داخل التطبيق — مثل التحديثات أو التنبيهات المهمة.",
    },
    keywords: ["notifications", "what", "in-app"],
  },
  {
    id: "ntf-bell",
    category: "notifications",
    question: {
      de: "Wo finde ich das Symbol für Benachrichtigungen?",
      en: "Where do I find the notification icon?",
      fr: "Où trouver l'icône de notifications ?",
      ar: "أين أجد أيقونة الإشعارات؟",
    },
    answer: {
      de: "Das Glockensymbol befindet sich in der Kopfzeile, links neben Ihrem Profil.",
      en: "The bell icon is in the header, next to your profile.",
      fr: "L'icône cloche se trouve dans l'en-tête, à côté de votre profil.",
      ar: "توجد أيقونة الجرس في الشريط العلوي، بجوار ملفك الشخصي.",
    },
    keywords: ["bell", "icon", "where"],
  },
  {
    id: "ntf-badge",
    category: "notifications",
    question: {
      de: "Was bedeutet die Zahl auf der Glocke?",
      en: "What does the number on the bell mean?",
      fr: "Que signifie le nombre sur la cloche ?",
      ar: "ما معنى الرقم على الجرس؟",
    },
    answer: {
      de: "Die Zahl zeigt, wie viele Benachrichtigungen Sie noch nicht gelesen haben.",
      en: "The number shows how many notifications you have not yet read.",
      fr: "Le nombre indique combien de notifications vous n'avez pas encore lues.",
      ar: "يُظهر الرقم عدد الإشعارات التي لم تقرأها بعد.",
    },
    keywords: ["badge", "unread", "count"],
  },
  {
    id: "ntf-open",
    category: "notifications",
    question: {
      de: "Wie öffne ich eine Benachrichtigung?",
      en: "How do I open a notification?",
      fr: "Comment ouvrir une notification ?",
      ar: "كيف أفتح إشعارًا؟",
    },
    answer: {
      de: "Klicken Sie auf die Glocke und dann auf die gewünschte Benachrichtigung, um den vollständigen Inhalt zu sehen.",
      en: "Click the bell and then the notification you want, to see the full content.",
      fr: "Cliquez sur la cloche puis sur la notification voulue pour voir le contenu complet.",
      ar: "انقر على الجرس ثم على الإشعار المطلوب لرؤية المحتوى الكامل.",
    },
    keywords: ["open", "view", "content"],
  },
  {
    id: "ntf-read",
    category: "notifications",
    question: {
      de: "Wann wird eine Benachrichtigung als gelesen markiert?",
      en: "When is a notification marked as read?",
      fr: "Quand une notification est-elle marquée comme lue ?",
      ar: "متى يُعلَّم الإشعار كمقروء؟",
    },
    answer: {
      de: "Eine Benachrichtigung wird als gelesen markiert, wenn Sie sie öffnen. Danach zählt sie nicht mehr in der ungelesenen Zahl.",
      en: "A notification is marked as read when you open it. Afterwards it no longer counts in the unread number.",
      fr: "Une notification est marquée comme lue lorsque vous l'ouvrez. Elle ne compte plus ensuite dans le nombre non lu.",
      ar: "يُعلَّم الإشعار كمقروء عندما تفتحه. بعدها لا يُحتسب بعد في عدد غير المقروء.",
    },
    keywords: ["read", "unread", "mark"],
  },
  {
    id: "ntf-after-logout",
    category: "notifications",
    question: {
      de: "Bleiben Benachrichtigungen nach Logout und Login erhalten?",
      en: "Do notifications remain after logout and login?",
      fr: "Les notifications restent-elles après déconnexion et connexion ?",
      ar: "هل تبقى الإشعارات بعد تسجيل الخروج والدخول؟",
    },
    answer: {
      de: "Ja. Benachrichtigungen und deren gelesener Zustand sind an Ihr Konto gebunden und bleiben auch nach erneutem Anmelden erhalten.",
      en: "Yes. Notifications and their read state are bound to your account and remain after signing back in.",
      fr: "Oui. Les notifications et leur état de lecture sont liées à votre compte et restent après la reconnexion.",
      ar: "نعم. ترتبط الإشعارات وحالتها كمقروءة بحسابك وتبقى بعد تسجيل الدخول مجددًا.",
    },
    keywords: ["logout", "persist", "account"],
  },
  {
    id: "ntf-inapp",
    category: "notifications",
    question: {
      de: "Sind die Benachrichtigungen per E-Mail oder in der Plattform?",
      en: "Are the notifications by email or in the platform?",
      fr: "Les notifications sont-elles par e-mail ou dans la plateforme ?",
      ar: "هل الإشعارات عبر البريد أم داخل المنصّة؟",
    },
    answer: {
      de: "Die Benachrichtigungen erscheinen in der Plattform (in-app). Sie werden nicht per E-Mail, SMS oder Push-Nachricht zugestellt.",
      en: "Notifications appear in the platform (in-app). They are not delivered by email, SMS or push.",
      fr: "Les notifications apparaissent dans la plateforme (dans l'application). Elles ne sont pas envoyées par e-mail, SMS ou notification push.",
      ar: "تظهر الإشعارات داخل المنصّة. ولا تُرسل عبر البريد أو الرسائل النصية أو إشعارات الدفع.",
    },
    keywords: ["in-app", "email", "no push"],
  },
  {
    id: "ntf-user-send",
    category: "notifications",
    question: {
      de: "Kann ein Nutzer eine Benachrichtigung senden?",
      en: "Can a user send a notification?",
      fr: "Un utilisateur peut-il envoyer une notification ?",
      ar: "هل يمكن للمستخدم إرسال إشعار؟",
    },
    answer: {
      de: "Nein. Regelmäßige Nutzer empfangen Benachrichtigungen, können aber selbst keine Plattform-Benachrichtigungen versenden.",
      en: "No. Regular users receive notifications but cannot send platform notifications themselves.",
      fr: "Non. Les utilisateurs ordinaires reçoivent des notifications mais ne peuvent pas eux-mêmes envoyer de notifications de plateforme.",
      ar: "لا. يستقبل المستخدمون العاديون الإشعارات، لكنهم لا يمكنهم إرسال إشعارات المنصّة بأنفسهم.",
    },
    keywords: ["user", "send", "no"],
  },
  {
    id: "ntf-owner-updates",
    category: "notifications",
    question: {
      de: "Wer kann Plattform-Updates senden?",
      en: "Who can send platform updates?",
      fr: "Qui peut envoyer des mises à jour de la plateforme ?",
      ar: "من يمكنه إرسال تحديثات المنصّة؟",
    },
    answer: {
      de: "Plattform-Updates werden vom Betreiber der Plattform versendet und erscheinen für die Nutzer in den Benachrichtigungen.",
      en: "Platform updates are sent by the platform owner and appear for users in the notifications.",
      fr: "Les mises à jour de la plateforme sont envoyées par le propriétaire de la plateforme et apparaissent pour les utilisateurs dans les notifications.",
      ar: "تُرسل تحديثات المنصّة من قِبَل مالك المنصّة، وتظهر للمستخدمين ضمن الإشعارات.",
    },
    keywords: ["owner", "updates", "platform"],
  },
  {
    id: "ntf-targeted",
    category: "notifications",
    question: {
      de: "Kann der Betreiber eine Benachrichtigung an einen bestimmten Nutzer senden?",
      en: "Can the owner send a notification to a specific user?",
      fr: "Le propriétaire peut-il envoyer une notification à un utilisateur précis ?",
      ar: "هل يمكن للمالك إرسال إشعار لمستخدم معين؟",
    },
    answer: {
      de: "Ja. Der Betreiber kann eine Benachrichtigung an alle Nutzer oder an einen bestimmten Nutzer richten.",
      en: "Yes. The owner can address a notification to all users or to a specific user.",
      fr: "Oui. Le propriétaire peut adresser une notification à tous les utilisateurs ou à un utilisateur précis.",
      ar: "نعم. يمكن للمالك توجيه الإشعار إلى جميع المستخدمين أو إلى مستخدم معين.",
    },
    keywords: ["targeted", "specific", "owner"],
  },
  {
    id: "ntf-all-users",
    category: "notifications",
    question: {
      de: "Kann eine Benachrichtigung an alle Nutzer gesendet werden?",
      en: "Can a notification be sent to all users?",
      fr: "Une notification peut-elle être envoyée à tous les utilisateurs ?",
      ar: "هل يمكن إرسال إشعار إلى جميع المستخدمين؟",
    },
    answer: {
      de: "Ja. Der Betreiber kann Benachrichtigungen an alle Nutzer senden – z. B. für Plattform-Updates oder wichtige Mitteilungen.",
      en: "Yes. The owner can send notifications to all users – e.g. for platform updates or important notices.",
      fr: "Oui. Le propriétaire peut envoyer des notifications à tous les utilisateurs – par exemple pour des mises à jour ou des annonces importantes.",
      ar: "نعم. يمكن للمالك إرسال إشعارات إلى جميع المستخدمين — مثل التحديثات أو التنبيهات المهمة.",
    },
    keywords: ["all users", "broadcast", "owner"],
  },
];
