# تقرير المرحلة — إغلاق فجوة F1 (`saved_applications`) — 2026-10-24

**نقطة الانطلاق:** الفرع `feat/subscription-billing-system`، HEAD = `ec350c0` (`git log -1 --oneline`:
`ec350c0 feat(billing): complete AusbildungsWeg subscription & billing system`).
**حالة النهاية:** جميع التغييرات **غير مُلتزمة (UNCOMMITTED)** — لا push، لا merge، لا deploy، لا مسّ أسرار أو إعدادات Vercel (كما أُلزم).

---

## 1. إصلاح F1: إنفاذ حصة `saved_applications` على الخادم

**وحدة القياس (المقاسة فقط):** صف في `public.bew_applications` حيث `btrim(company_name) <> ''`.
صفوف النمو الفارغة لا تستهلك حصة. الجدول القديم `public.applications` ميت ولا يُعدّ (كان خطأ العرض الأصلي).

**الهوية الموثوقة:** كل مسارات الكتابة الثلاث في `src/lib/bewerbung-engine.ts` تستخدم `userId`
الناتج عن إعادة المصادقة الخادمية (لا شيء من العميل):
- `saveBewCompanies` — pre-check عند **L669** (قبل أي delete تدميري).
- `addBewCompany` — pre-check عند **L806** (بعد بوابة DUPLICATE التي تضمن اسمًا غير فارغ).
- `updateBewApplicationFields` — pre-check عند **L1091** **فقط** عند الانتقال فارغ→محتوى
  (الاسم الجديد فارغ/إعادة تسمية = مجاني — يطابق قاعدة الـ trigger).

**التزامن — لا فحص-ثم-إدراج غير ذري:**
- **الضمان الصلد = trigger قاعدة البيانات** (`enforce_saved_application_capacity`، BEFORE INSERT OR UPDATE
  على `bew_applications`) في الهجرة `supabase/migrations/20261123000000_saved_application_capacity.sql`:
  قفل صفّي لكل مستخدم (`user_capacity_locks`) → قراءة الحد → العدّ → القرار في **قسم حرج واحد**
  (lock → limit → count → decide). كل كاتب (بما فيه نوافذ race) يمر به؛ يرفع
  `saved_application_capacity_exceeded` (P0001) فيرجع الـ statement بأكمله.
- **pre-check استشاري فقط** (`check_saved_application_capacity` RPC للقراءة) لرسالة UX نظيفة قبل
  العملية التدميرية؛ `p_replace_campaign_id` يستثني صفوف الحملة التي يحذفها نفس العملية.
- **رسملة الخلل:** علامة الـ trigger تُخرَج في المسارات الثلاثة إلى الرمز المستقر `CAPACITY_EXCEEDED`
  (محارف `saved_application_capacity_exceeded` في L701/L848/L1126 من المحرك)، والموسومة في
  `BEW_KNOWN_CODES` (actions.ts L155) و`BEW_STABLE_ADD_CODES` (L335)، i18n للغات الأربع
  (`dictionaries.ts` L2054 de / L4052 en / L6056 fr / L7989 ar).
- **فشل مغلق:** أي فشل في قراءة الحصة → `status: "error"` → `SAVE_FAILED`
  (entitlement-service.ts L835-840 fallback، L935-937) — قراءة مفقودة لا تعني أبدًا "هناك مكان".

### ⚠ خلل اكتُشف وأُصلح أثناء هذه المرحلة (off-by-one في فرع UPDATE)
المسودة الأولى للـ trigger عولت في فرع UPDATE على أن العدّ "يتضمن الصف المحدث" — وهذا **خطأ**:
الـ BEFORE trigger يرى الصف في حالته **القديمة** (لا تزال فارغة)، فمعيار `v_used > v_limit` كان
يسمح بوصول المستخدم إلى **limit + 1** عبر تعبئة صف فارغ عند اكتمال الحصة. **أُصلح** بدمج الفرعين
على المعيار الموحد `v_used + 1 > v_limit` (نفس معيار INSERT وRPC الاستشاري).
**هذا الإصلاح لم يُختبر على PostgreSQL حقيقي** — البرهان العملي المخصص له = Probe B في وثيقة
Staging (سباق 5 تحديثات فارغ→محتوى مع مكان واحد؛ الكود القديم كان سيسمح باثنين).

