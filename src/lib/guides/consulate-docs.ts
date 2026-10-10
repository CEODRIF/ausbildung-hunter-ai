/**
 * German missions (embassies/consulates) — verified visa information for the
 * "Dokumente für den Konsulatstermin" guide.
 *
 * DATA INTEGRITY RULES (this file is the single source of truth for the page):
 *  - Every entry carries the EXACT official URL that was fetched and reviewed
 *    on `lastReviewed` (11 Oct 2026) — no reconstructed or guessed URLs.
 *  - Only facts stated on that official page are included here. Where the
 *    page gives no per-document detail (or only in another language), we say
 *    so explicitly instead of filling in a generic list.
 *  - No universal "document list valid for all consulates" exists in this
 *    file by design — each entry is tied to its own source.
 *  - Arabic text mirrors the verified German fact; where the official page
 *    itself is English-only, the entry says so (languageNote).
 */

export interface ConsulateEntry {
  id: string;
  countryDe: string;
  countryAr: string;
  countryEn: string;
  missionDe: string;
  missionAr: string;
  cityDe: string;
  cityAr: string;
  /** Verified official page (fetched on `lastReviewed`). */
  url: string;
  /** ISO date the entry was reviewed against the official page. */
  lastReviewed: string;
  /** Jurisdiction notes as stated on the official page (if any). */
  jurisdiction?: { de: string; ar: string };
  fee?: { de: string; ar: string };
  appointment?: { de: string; ar: string };
  /** Verified document rules for this mission (from its official page). */
  docs: { de: string; ar: string }[];
  /** Other verified key notes (processing times, portals, warnings …). */
  notes: { de: string; ar: string }[];
  /** e.g. "official visa information is published in English only". */
  languageNote?: { de: string; ar: string };
}

const REVIEWED = "2026-10-11";

