import type { FaqItem } from "../types";

/** Category 17 — Billing & Limits / Abrechnung & Limits */
export const billingItems: FaqItem[] = [
  {
    id: "bl-free",
    category: "billing",
    question: {
      de: "Ist die Plattform kostenlos?",
      en: "Is the platform free?",
      fr: "La plateforme est-elle gratuite ?",
      ar: "هل المنصّة مجانية؟",
    },
    answer: {
      de: "Ja, es gibt einen kostenlosen Plan, mit dem Sie die Kernfunktionen nutzen können. Darüber hinaus stehen Pläne zur Verfügung, die vom Plattform-Betreiber zugewiesen werden.",
      en: "Yes, there is a free plan with which you can use the core features. Beyond that, plans are available that are assigned by the platform owner.",
      fr: "Oui, il existe un plan gratuit avec lequel vous pouvez utiliser les fonctions de base. Au-delà, des plans sont disponibles, attribués par le propriétaire de la plateforme.",
      ar: "نعم، يوجد خطة مجانية تتيح لك استخدام الوظائف الأساسية. وإلى جانبها توجد خطط يسندها مالك المنصّة.",
    },
    keywords: ["free", "plan", "cost"],
  },
  {
    id: "bl-limits",
    category: "billing",
    question: {
      de: "Gibt es Grenzen für die Nutzung?",
      en: "Are there limits on usage?",
      fr: "Y a-t-il des limites d'utilisation ?",
      ar: "هل توجد حدود على الاستخدام؟",
    },
    answer: {
      de: "Ja. Es gelten tägliche Grenzen – für KI-Anfragen und für den E-Mail-Versand. Auf dem kostenlosen Plan sind es beispielsweise 100 KI-Anfragen und 50 E-Mails pro Tag. Den aktuellen Stand sehen Sie unter Verbrauch.",
      en: "Yes. Daily limits apply – for AI requests and for email sending. On the free plan that is, for example, 100 AI requests and 50 emails per day. You see the current state under Usage.",
      fr: "Oui. Des limites quotidiennes s'appliquent – pour les requêtes IA et pour l'envoi d'e-mails. Sur le plan gratuit, par exemple 100 requêtes IA et 50 e-mails par jour. L'état actuel se voit sous Utilisation.",
      ar: "نعم. تطبق حدود يومية — على طلبات الذكاء الاصطناعي وإرسال البريد. ففي الخطة المجانية على سبيل المثال 100 طلب ذكاء اصطناعي و50 رسالة بريد يوميًا. وترى الوضع الحالي في صفحة الاستخدام.",
    },
    keywords: ["limits", "daily", "usage"],
  },
  {
    id: "bl-reached",
    category: "billing",
    question: {
      de: "Was passiert, wenn ich das Limit erreiche?",
      en: "What happens when I reach the limit?",
      fr: "Que se passe-t-il quand j'atteins la limite ?",
      ar: "ماذا يحدث عندما أصل إلى الحد؟",
    },
    answer: {
      de: "Dann erhalten Sie eine kurze Mitteilung, dass das tägliche Limit erreicht ist. Sie können es am nächsten Tag wieder nutzen – die Grenzen stellen sich neu.",
      en: "Then you get a short notice that the daily limit is reached. You can use it again the next day – the limits reset.",
      fr: "Alors vous recevez une brève notification que la limite quotidienne est atteinte. Vous pouvez l'utiliser à nouveau le lendemain – les limites se réinitialisent.",
      ar: "في هذه الحالة تصلك رسالة موجزة أن الحد اليومي قد اكتمل. ويمكنك استخدامه من جديد في اليوم التالي — فتمتدّ الحدود من جديد.",
    },
    keywords: ["limit", "reached", "notice"],
  },
  {
    id: "bl-differ",
    category: "billing",
    question: {
      de: "Unterscheiden sich die Grenzen je nach Konto?",
      en: "Do the limits differ per account?",
      fr: "Les limites diffèrent-elles selon le compte ?",
      ar: "هل تختلف الحدود حسب الحساب؟",
    },
    answer: {
      de: "Ja. Die Grenzen hängen von Ihrem Plan ab. Der kostenlose Plan hat feste Grenzen; höhere Pläne können größere Grenzen haben, die vom Plattform-Betreiber verwaltet werden.",
      en: "Yes. The limits depend on your plan. The free plan has fixed limits; higher plans can have larger limits managed by the platform owner.",
      fr: "Oui. Les limites dépendent de votre plan. Le plan gratuit a des limites fixes ; les plans supérieurs peuvent avoir des limites plus grandes, gérées par le propriétaire de la plateforme.",
      ar: "نعم. تعتمد الحدود على خطتك. فالخطة المجانية لها حدود ثابتة، وقد تكون للخطط الأعلى حدود أكبر يديرها مالك المنصّة.",
    },
    keywords: ["differ", "plan", "account"],
  },
  {
    id: "bl-reset",
    category: "billing",
    question: {
      de: "Wird das Limit erneuert?",
      en: "Is the limit renewed?",
      fr: "La limite est-elle renouvelée ?",
      ar: "هل تُجدَّد الحدود؟",
    },
    answer: {
      de: "Ja. Die täglichen Grenzen stellen sich jeden Tag neu. Sie sehen Ihren verbleibenden Rest immer unter Verbrauch.",
      en: "Yes. The daily limits reset every day. You can always see your remaining amount under Usage.",
      fr: "Oui. Les limites quotidiennes se réinitialisent chaque jour. Vous voyez toujours votre solde restant sous Utilisation.",
      ar: "نعم. تمتدّ الحدود اليومية كل يوم. وترى دائمًا ما تبقى لك في صفحة الاستخدام.",
    },
    keywords: ["reset", "daily", "renew"],
  },
  {
    id: "bl-exceed",
    category: "billing",
    question: {
      de: "Was passiert, wenn ich das Limit überschreite?",
      en: "What happens if I exceed the limit?",
      fr: "Que se passe-t-il si je dépasse la limite ?",
      ar: "ماذا يحدث إذا تجاوزت الحد؟",
    },
    answer: {
      de: "Die Plattform lässt über das Limit hinaus keine weiteren Vorgänge in diesem Bereich zu und zeigt eine kurze Meldung an. Es fallen keine versteckten Kosten an.",
      en: "The platform does not allow further operations in that area beyond the limit and shows a short message. No hidden costs are incurred.",
      fr: "La plateforme n'autorise pas d'autres opérations au-delà de la limite dans ce domaine et affiche un court message. Aucun coût caché n'est engendré.",
      ar: "لا تسمح المنصّة بإجراءات إضافية في هذا المجال بعد تجاوز الحد، وتعرض رسالة موجزة. ولا تنشأ أي تكاليف خفية.",
    },
    keywords: ["exceed", "over", "limit"],
  },
];