---

## 2. الاختبارات — الأرقام الفعلية (كلها من تشغيلات هذه الجلسة)

| الشغالة | النتيجة الفعلية |
|---|---|
| `tests/saved-applications-capacity.test.ts` (جديد) | **28/28 ✓** |
| التحقق المستهدف (10 ملفات تُمسها البوابة) | **10 ملفات / 241 اختبارًا ✓** |
| `npm test` الكامل | **3155 نجح / 7 فشل (3162)** — الـ 7 = الأساس البيئي الموثق مسبقًا |
| التأكيد المعزول للفشلين السبعة | `schedule-time` (6: tzdata Morocco-2026 قديمة) + `deckblatt-composition` (1: لا google-chrome) — نفس الأساس، لا علاقة للمرحلة |
| `tsc --noEmit` | **exit 0** |
| `eslint` على الـ 18 ملفًا المعدل/الجديد | **exit 0** |
| مسارات `createLegacyCampaign` (P3) | `email-draft-quota` **8/8 ✓**؛ `email-scheduling` + `email-rate-limit` + `draft-free-workflow` **72/72 ✓** |

**تغطية المتطلبات بالنقاط (الوحدة الجديدة + الموسعات):**
- **الخطط الثلاث** (Suite A): الحدود مرساة من `COMMERCIAL_PLANS` نفسها (اختبار anchor يثبّت 3/200/500):
  آخر خانة مسموحة (`used + 1 == limit` → ok) والخطوة التالية مرفوضة (`CAPACITY_EXCEEDED`) عبر
  `addBewCompany` و`saveBewCompanies`؛ + بلا حد (legacy/مجاني = مرور كامل) + معطّل (0 = رفض كل كتابة محتوى).
- **بلوغ الحد بالضبط** (A + B): إعادة حفظ الحملة **نفسها** تفرّغ خاناتها (بند `p_replace_campaign_id`)،
  والصفوف الفارغة لا تستهلك شيئًا حتى عند الكمال، والرفض يسبق الـ delete التدميري (الصفوف تبقى byte-identical).
- **إعادة المحاولة** (Suite C): رفض = لا شيء يُضاف → تحرير خانة (مسح = مجاني دائمًا) → نفس العملية تنجح.
- **تزامن عمليات الحفظ** (Suite D + B-backstop):
  - `Promise.all` لإضافتين متوازيتين مع خانة واحدة: كلاهما يعبر الـ pre-check (متوثق: استدعاءان "ok")،
    والـ trigger المحاكى يقبل **واحدة بالضبط** والخسارة ترفع `CAPACITY_EXCEEDED`؛ النهائي = limit أبدًا limit+1.
  - نفس النمط لسباق **فارغ→محتوى** على صفّين.
  - حقن سباق **حتمي** في نافذة pre-check→insert (البوابة تُمسك قبل الحل، وكتابة منافسة تدخل النافذة):
    marker الـ trigger يظهر ويلمَّ `CAPACITY_EXCEEDED` في مساري add وsave — برهان أن الخلف الصلب هو
    الذي يقرّر، لا الـ pre-check.
- **فشل التحقق من الاشتراك** (Suite E + 11 اختبارًا خدمة جديدة في `entitlement-service.test.ts`):
  rpc error / rpc throw / payload مشوّه (status مجهول) → `SAVE_FAILED` في المسارات الثلاثة، بلا أي
  حذف، وبلا تسريب نص RPC خام عبر حد الفعل. على مستوى الخدمة: `newContentCount=0` = لا RPC أصلًا؛
  `exceeded|disabled` → `CAPACITY_EXCEEDED`؛ أي فشل قراءة → `error` → `SAVE_FAILED`.
- **عقد الأفعال** (+3 في `bew-actions-contract.test.ts`): `CAPACITY_EXCEEDED` يعبر حد الفعل الثلاثي
  — reject مستقر في `bewSaveCompanies`/`bewUpdateCompany` (عبر `withStableError`، actions.ts L214-230)
  وresult `{ok:false, code:"CAPACITY_EXCEEDED"}` في `bewAddCompany` (L358-378).