export const CONSULATES: ConsulateEntry[] = [
  {
    id: "eg-kairo",
    countryDe: "Ägypten",
    countryAr: "مصر",
    countryEn: "Egypt",
    missionDe: "Deutsche Botschaft Kairo",
    missionAr: "السفارة الألمانية في القاهرة",
    cityDe: "Kairo",
    cityAr: "القاهرة",
    url: "https://kairo.diplo.de/eg-de/service/05-visaeinreise/nationale-visa-startseite",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Zuständig für Ägypten, Jemen, Sudan und Gazastreifen. Für in Syrien lebende Antragstellende sind seit 01.06.2026 die Vertretungen in Amman, Beirut oder Erbil zuständig.",
      ar: "الاختصاص: مصر واليمن والسودان وغزة. وبالنسبة للمقدمين المقيمين في سوريا: تُختص منذ 01.06.2026 بعثات عمّان أو بيروت أو أربيل.",
    },
    fee: {
      de: "75 € (Kinder: 37,50 €), zahlbar in ägyptischen Pfund (EGP), nicht erstattbar.",
      ar: "75 يورو (للأطفال: 37,50 يورو)، تُدفع بالجنيه المصري (EGP) وغير قابلة للاسترداد.",
    },
    appointment: {
      de: "Termine u. a. für Berufsausbildung, Beschäftigung und Studium über den offiziellen Dienstleister TLScontact.",
      ar: "المواعيد (للتدريب المهني والعمل والدراسة وغيرها) عبر المزود الرسمي TLScontact.",
    },
    docs: [
      {
        de: "Ausgefülltes und eigenhändig unterschriebenes Visa-Antragsformular (VIDEX).",
        ar: "نموذج طلب التأشيرة (VIDEX) مملوءًا بالكامل وموقعًا بخط اليد.",
      },
      {
        de: "Erklärung nach § 18 II Nr. 5 AufenthG (informatorische Unterlage).",
        ar: "بيان وفق المادة 18 الفقرة الثانية رقم 5 من قانون الإقامة (وثيقة استرشادية).",
      },
      {
        de: "E-Mail-Erreichbarkeits-Erklärung (informatorische Unterlage).",
        ar: "إقرار بإمكانية التواصل عبر البريد الإلكتروني (وثيقة استرشادية).",
      },
      {
        de: "Biometrisches Passfoto.",
        ar: "صورة شخصية بيومترية.",
      },
      {
        de: "Alle Unterlagen grundsätzlich: Original + 1 Kopie (einfach, ungebunden).",
        ar: "جميع الوثائق كمبدأ عام: الأصل + نسخة واحدة (بجانب واحد، غير مشدودة).",
      },
      {
        de: "Alle Dokumente mit englischer oder deutscher beglaubigter Übersetzung.",
        ar: "جميع الوثائق مع ترجمة معتمدة إلى الألمانية أو الإنجليزية.",
      },
      {
        de: "Legalisation (Beglaubigung) bestimmter Dokumente je nach Anforderungen.",
        ar: "تصديق (توثيق) بعض الوثائق حسب المتطلبات.",
      },
    ],
    notes: [
      {
        de: "Bearbeitungsdauer (Stand der Seite): Beschäftigung mind. 2 Wochen, Studium 4 Wochen, Selbständigkeit 4 Monate, Familiennachzug 3 Monate.",
        ar: "مدة المعالجة (حسب الصفحة): العمل على الأقل أسبوعان، الدراسة 4 أسابيع، العمل الحر 4 أشهر، ولم شمل العائلة 3 أشهر.",
      },
      {
        de: "Ab 01.09.2026 werden biometrische Daten (Fingerabdrücke) für Personen ab 6 Jahren erfasst.",
        ar: "اعتبارًا من 01.09.2026 يتم تجميع البيانات البيومترية (بصمات الأصابع) لمن هم في السادسة من العمر فما فوق.",
      },
    ],
  },
  {
    id: "jo-amman",
    countryDe: "Jordanien",
    countryAr: "الأردن",
    countryEn: "Jordan",
    missionDe: "Deutsche Botschaft Amman",
    missionAr: "السفارة الألمانية في عمّان",
    cityDe: "Amman",
    cityAr: "عمّان",
    url: "https://amman.diplo.de/jo-de/konsulat/visastelle",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Auch zuständig für in Syrien lebende Antragstellende (seit 01.06.2026, lt. Hinweis der Botschaft Kairo).",
      ar: "تختص أيضًا بمقدمي الطلبات المقيمين في سوريا (منذ 01.06.2026، حسب تنبيه سفارة القاهرة).",
    },
    docs: [
      {
        de: "Auf der offiziellen Seite werden Visakategorien mit eigenen Untereisen geführt, u. a.: „Erwerbstätigkeit und Ausbildung“, „Chancenkarte“, „Anerkennungsmaßnahmen (§ 16d)“, „Studium“. Die Detaillisten (Original/Kopie/Übersetzung) stehen auf den jeweiligen Kategorieseiten.",
        ar: "تُنشِر الصفحة الرسمية فئات تأشيرات بصفحات فرعية مستقلة، منها: «العمل والتدريب المهني»، «بطاقة الفرصة»، «إجراءات الاعتراف (المادة 16د)»، «الدراسة». والقوائم التفصيلية (أصل/نسخة/ترجمة) متاحة في صفحات الفئات المعنية.",
      },
    ],
    notes: [
      {
        de: "Gesonderte Gebührendaten werden auf einer eigenen Seite der Vertretung geführt — siehe die offizielle Seite.",
        ar: "تُدار بيانات الرسوم في صفحة مستقلة لدى البعثة — راجع الصفحة الرسمية.",
      },
    ],
  },
  {
    id: "tn-tunis",
    countryDe: "Tunesien",
    countryAr: "تونس",
    countryEn: "Tunisia",
    missionDe: "Deutsche Botschaft Tunis",
    missionAr: "السفارة الألمانية في تونس",
    cityDe: "Tunis",
    cityAr: "تونس",
    url: "https://tunis.diplo.de/tn-de/service/05-visaeinreise",
    lastReviewed: REVIEWED,
    fee: {
      de: "75 € (Kinder: 37,50 €), zahlbar in tunesischen Dinar (TND).",
      ar: "75 يورو (للأطفال: 37,50 يورو)، تُدفع بالدينار التونسي (TND).",
    },
    appointment: {
      de: "Online-Antrag über das offizielle Auslandsportal u. a. für Studium, Berufsausbildung, Fachkräfte, Chancenkarte und Familiennachzug (seit 15.01.2025); bestimmte Zwecke weiterhin über TLScontact.",
      ar: "الطلب الإلكتروني عبر بوابة Auslandsportal الرسمية للدراسة والتدريب المهني والكفاءات وبطاقة الفرصة ولم شمل العائلة (منذ 15.01.2025)؛ وبعض الأغراض ما زالت عبر TLScontact.",
    },
    docs: [
      {
        de: "Antragsformular zweifach ausgedrückt; Dokumente im A4-Format.",
        ar: "نموذج الطلب مطبوعًا مرتين؛ الوثائق بحجم A4.",
      },
      {
        de: "Legalisation über TLScontact (je nach Dokument).",
        ar: "التصديق (التوثيق) عبر TLScontact (حسب الوثيقة).",
      },
      {
        de: "Sperrkonto: seit 02/2023 werden ausschließlich deutsche Sperrkonten anerkannt (je nach Visumart).",
        ar: "الحساب المقفل (Sperrkonto): منذ 02/2023 يُعترف فقط بالحسابات المقفلة الألمانية (حسب نوع التأشيرة).",
      },
    ],
    notes: [
      {
        de: "Wartezeiten (Stand der Seite): Beschäftigung > 12 Monate, Familiennachzug ca. 5 Monate, Ausbildung ca. 4 Wochen.",
        ar: "زمن الانتظار (حسب الصفحة): العمل أكثر من 12 شهرًا، لم شمل العائلة نحو 5 أشهر، التدريب نحو 4 أسابيع.",
      },
      {
        de: "Fachkräfteeinwanderungsgesetz (FEG): bei Fachkräften ist eine vorangegangene Anerkennung der Qualifikation erforderlich.",
        ar: "قانون هجرة الكفاءات (FEG): في حالة الكفاءات يُشترط الاعتراف المسبق بالشهادة.",
      },
    ],
  },
  {
    id: "ma-rabat",
    countryDe: "Marokko",
    countryAr: "المغرب",
    countryEn: "Morocco",
    missionDe: "Deutsche Botschaft Rabat",
    missionAr: "السفارة الألمانية في الرباط",
    cityDe: "Rabat",
    cityAr: "الرباط",
    url: "https://rabat.diplo.de/ma-de/service/05-visaeinreise",
    lastReviewed: REVIEWED,
    docs: [
      {
        de: "Detail-Listen je Visumart über den offiziellen Visa-Navigator bzw. die Kategorieseiten der Vertretung — siehe die offizielle Seite.",
        ar: "القوائم التفصيلية حسب نوع التأشيرة عبر دليل التأشيرات الرسمي أو صفحات الفئات لدى البعثة — راجع الصفحة الرسمية.",
      },
    ],
    notes: [
      {
        de: "Offizieller Warnhinweis der Botschaft an Arbeitssuchende und Auszubildende: In Deutschland dürfen Kosten für die Vermittlung einer Ausbildung nur vom Arbeitgeber getragen werden — Vereinbarungen über die Zahlung an Vermittler durch die ausbildsuchende Person sind nach deutschem Recht unwirksam.",
        ar: "تنبيه رسمي من السفارة موجّه إلى الباحثين عن عمل والمتدربين: في ألمانيا يجوز تحمل تكاليف ترتيب التدريب المهني من قِبَل صاحب العمل فقط — والاتفاقات التي تدفع بموجبها الشخص الباحث عن التدريب مستحقات للوساطة تعتبر باطلة وفق القانون الألماني.",
      },
      {
        de: "Weitere offizielle Warnung vor gefälschten Sprachzertifikaten und schwarzen Vermittlungsagenturen.",
        ar: "تنبيه رسمي آخر بخصوص شهادات اللغة المزوّرة ومكاتب التوظيف غير القانونية.",
      },
    ],
  },
  {
    id: "lb-beirut",
    countryDe: "Libanon",
    countryAr: "لبنان",
    countryEn: "Lebanon",
    missionDe: "Deutsche Botschaft Beirut",
    missionAr: "السفارة الألمانية في بيروت",
    cityDe: "Beirut",
    cityAr: "بيروت",
    url: "https://beirut.diplo.de/lb-de/service/05-visaeinreise",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Zuständig für Antragstellende mit gewöhnlichem Aufenthalt im Libanon und in Syrien (Stand der offiziellen Seite).",
      ar: "الاختصاص: مقدمو الطلبات المقيمون عادةً في لبنان وسوريا (حسب الصفحة الرسمية).",
    },
    docs: [
      {
        de: "VFS Global ist NUR für Schengen-Visa, Studium und Legalisation zuständig — Visaanträge zur Erwerbstätigkeit werden direkt bei der Botschaft bearbeitet.",
        ar: "VFS Global تختص فقط بتأشيرات شنغن والدراسة والتصديق — أما طلبات التأشيرة للعمل فتُعالَج مباشرة لدى السفارة.",
      },
    ],
    notes: [
      {
        de: "Offizielle Warnung vor Betrugsversuchen (unautorisierte Vermittler, gefälschte Zusage-Versprechen) — nur offizielle Kanäle der Vertretung verwenden.",
        ar: "تحذير رسمي من محاولات النصب (وسطاء غير مصرح لهم، وعود مزيفة) — يُستخدَم فقط القنوات الرسمية للبعثة.",
      },
    ],
  },
  {
    id: "tr-ankara",
    countryDe: "Türkei",
    countryAr: "تركيا",
    countryEn: "Türkiye",
    missionDe: "Deutsche Botschaft Ankara / Generalkonsulat Istanbul",
    missionAr: "السفارة الألمانية في أنقرة / القنصلية العامة في إسطنبول",
    cityDe: "Ankara, Istanbul",
    cityAr: "أنقرة، إسطنبول",
    url: "https://tuerkei.diplo.de/tr-de/service/05-visaeinreise/2703120-2703120",
    lastReviewed: REVIEWED,
    docs: [
      {
        de: "Für türkische Staatsangehörige existiert eine gesonderte Seite („Nationale Visa für türkische Staatsangehörige“); die Detaillisten stehen dort.",
        ar: "للأتراك توجد صفحة مستقلة («تأشيرات وطنية لرعايا تركيا»)؛ والقوائم التفصيلية متاحة هناك.",
      },
    ],
    appointment: {
      de: "Offizielle Dienstleister: iDATA (für türkische Staatsangehörige) und IOM-FAP (für nicht-türkische Staatsangehörige) — getrennte Buchungssysteme.",
      ar: "المزودون الرسميان للخدمات: iDATA (لرعايا تركيا) وIOM-FAP (لغير الأتراك) — بنظامي حجز منفصلين.",
    },
    fee: {
      de: "iDATA-Servicegebühr 39,92 € + Buchungsgebühr 12 € (zahlbar in TRY), je nach Visumtyp.",
      ar: "رسوم خدمة iDATA: 39,92 يورو + رسوم الحجز 12 يورو (تُدفع بالليرة التركية TRY)، حسب نوع التأشيرة.",
    },
    notes: [
      {
        de: "Viele Visakategorien können über das offizielle Auslandsportal online beantragt werden.",
        ar: "يمكن تقديم طلبات كثير من فئات التأشيرات إلكترونيًا عبر بوابة Auslandsportal الرسمية.",
      },
      {
        de: "Auch zuständig für iranische Staatsangehörige (Schengen u. nationale Visa) — lt. Hinweis auf dieser offiziellen Seite.",
        ar: "تختص أيضًا برعايا إيران (شنغن والتأشيرات الوطنية) — حسب التنبيه على هذه الصفحة الرسمية.",
      },
    ],
  },
  {
    id: "iq-baghdad",
    countryDe: "Irak",
    countryAr: "العراق",
    countryEn: "Iraq",
    missionDe: "Deutsche Botschaft Bagdad / Generalkonsulat Erbil",
    missionAr: "السفارة الألمانية في بغداد / القنصلية العامة في أربيل",
    cityDe: "Bagdad, Erbil",
    cityAr: "بغداد، أربيل",
    url: "https://irak.diplo.de/iq-de/service",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Getrennte Visaseiten für Bagdad und Erbil; Erbil ist auch für syrische Antragstellende zuständig (lt. Hinweis der Botschaft Kairo).",
      ar: "صفحات تأشيرات منفصلة لكل من بغداد وأربيل؛ وتختص أربيل أيضًا بمقدمي الطلبات السوريين (حسب تنبيه سفارة القاهرة).",
    },
    docs: [
      {
        de: "Die Detail-Listen (Original/Kopie/Übersetzung) stehen auf den offiziellen Visaseiten „Visa in Bagdad“ bzw. „Visa in Erbil“ der Vertretung.",
        ar: "القوائم التفصيلية (أصل/نسخة/ترجمة) متاحة في الصفحات الرسمية «التأشيرات في بغداد» و«التأشيرات في أربيل» لدى البعثة.",
      },
    ],
    notes: [],
  },
  {
    id: "ir-tehran",
    countryDe: "Iran",
    countryAr: "إيران",
    countryEn: "Iran",
    missionDe: "Deutsche Botschaft Teheran",
    missionAr: "السفارة الألمانية في طهران",
    cityDe: "Teheran",
    cityAr: "طهران",
    url: "https://tehran.diplo.de/",
    lastReviewed: REVIEWED,
    docs: [
      {
        de: "Die Vertretung publiziert ihre Service-Seiten auf Deutsch und Persisch; die Detail-Listen der nationalen Visa stehen dort.",
        ar: "تنشر البعثة صفحات خدماتها بالألمانية والفارسية؛ والقوائم التفصيلية للتأشيرات الوطنية متاحة هناك.",
      },
    ],
    notes: [
      {
        de: "Laut Hinweis auf der offiziellen türkischen Visaseite ist die Vertretung Teheran auch für iranische Staatsangehörige zuständig.",
        ar: "حسب التنبيه على الصفحة الرسمية التركية للتأشيرات، تختص بعثة طهران برعايا إيران.",
      },
    ],
  },
  {
    id: "pk-islamabad",
    countryDe: "Pakistan",
    countryAr: "باكستان",
    countryEn: "Pakistan",
    missionDe: "Deutsche Botschaft Islamabad",
    missionAr: "السفارة الألمانية في إسلام آباد",
    cityDe: "Islamabad",
    cityAr: "إسلام آباد",
    url: "https://pakistan.diplo.de/pk-en/service/visa-longterm-1676102",
    lastReviewed: REVIEWED,
    languageNote: {
      de: "Die Visuinformation der Vertretung ist offiziell nur auf Englisch (und Urdu) veröffentlicht — die deutsche Übersetzung in diesem Leitfaden orientiert sich an der englischen Originalseite.",
      ar: "معلومات التأشيرات لدى البعثة منشورة رسميًا بالإنجليزية (والأردية) فقط — والترجمة الألمانية/العربية في هذا الدليل تستند إلى الصفحة الإنجليزية الأصلية.",
    },
    appointment: {
      de: "Langfristige Visa (u. a. „Employment, training and jobseeker visa“) digital über den Consular Services Portal der Vertretung.",
      ar: "التأشيرات طويلة الأمد (منها: «تأشيرة العمل والتدريب والبحث عن وظيفة») تُقدَّم رقميًا عبر بوابة الخدمات القنصلية للبعثة.",
    },
    docs: [
      {
        de: "Die kategoriebezogenen Listen (Employment / Training / Jobseeker) mit Original-/Kopie- und Übersetzungsangaben stehen auf den offiziellen Kategorieseiten der Vertretung.",
        ar: "القوائم الخاصة بكل فئة (عمل/تدريب/بحث عن وظيفة) مع بيانات الأصل/النسخة والترجمة متاحة في صفحات الفئات الرسمية لدى البعثة.",
      },
    ],
    notes: [],
  },
  {
    id: "sa-riyadh",
    countryDe: "Saudi-Arabien",
    countryAr: "السعودية",
    countryEn: "Saudi Arabia",
    missionDe: "Deutsche Botschaft Riad",
    missionAr: "السفارة الألمانية في الرياض",
    cityDe: "Riad",
    cityAr: "الرياض",
    url: "https://saudiarabien.diplo.de/ksa-de/nationale-visa-2195052",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Zuständigkeit nach gewöhnlichem Aufenthalt (ab ca. 6 Monaten) in Saudi-Arabien; Reisedokumente müssen bei Antragstellung mind. 9 Monate gültig sein.",
      ar: "الاختصاص: حسب الإقامة المعتادة (من نحو 6 أشهر) في السعودية؛ ويجب أن يكون جواز السفر ساريًا لمدة لا تقل عن 9 أشهر عند تقديم الطلب.",
    },
    docs: [
      {
        de: "Einreise in Deutschland innerhalb von 3 Monaten nach Visumerteilung erforderlich; Reklamation (Rémonstration) entfällt seit 01.07.2025.",
        ar: "يجب دخول ألمانيا خلال 3 أشهر من منح التأشيرة؛ وإجراء الاعتراض (Reclamation) لم يعد ساريًا منذ 01.07.2025.",
      },
    ],
    notes: [
      {
        de: "Bestimmte Visakategorien können über das offizielle Auslandsportal online beantragt werden; seit 12.10.2025 gilt das Einreise-/Ausreisesystem (EES) mit biometrischer Erfassung.",
        ar: "يمكن تقديم بعض فئات التأشيرات إلكترونيًا عبر بوابة Auslandsportal الرسمية؛ ومنذ 12.10.2025 يسري نظام الدخول/الخروج (EES) مع جمع البيانات البيومترية.",
      },
      {
        de: "Auch zuständig für in Syrien lebende Antragstellende (seit 01.06.2026, lt. Hinweis auf der Seite).",
        ar: "تختص أيضًا بمقدمي الطلبات المقيمين في سوريا (منذ 01.06.2026، حسب التنبيه على الصفحة).",
      },
    ],
  },
  {
    id: "kw-kuwait",
    countryDe: "Kuwait",
    countryAr: "الكويت",
    countryEn: "Kuwait",
    missionDe: "Deutsche Botschaft Kuwait",
    missionAr: "السفارة الألمانية في الكويت",
    cityDe: "Kuwait-Stadt",
    cityAr: "مدينة الكويت",
    url: "https://kuwait.diplo.de/kw-en/service/visa-einreise/2702810-2702810",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Zuständig für Antragstellende mit gewöhnlichem Aufenthalt in Kuwait (Hauptbestimmungsort Deutschland). Auch gewöhnlich in Jemen lebende Antragstellende können hier ein nationales Visum beantragen.",
      ar: "الاختصاص: المتقدمون المقيمون عادةً في الكويت (والموطن الرئيسي ألمانيا). كما يمكن للساكنين عادةً في اليمن تقديم طلب التأشيرة الوطنية هنا.",
    },
    appointment: {
      de: "Termin über das Terminsystem der Botschaft — jede:r Antragstellende braucht einen eigenen Termin und erscheint persönlich; die Terminbuchung ist kostenlos. Die Botschaft rät dringend davon ab, „Agenten“ oder „Berater“ zu beauftragen (Risiko von Zeit- und Geldverlust).",
      ar: "الترتيب عبر نظام مواعيد السفارة — لكل متقدم موعد خاص به وحضور شخصي؛ الحجز مجاني. تنصح السفارة بشدة بعدم الاستعانة بـ«وسطاء» أو «مستشارين» (خطر ضياع الوقت والمال).",
    },
    docs: [
      {
        de: "VIDEX-Antragsformular für nationale Visa, biometrisches Passfoto (weißer/heller Hintergrund), Einverständnis in elektronische Korrespondenz und Sicherheitsanfragebogen nach § 54 AufenthG; je nach Visumzweck ggf. Erklärung zum Arbeitsvertrag (+ Anhang A/B) bzw. Erklärungen nach § 18 oder § 82 AufenthG.",
        ar: "نموذج طلب VIDEX للتأشيرات الوطنية، وصورة شخصية بيومترية (خلفية بيضاء/فاتحة)، والموافقة على المراسلة الإلكترونية، ونموذج الاستفسارات الأمنية وفق § 54 AufenthG؛ حسب الغرض قد تضاف إقرار العقد (والملاحق أ/ب) أو إقرارات § 18 أو § 82 AufenthG.",
      },
      {
        de: "Dokumente und Nachweise auf Deutsch oder Englisch; in anderer Sprache: Original mit amtlicher Übersetzung ins Deutsche oder Englische.",
        ar: "المستندات بالألمانية أو الإنجليزية؛ إن كانت بلغة أخرى: الأصل مع ترجمة رسمية إلى الألمانية أو الإنجليزية.",
      },
      {
        de: "Zertifikate und Diplome im Original mit Apostille/Legalisation vorlegen.",
        ar: "تقديم الشهادات الأصلية مع الأباستيل/التصديق.",
      },
      {
        de: "Keine Dokumente heften und nichts per E-Mail an die Visa-Sektion senden — alle Unterlagen zum Termin mitbringen.",
        ar: "لا تثبت المستندات بدبابيس ولا تُرسَل بالبريد الإلكتروني — أحضر كل المستندات معك إلى الموعد.",
      },
      {
        de: "Reisepass und Civil ID werden nach der Prüfung zurückgegeben; alle anderen Originale nach Abschluss des Verfahrens.",
        ar: "يُعاد الجواز وسمة الإقامة (Civil ID) بعد الفحص، وبقية الوثائق الأصلية بعد انتهاء الإجراءات.",
      },
    ],
    notes: [
      {
        de: "Online-Antrag über das offizielle Auslandsportal (Consular Services Portal) möglich — ausdrücklich auch „Visa for basic or advanced vocational training and to seek a vocational training place“ (Ausbildung). Das Portal bestätigt, ob die Unterlagen vollständig sind; beim Termin: Originale vorlegen, biometrische Daten, Gebühr zahlen.",
        ar: "إمكانية التقديم عبر البوابة الخارجية الرسمية (Auslandsportal) — وصراحةً أيضًا «تأشيرة التدريب المهني الأساسي أو المتقدم والبحث عن مكان تدريب». تؤكد البوابة اكتمال المستندات؛ وفي الموعد: إحضار الأصول والبيانات البيومترية ودفع الرسوم.",
      },
      {
        de: "Papiervariante: Termine sind oft knapp — das Online-Verfahren wird empfohlen. Die Bearbeitung kann von wenigen Tagen bis zu mehreren Monaten dauern.",
        ar: "الطريقة الورقية: المواعيد غالبًا قليلة — يُنصح بالتقديم الإلكتروني. قد تستغرق المعالجة من أيام قليلة إلى عدة أشهر.",
      },
      {
        de: "Wer weder Arabisch noch Englisch noch Hindi spricht, bringt eine:n Übersetzer:in zum Termin mit.",
        ar: "من لا يتكلم العربية ولا الإنجليزية ولا الهندية يرافق مترجمًا إلى الموعد.",
      },
      {
        de: "Das Reklamationsverfahren (Mittel gegen Visa-Ablehnungen) wird zum 01.07.2025 weltweit abgeschafft.",
        ar: "أُلغي اعتبارًا من 01.07.2025 إجراء «الاعتراض» (Reklamation) ضد رفض التأشيرة على مستوى العالم.",
      },
    ],
    languageNote: {
      de: "Die offizielle Visuinformation der Vertretung ist nur auf Englisch veröffentlicht — die verlinkte Seite ist die englische Originalseite.",
      ar: "معلومات التأشيرات الرسمية لدى البعثة منشورة بالإنجليزية فقط — الصفحة المرتبطة هي الأصل الإنجليزي.",
    },
  },
  {
    id: "ae-dubai",
    countryDe: "Vereinigte Arabische Emirate",
    countryAr: "الإمارات العربية المتحدة",
    countryEn: "UAE",
    missionDe: "Deutsche Botschaft Abu Dhabi / Generalkonsulate Dubai u. a.",
    missionAr: "السفارة الألمانية في أبوظبي / القنصليات العامة (دبي وغيرها)",
    cityDe: "Abu Dhabi, Dubai",
    cityAr: "أبوظبي، دبي",
    url: "https://uae.diplo.de/ae-en/ueber-uns/generalkonsulat1",
    lastReviewed: REVIEWED,
    jurisdiction: {
      de: "Konsulatsbezirk des Generalkonsulats Dubai: Dubai, Sharjah, Ajman, Umm al Quain, Ras al Khaimah, Fujairah und Abu Dhabi (nur Konsulatsbezirk).",
      ar: "الدائرة القنصلية للقنصلية العامة في دبي: دبي، الشارقة، عجمان، أم القيوين، رأس الخيمة، الفجيرة وأبوظبي (الدائرة القنصلية فقط).",
    },
    appointment: {
      de: "Allgemeine Öffnungszeiten Mo–Do 08:00–15:00, Fr 08:00–12:00; weitere Termine auf Anfrage.",
      ar: "ساعات العمل العامة: الاثنين–الخميس 08:00–15:00، الجمعة 08:00–12:00؛ مواعيد إضافية عند الطلب.",
    },
    docs: [],
    notes: [
      {
        de: "Wichtiger Hinweis der Vertretung: Das Generalkonsulat fordert NIEMALS dazu auf, Zahlungen online, über Links, Anträge o. ä. zu veranlassen (Schutz vor Betrug).",
        ar: "تنبيه مهم من البعثة: القنصلية العامة لن تطلب منكم أبدًا إجراء أي دفعات عبر الإنترنت أو روابط أو طلبات أو ما شابه (حماية من الاحتيال).",
      },
    ],
    languageNote: {
      de: "Die offizielle Visuinformation der Vertretung ist nur auf Englisch veröffentlicht — bitte die englische Originalseite öffnen.",
      ar: "معلومات التأشيرات الرسمية لدى البعثة منشورة بالإنجليزية فقط — يُرجى فتح الصفحة الإنجليزية الأصلية.",
    },
  },
];

/** Official fallback links (all verified live on the review date). */
export const GENERAL_LINKS = {
  allMissions: "https://www.auswaertiges-amt.de/de/reiseundsicherheit/deutsche-auslandsvertretungen",
  auslandsportal: "https://auslandsportal.auswaertiges-amt.de/",
  generalRules: "https://www.auswaertiges-amt.de/de/service/visa-und-aufenthalt",
} as const;
