# مراجعة مستقلة للفروق — بعد إصلاح F1 وقبل أي commit (2026-10-24)

**الوضع:** الفرع `feat/subscription-billing-system`، HEAD = `ec350c0` (لم يتحرك). 17 ملفًا معدَّلًا
(+466/−27) + ملفان جديدان غير متتبعين. `git diff --check`: **exit 0** (لا أخطاء مسافات).
المراجعة **قراءة فقط** — لم يُعدَّل أي ملف خلالها، ولا commit/push/merge/deploy.
كل سطر مرقّم أدناه من ملفات القرص أو مخرجات أوصلات هذه الجلسة.

---

## 1) فحص الحالة والفروق (نقطة 1)

| الفحص | النتيجة |
|---|---|
| `git status --porcelain` | 17× `M` + 2× `??` — كل المسارات مرتبطة بـ F1 (تفاصيل النقطة 5) |
| `git diff --check` | **exit 0** |
| `git diff --stat` | 17 files, +466/−27 |
| `git rev-parse`/`log` | HEAD ثابت `ec350c0` |
| الملفان الجديدان | `supabase/migrations/20261123000000_saved_application_capacity.sql` (219 سطرًا) و`tests/saved-applications-capacity.test.ts` (821 سطرًا) — **قُرئا كاملاً من القرص** |
| `git diff` كامل (src + tests) | **قُرأ كاملًا** (كل hunk) — لا تغيير واحد خارج نطاق F1 |

**النتيجة:** لا تغييرات طارئة، لا ملفات خارج النطاق، لا أسرار (انظر النقطة 5).

---

## 2) مراجعة trigger `saved_applications` بالتفصيل (نقطة 2)

الملف: `supabase/migrations/20261123000000_saved_application_capacity.sql` (من القرص، بعد إصلاح off-by-one).

### 2.1 قفل المستخدم (L81-87)
```sql
insert into public.user_capacity_locks (user_id) values (new.user_id) on conflict (user_id) do nothing;
perform 1 from public.user_capacity_locks where user_id = new.user_id for update;
```
- **الصحيح:** النمط القياسي — الإدراج المبدئي يملك صف القفل حتى COMMIT، والمنافس (INSERT speculatif)
  ينتظر النتيجة ثم `do nothing`، و`FOR UPDATE` يرتّب الجميع خلف الصف نفسه → **القسم الحرج كاملًا
  (قفل → حد → عدّ → قرار) تحت القفل**. القفل يُؤخذ **قبل** قراءة الحد (L81-87 ثم L91) — الترتيب صحيح.
- لا خطر deadlock: قفل صف واحد لكل مستخدم، والعدّ (L108-111) قراءة MVCC بلا أقفال صفوف.
- جدول الأقفال: RLS مفعّل **بلا سياسات** (L52-57) → anon/authenticated بلا صفوف؛ service_role
  (BYPASSRLS في Supabase) يمكنه القراءة/الكتابة — **قابل للقبول**: الجدول يحفظ `user_id`+`locked_at` فقط
  (لا بيانات حساسة)، والtrigger يعمل بدور postgres (definer) أياً كان.
- `on delete cascade` إلى `auth.users` (L53) — حذف المستخدم يزيل صف قفله (نفس نمط search_credits).

### 2.2 حساب العدد (L108-111)
- `count(*) where user_id = new.user_id and btrim(coalesce(company_name,'')) <> ''` — **لكل حملات
  المستخدم** (حصة لكل مستخدم لا لكل حملة) ✓، و`coalesce` يغطي NULL ✓.
- في دفعة INSERT: صفوف الجملة السابقة المرصودة مرئية للترiggers اللاحقة → عدّ تسلسلي صحيح.

### 2.3 دلالات INSERT وUPDATE ومنع limit+1 (L75-77 البوابة، L101-115 القرار)
- البوابة: يُقاس فقط (INSERT باسم غير فارغ) أو (UPDATE قادمه فارغة/NULL ← غير فارغة).
  إعادة التسمية والإفراغ تمران مجانًا ✓.