**تصحيحات mocks في 8 ملفات قائمة (11 تحريرًا):** البنية المعيارية للـ mocks القديمة كانت تعيد
`{data:null}` لكل RPC — ومع البوابة الجديدة كان هذا = فشل مغلق = كسر مسارات سعيدة. أُعدّ
`check_saved_application_capacity` ليعيد `unmetered` (الخدمات الحقيقية تعمل في هذه الملفات)، وأُضيف
`assertSavedApplicationCapacity` (no-op) إلى mocks entitlement الكاملة في 6 ملفات. اختبارات الأداء
(`bew-perf-roundtrips`) حُدّثت بدقة لأن حفظ فارغ→محتوى يضيف **قفزة RPC واحدة** (الـ pre-check):
F4b 6/6→**7/7**، F5 BEFORE 14/13→**15/14**، F5b 9/8→**10/9** (+ `<15`/`<14`)، كل تعديل معلَّل
بشرح القفزة الجديدة.

---

## 3. مراجعة `createLegacyCampaign`: لا يتجاوز حصص المنتج — **لا تغيير سلوك**

الأدلة (كلها من `src/lib/email-campaigns.ts` إلا ما أُشير):
1. **email_drafts:** لا يُقاس في `createLegacyCampaign` عمدًا (حارس العد المزدوج، تعليق L222-224 وL374-376)
   لأن المسودة قُاست **مرة واحدة** عند الإنشاء: `createBlankDraft` في `application-drafts.ts` —
   `reserveFeatureOp(...,"email_drafts",...)` عند L262، إرجاع عند الفشل L282، تثبيت L287.
2. **سعة البريد اليومية (الحصة الوحيدة المشتركة المار بها):** حجز **ذري في قاعدة البيانات**
   `reserve_email_capacity` / `reserve_email_capacity_on` (L458-467) بهوية الموثوقة
   `target_user_id: current.user.id` (مستخرجة من إعادة المصادقة L384) وبكامل عدد المستلمين الصالحين؛
   فشل الحجز = رفض قبل أي استدامة (L468-473)؛ وإرجاع السعة على **مساري الفشل** (فشل إدراج الحملة
   L498-505، فشل إدراج الرسائل L526-534).
3. **سقف بنيوي:** ≤ 1000 مستلم (L453-454).
4. **لا لمسة لغيرها:** الطريق يكتب `email_campaigns`/`email_messages`/`activity_logs` فقط — لا
   `bew_applications` (إذن لا أثر على `saved_applications` الجديدة) ولا أي حصة عناصر أخرى.

الاستنتاج: **لا يمكن** لهذا المسار تجاوز أي حصة منتج؛ كل كمّية تمر ببوابة ذرية بفشل مغلق.
**لم يُغيَّر أي سلوك** (وفق الشرط: لا تغيير قبل توثيق الأثر واختبار المسارات القديمة) — واختبارات
المسارات القديمة أُعيد تشغيلها أخضرًا (أرقامها في الجدول أعلاه: 8/8 + 72/72).

---

## 4. Staging — وثيقة إجراء (لم تُنفَّذ)

**الملف:** `project/saved-applications-staging-procedure-2026-10-24.md` (مساحة العمل، خارج المستودع).

محتواها:
- **الترتيب:** `20261120` → `20261121` → `20261122` → **`20261123` (الجديدة)** + فحص إعادة تشغيل
  (كل ملف مرتين بدون خطأ) + شرط توافر هجرات `20261112` السابقة.
- **RLS:** `user_capacity_locks` مفعّل RLS وبلا سياسات (استعلاما `pg_class`/`pg_policies`) +
  نفْي قراء/كتابة عبر PostgREST بمفتاح anon + عدّ مباشر بعد المحاولات.
- **الصلاحيات:** `\dp`/`\sf` للجداول والدوال (definer=postgres، `search_path=public`، EXECUTE لـ
  service_role فقط) + execute probe بدور غير مسموح (42501 متوقع).
