import type { FaqCategory } from "./types";

/**
 * The 18 FAQ categories in display order. Labels are localized in all four
 * languages; icons come from the canonical app icon set.
 */
export const CATEGORIES: FaqCategory[] = [
  {
    id: "general",
    icon: "help",
    label: {
      de: "Allgemein",
      en: "General",
      fr: "Général",
      ar: "عام",
    },
  },
  {
    id: "account",
    icon: "user",
    label: {
      de: "Konto & Profil",
      en: "Account & Profile",
      fr: "Compte & profil",
      ar: "الحساب والملف الشخصي",
    },
  },
  {
    id: "search",
    icon: "search",
    label: {
      de: "Stellenangebote",
      en: "Opportunities",
      fr: "Offres",
      ar: "الوظائف المتاحة",
    },
  },
  {
    id: "saved",
    icon: "bookmark",
    label: {
      de: "Gespeicherte Stellen",
      en: "Saved Opportunities",
      fr: "Offres enregistrées",
      ar: "الوظائف المحفوظة",
    },
  },
  {
    id: "email-collector",
    icon: "mail",
    label: {
      de: "E-Mail-Sammlung",
      en: "Email Collector",
      fr: "Collecteur d'e-mails",
      ar: "جهاز جمع البريد",
    },
  },
  {
    id: "excel-export",
    icon: "download",
    label: {
      de: "Excel-Export",
      en: "Excel Export",
      fr: "Export Excel",
      ar: "تصدير Excel",
    },
  },
  {
    id: "ai-assistant",
    icon: "spark",
    label: {
      de: "KI-Assistent",
      en: "AI Assistant",
      fr: "Assistant IA",
      ar: "المساعد الذكي",
    },
  },
  {
    id: "scanner",
    icon: "scan",
    label: {
      de: "Bewerbungsscan",
      en: "Application Scanner",
      fr: "Scan de candidature",
      ar: "ماسح الطلبات",
    },
  },
  {
    id: "cv-templates",
    icon: "file",
    label: {
      de: "CV-Vorlagen",
      en: "CV Templates",
      fr: "Modèles de CV",
      ar: "قوالب السيرة الذاتية",
    },
  },
  {
    id: "cover-letter",
    icon: "edit",
    label: {
      de: "Anschreiben",
      en: "Cover Letter",
      fr: "Lettre de motivation",
      ar: "خطاب التقديم",
    },
  },
  {
    id: "deckblatt",
    icon: "folder",
    label: {
      de: "Deckblatt",
      en: "Cover Page (Deckblatt)",
      fr: "Page de couverture (Deckblatt)",
      ar: "الغلاف (Deckblatt)",
    },
  },
  {
    id: "applications",
    icon: "briefcase",
    label: {
      de: "Bewerbungen",
      en: "Applications",
      fr: "Candidatures",
      ar: "طلبات التقديم",
    },
  },
  {
    id: "email-sending",
    icon: "send",
    label: {
      de: "E-Mail-Versand",
      en: "Email Sending",
      fr: "Envoi d'e-mails",
      ar: "إرسال البريد",
    },
  },
  {
    id: "notifications",
    icon: "bell",
    label: {
      de: "Benachrichtigungen",
      en: "Notifications",
      fr: "Notifications",
      ar: "الإشعارات",
    },
  },
  {
    id: "privacy",
    icon: "lock",
    label: {
      de: "Datenschutz & Sicherheit",
      en: "Privacy & Security",
      fr: "Confidentialité & sécurité",
      ar: "الخصوصية والأمان",
    },
  },
  {
    id: "billing",
    icon: "chart",
    label: {
      de: "Abrechnung & Limits",
      en: "Billing & Limits",
      fr: "Facturation & limites",
      ar: "الفوترة والحدود",
    },
  },
  {
    id: "technical",
    icon: "alert",
    label: {
      de: "Technische Probleme",
      en: "Technical Problems",
      fr: "Problèmes techniques",
      ar: "مشكلات تقنية",
    },
  },
];

/** Lookup table: category id → category (for fast label/icon access). */
export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