- **القاعدة الموحدة** `v_used + 1 > v_limit` (L112): BEFORE trigger يرى جدول الحالة **الماضية** —
  صف INSERT غير موجود بعد، وصف UPDATE ما يزال بصيغته الفارغة — فالإسقاط = `v_used + 1` في
  الحالتين. **هذا هو إصلاح off-by-one** (المسودة الأولى كانت `v_used > v_limit` في UPDATE
  فتسمح بـ limit+1 — موثق في التقرير السابق).
- **النتيجة (invariant):** بعد أي COMMIT، عدّ المحتوى ≤ limit للمستخدم المقاس — تحت القفل لا يوجد
  مسار يفلت (كل كاتب يمر بالtrigger؛ لا مدخلات أخرى لجدول `bew_applications`).
- UPDATE متعدد الصفوف (جملة واحدة تعدّل صفّين فارغين ← محتوى): الtrigger الفعلي يعدّ الصف الأول
  بعد تطبيقه عند trigger الثاني (تطبيق متسلسل داخل الجملة) — **الصحيح على PG حقيقي** (انظر L1:
  الـ harness لا يحاكي هذا التفصيل، لكنه غير مستخدم حاليًا).

### 2.4 الحذف والاستبدال
- **DELETE:** لا trigger (before insert or update فقط) → الحذف مجاني ✓.
- **الاستبدال (saveBewCompanies):** الـ RPC الاستشاري يستثني صفوف الحملة المستبدَلة
  (`p_replace_campaign_id`, L158-159) والـ trigger يعدّ بعد الحذف الفعلي — متسق ✓.
- **نافذة non-atomic (موثقة):** الحذف (محرك L672) والإدراج (L697) جملتان؛ رفض الtrigger بعد الحذف
  يترك الحملة المستبدَلة فارغة (الكمية محمية دائمًا؛ الشكل قديم قبل F1 — انظر M2).

### 2.5 غياب الاشتراك وفشل التحقق
- **بلا اشتراك/خطة:** `plan_feature_limit` (20261121 L190-218: join على subscriptions النشطة
  + billing_plans.feature_limits) يعيد NULL → الtrigger `return new` (L92-94) = **مرور كامل**
  (سلوك الـ legacy/المجاني محفوظ) ✓. انتهاء الاشتراك → نفس المسار (downgrade لمجاني = بلا حد —
  نموذج موحد مع بقية الميزات؛ موثق في Matrix Staging).
- **مفتاح feature_limits غائب أو JSON-null** → `->>` يعيد NULL → بلا قياس (موحّد مع `salary_calculator: null`
  في البذور 20261120 L88-92) ✓.
- **فشل التحقق على مستوى التطبيق:** RPC يعيد خطأ/رمي/payload مشوّه → الخدمة `status:"error"`
  (fallback L835-840) → `assert` يرمي **SAVE_FAILED** (fail-closed) ✓ — واختبارات E تثبته على
  المسارات الثلاثة.
- **فشل على مستوى القاعدة:** إن رمت `plan_feature_limit` نفسها → الstatement يرمي → **لا commit**
  (fail-closed بنيويًا) ✓.

### 2.6 الصلاحيات والأمان
- الدوال الثلاث: `security definer` + `set search_path = public` (L64-65, L143-144, L194-195) ✓
  (لا سطح هجوم pg_temp).
- `revoke all ... from public, anon, authenticated` + `grant execute ... to service_role`
  (L122-123, L183-184, L217-218) — و**زوج revoke/grant الـ feature_capacity_status مطابق
  حرفيًا لما نفّذته 20261121 نفسها (L581-582)** → لا تغيّر حالة صلاحيات سابقة (لم يكن لأي دور
  آخر execute). ✓
- ملاحظة (إعلامية I4): `grant execute` على دالة الtrigger نفسها غير ضروري (الtrigger لا يستخدم
  EXECUTE المدعو) — ضارّ بلا، وموحد مع أسلوب بقية الهجرات.

---

## 3) توافق `20261123` مع الهجرات الثلاث السابقة (نقطة 3)