- **التزامن الحي (Probes A–E):** سباق 5 INSERTات عند الحد → نجاح واحد بالضبط و4×P0001؛ سباق
  5 UPDATEات فارغ→محتوى (برهان إصلاح off-by-one)؛ دفعة INSERT واحدة تتجاوز الحد → rollback كامل
  0 صفوف؛ مستخدم بلا حد → مرور كامل (وتوثيق إنشاء صف القفل قبل قراءة الحد)؛ حصة 0 → رفض "disabled".
  (Direct connection — لا Transaction pooler، وإلا يختلف سلوك التزامن.)
- **قراءة العدادات** (`plan_feature_limit`/`feature_capacity_status` بمصفوفة NULL/0/3)،
  **تفكيك** (rollback بالترتيب العكسي + حذف مستخدم الاختبار)، **قائمة قبول** بنودها 11.
- **لم يُطبَّق أي ترحيل على الإنتاج** — ولا حتى على Staging (لا PostgreSQL في هذه البيئة).

---

## 5. الفجوات المتبقية (بصدق)

1. **SQL لم يُختبر على قاعدة بيانات حقيقية.** الهجرة تحقّق منها **إحصائيًا فقط** (قراءة كاملة +
   محاكاة في الـ harness تعيد دلالاتها حرفًا بحرف) — لكن سلوك القفل الصفّي الحقيقي، و`FOR UPDATE`،
   وRLS/grants الفعلية: **لم تُجرَّب**؛ إثباتها العملي = Probes 2–5 في وثيقة Staging فقط.
2. **اختبارات التزامن هنا = محاكاة حتمية** (جافاسكربت أحادي الخيط + حقن نافذة سباق)، تثبت
   **قاعدة القرار ورسملة الخلل**، ولا تثبت التزامن على PostgreSQL. لا ادعاء خلاف ذلك.
3. **نافذة الاستبدال غير الذرية (سابقة للفترة):** `saveBewCompanies` يحذف ثم يدرج بجملتين
   مستقلتين؛ رفض الـ trigger **بعد** الحذف يترك الحملة المستبدَلة فارغة (الكمية محمية دائمًا —
   لا تجاوز حد). شكل قديم موثق (درس 42703)؛ ذرية الاستبدال خارج نطاق F1.
4. **مسار `saved_opportunities` الشقيق** ما يزال غير ذري (خارج نطاق هذه المرحلة).
5. **Rerun-safety للهجرات الأربع ومصفوفة `plan_feature_limit`** = إجراءات Staging موثقة (لم تُنفَّذ).
6. **CI غير شغول:** لا push إذن لا check-runs؛ الخضرة هنا محلية (الأساس البيئي السبعة لا يتكرر
   على runners كاملة الميزات — مثبت في مراحل سابقة).

**مبدأ المرحلة:** غياب الملاحظة ≠ أمان — كل بند أعلاه محدد بما اختُبر فعلًا وبما لم يختبر.

---

## 6. الفروق (مراجعة قبل أي commit مستقبلي)

`git status --porcelain` (حرفي من آخر تشغيل):
```
 M src/app/bewerbung-automation/actions.ts
 M src/components/bewerbung-automation/types.ts
 M src/lib/bewerbung-engine.ts
 M src/lib/billing/entitlement-service.ts
 M src/lib/i18n/dictionaries.ts
 M tests/applicant-profile.test.ts
 M tests/bew-actions-contract.test.ts
 M tests/bew-add-company.test.ts
 M tests/bew-add-rows.test.ts
 M tests/bew-email-message.test.ts
 M tests/bew-letter-pdf-cleanup.test.ts
 M tests/bew-letter-pdf.test.ts
 M tests/bew-page-repair.test.ts
 M tests/bew-perf-roundtrips.test.ts
 M tests/bew-send-engine.test.ts
 M tests/bew-wizard-navigation.test.ts
 M tests/entitlement-service.test.ts
?? supabase/migrations/20261123000000_saved_application_capacity.sql
?? tests/saved-applications-capacity.test.ts
```
`git diff --stat`: **17 ملفًا معدَّلًا، +466 / −27** (+ ملفان جديدان غير متتبعين: الهجرة ~218 سطرًا،
وحدة الاختبار 819 سطرًا). **لم يُنشأ أي commit** — بانتظار نجاح الاختبارات (تم) ومراجعة الفروق
(هذا التقرير + المستودع ما يزال قابلًا للمراجعة) وفق التكليف.