| الفحص | الدليل | النتيجة |
|---|---|---|
| الترتيب | تعليق L14-17: بعد 20261112/20261120/20261121 | ✓ |
| الاعتماد `plan_feature_limit(uuid,text)` | 20261121 L220-221 (definer + grants) | موجود وغير معدَّل |
| الاعتماد `billing_plans.feature_limits` + البذور | 20261120 L88/90/92: `"saved_applications": 3 / 200 / 500` | مطابقة لكتالوج `COMMERCIAL_PLANS` (اختبار anchor يثبّتها) |
| نوع الحصة `items` | 20261121 L189 `when 'saved_applications' then 'items'` | متسق (بلا reset) |
| إعادة تعريف `feature_capacity_status` | **diff مستوى الدالة**: 3 أسطر فقط — فرع `saved_applications` من `public.applications a` إلى `public.bew_applications ba` + فلتر المحتوى؛ **فرع `saved_opportunities` byte-identical** | ✓ (الدليل: `diff` طُبق على استخلاص الدالة الكاملة من الملفين — خرج 18,19c18,20 فقط) |
| عدم حذف بيانات/صلاحيات | كل DROPs في 20261123: `drop trigger if exists` لـ trigger **إينا** فقط (L125) + rollback-comment (L37-44) | ✓ لا حذف بيانات، لا revoke خارج أزواجنا المطابقة |
| تصادم أسماء مع 20261122 | 20261122 ينشئ `create_mock_checkout`/`complete_mock_checkout` فقط | ✓ لا تصادم |
| rerun-safety | `create table if not exists` / `create or replace` / `drop trigger if exists` / revoke-grant idempotent | ✓ (التحقق العملي الفعلي = Staging §1) |

**النتيجة:** متوافق؛ لا يزيل بيانات أو صلاحيات دون قصد.

---

## 4) مراجعة الاختبارات: تأكيدات، mocks، وتصنيف المحاكاة/PostgreSQL (نقطة 4)

قُرئ `tests/saved-applications-capacity.test.ts` كاملًا من القرص (821 سطرًا) + diff كل الملفات
الاخرى (164 سطرًا في entitlement-service.test.ts، 53 في bew-actions-contract.test.ts، وتصحيحات
mocks الثمانية).

### 4.1 ما هو قوي (مؤكد من القرص)
- **الخدمة الحقيقية غير mock'd** (L4-5): `checkSavedApplicationCapacity`/`assertSavedApplicationCapacity`
  يعملان فعلًا على مستوى المحرك — المحاكاة تحاكي **حدود قاعدة البيانات فقط** (الـ rpc + trigger).
- **محاكاة الـ RPC مطابقة 1:1 لدلالات SQL** (L188-230 مقابل SQL L154-179): استثناء replace،
  unmetered/disabled/exceeded/ok، و`greatest(...,0)` لـ remaining.
- **تأكيدات قاطعة**: `toEqual` كامل على استدعاءات pre-check (L531, L544, L452-457)، لقطات
  byte-identical قبل/بعد الرفض (L597/604, L658/660, L767/770)، `appDeletes === 0` عند كل رفض
  (L603, L682, L769)، العدد النهائي == limit (L718, L747)، رسالة الرفض == `CAPACITY_EXCEEDED`
  حرفيًا (L717, L746)، ورفض تسريب نص RPC الخام (L803-806).
- **السباقات**: كلا pre-checks يمر "ok" ثم **واحد بالضبط** يفوز (L709-718, L740-748) — يثبت أن
  الـ race وُجد فعلًا وأن الخلف الصلب هو الذي قرر.
- **حقن النافذة الحتمي** (B6/B7, L610-648): القرار يُحسب ثم يُمسك (`holdPrecheck`)، كاتب منافس
  يدخل النافذة، ثم يُحرَّر → الرفض يحمل marker الtrigger لا `SAVE_FAILED`.

### 4.2 تصنيف واضح: محاكاة ↔ يحتاج PostgreSQL
**محاكاة (في الذاكرة، خيط واحد) — لا تدّعي إثبات التزامن الحقيقي:**
- وحدة السعة الجديدة بالكامل (HONESTY NOTE صريح L21-27)،
- إضافات entitlement-service (حدود rpc mock'd)،
- إضافات bew-actions-contract (المحرك نفسه mock'd — اختبار حد فعل فقط)،
- perf roundtrips (عدّ RTT بنيوي).

**يحتاج PostgreSQL حقيقي (موكل لوثيقة Staging):**
- تسلسل `FOR UPDATE` الفعلي عبر جلسات متوازية (Probe A/B)،
- RLS/grants الفعلية وexecute-denial،
- rerun-safety الفعلي،
- رؤية MVCC داخل جملة (UPDATE/INSERT متعدد الصفوف)،
- رفض جملة دفعة كاملة (COPY/batch rollback — Probe C)،
- **برهان off-by-one الفعلي** (Probe B).

### 4.3 النتائج المصنّفة (تفاصيل المسار/السطر/الإصلاح في §6)
لم يُعثر على **تأكيد مغلوط** (ادعاء أقوى من ما تثبته المحاكي) — أضعف تأكيد هو i18n (غير فارغ فقط،
وهو النطاق المقصود). المخاطر المسجلة كلها في فئة "ما لا تغطيه المحاكاة" وتم تحديدها صراحة.

---

## 5) الأسرار والتغييرات غير المرتبطة (نقطة 5)

| الفحص | الدليل | النتيجة |
|---|---|---|
| مسح أنماط أسرار (api_key/secret/token/password/bearer/sk-/AKIA/xox/ghp_/JWT) على الـ 19 ملفًا | `grep -nE` على كل الملفات المعدلة + الجديدة | **صفر تطابق** (خلاف مراجع process.env المعروفة غير المعدلة) |
| ملفات الإعداد/الأسرار | `git status`: لا `.env*`، لا `vercel.json`، لا `package.json`، لا workflows | ✓ |
| `createLegacyCampaign` | `src/lib/email-campaigns.ts` **غير في قائمة التغييرات** (`git diff --stat` على المسار = فارغ) | ✓ غير مغيَّر |
| `saved_opportunities` | لا ملف opportunities في التغييرات؛ فرع الدالة في 20261123 **byte-identical** (دليل §3) | ✓ غير مغيَّر |
| بقية الفروق | كل hunk في الـ 17 ملفًا = تسجيل الرمز المستقر + البوابات الثلاث + i18n + mocks/تأكيدات Sعة | ✓ لا شيء خارج النطاق |
| إعادة تشغيل مسارات الـ legacy (أدلة هذه الجولة) | `email-draft-quota` + `email-scheduling` + `email-rate-limit` + `draft-free-workflow` = **4 ملفات / 80 اختبارًا ✓** | أخضر |

---

## 6) قائمة النتائج المصنّفة

**🔴 حرجة (Blocker):** لا شيء.

**🟠 متوسطة:**
| # | المسار/السطر | الدليل | الإصلاح المقترح |
|---|---|---|---|
| M1 | الهجرة 20261123 (كلها) | SQL والتزامن الحقيقي **لم يُختبرا على PostgreSQL** — تحقّق إحصائي + محاكاة مطابقة الدلالات فقط؛ إصلاح off-by-one غير مثبت عمليًا | تنفيذ وثيقة Staging (Probes A–E خاصة) **قبل** merge/deploy؛ لا ادعاء بخلاف ذلك |
| M2 | `src/lib/bewerbung-engine.ts` L672/L697 (saveBewCompanies) | نافذة delete→insert غير ذرية (سابقة لـ F1): رفض الtrigger بعد الحذف يترك الحملة المستبدَلة فارغة (الكمية محمية؛ الكسر في نافذة سباق ضيقة) | مرحلة لاحقة: استبدال بذري (دالة SQL واحدة تحذف وتدرج تحت القفل) أو temp-table swap؛ موثقة حاليًا في اختبار B-save (L641-645) |
| M3 | `src/lib/billing/entitlement-service.ts` (catch حول `createAdminClient()` في `checkSavedApplicationCapacity`) | فرع fallback الخاص بفشل **إنشاء العميل** غير مغطى بالاختبارات (الاختبارات تحقن الفشل على حدود rpc فقط) | إضافة اختبار يجعل `holder.admin` دالة رامية (أو قبول موثق: الفشل نفسه يسقط كل ميزات الاشتراك — نمط موحد في الملف) |

**🟡 منخفضة:**
| # | المسار/السطر | الدليل | الإصلاح المقترح |
|---|---|---|---|
| L1 | `tests/saved-applications-capacity.test.ts` L142-154 | فرع UPDATE في الـ harness لا يراكم العدّ عبر عدة صفوف مطابقة في جملة واحدة (PG الحقيقي يعدّ الصفوف السابقة المطبقة) — لا أثر حاليًا (المحرك يصدر صفًا واحدًا `.eq("id")`) | عدّ running في حلقة update (تطابق فرع insert) لتحصين مستقبل |
| L2 | `tests/saved-applications-capacity.test.ts` L813-819 | i18n: تأكيد "غير فارغ" فقط — جودة الترجمة خارج النطاق | لا شيء (مقبول) |
| L3 | `supabase/migrations/20261123...sql` L122-123 | `grant execute` على دالة الtrigger غير ضروري (الtrigger لا يستخدم EXECUTE المدعو) | اختياري: حذف السطر؛ harmless |
| L4 | `tests/bew-perf-roundtrips.test.ts` L477-547 | عقد RTT صارم ضم قفزة pre-check — أي refactor مستقبلي يغيّر عدد الاستعلامات يجب تحديث الأرقام | نمط قائم في الملف؛ مقبول |

**⚪ معلوماتية / مقبولة عمداً:**
- **I1** — no-op سماحي `assertSavedApplicationCapacity: async () => {}` في 6 suites
  (bew-page-repair, bew-letter-pdf, bew-letter-pdf-cleanup, applicant-profile, bew-email-message,
  bew-send-engine): مقصود وموثق في تعليقات كل ملف (نواياها "fully permissive" لغير السعة)؛
  سلوك السعة مملوك للوحدة المتخصصة. **توصية:** لا يمتد هذا النمط إلى أي suite مستقبلية تلمس
  مسارات الحفظ دون تأكيد سعة.
- **I2** — 4 suites (bew-add-company, bew-add-rows, bew-wizard-navigation, bew-perf-roundtrips)
  تشغّل **الخدمة الحقيقية** بحكم "unmetered" — أقوى طبقة (يسقط فقط بُعد حد الخطة).
- **I3** — انتهاء الاشتراك = بلا قياس (writes تمر): موحّد مع نموذج "expiry → free fallback"
  لكل الميزات (plan_feature_limit NULL)؛ موثق في Matrix Staging.
- **I4** — الكاتِب المنافس في B6/B7/D يُحقن مباشرة في الـ harness (خارج الtrigger) — نمط
  محاكاة جوهري (الكاتب الفائز يسبقنا)؛ التأكيد النهائي `== limit` هو شبكة الأمان.

---

## 7) الخلاصة

- **السلامة البنيوية للمراجعة: سَلبة النتائج الحرجة.** لا أسرار، لا تغييرات خارج النطاق،
  `createLegacyCampaign` و`saved_opportunities` بحالهما، والهجرة متوافقة مع الثلاث السابقة
  ولا تحذف شيئًا.
- **الشرط الوحيد القوي قبل merge:** تنفيذ إجراء Staging (M1) — خاصة Probe B (برهان off-by-one
  الفعلي) وProbes A/C (السباقات الحقيقية). كل ما عداه ملاحظات تحسين مرحلي.
- **حالة المستودع:** كما هو — UNCOMMITTED، HEAD `ec350c0`، **لم يُنشأ commit** ولم يُعدَّل أي
  ملف أثناء هذه المراجعة.

**بانتظار الموافقة** قبل أي تعديل (M3/L1/L3 إن رُغب) أو أي commit.
