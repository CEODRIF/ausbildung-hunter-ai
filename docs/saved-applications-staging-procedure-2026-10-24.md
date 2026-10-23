# إجراء اختبار Staging — هجرات حصة `saved_applications` (2026-10-24)

> **مدى المرحلة:** وثيقة إجراء فقط، **لم تُنفَّذ** (لا يوجد PostgreSQL/Supabase في بيئة العمل الحالية).
> **قيود صارمة:** Supabase Staging **مستقل جديد** (ليس نسخة من الإنتاج). **لا يُطبَّق أي شيء على الإنتاج** في هذه المرحلة. لا أسرار تُغيَّر ولا أي إعداد Vercel.

## 0. التمهيد

| العنصر | الملاحظة |
|---|---|
| مشروع Staging | مشروع Supabase جديد قابل للحذف (Supabase CLI أو واجهة المشروع) |
| اتصال مباشر | `export DB="postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres"` (Direct connection، ليس Transaction pooler — نحتاج التزامن الحقيقي) |
| psql | ≥ 14 |
| قاعدة البيانات | إذا كانت Staging جديدة: طبّق هجرات المشروع حتى `20261112000000` (جداول `bew_campaigns`/`bew_applications`) **قبل** الهجرات الأربع أدناه |

## 1. التطبيق بالترتيب (ثم فحص إعادة التشغيل)

```bash
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261120000000_subscription_billing_v2.sql
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261121000000_feature_quotas.sql
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261122000000_mock_checkout_complete.sql
psql "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261123000000_saved_application_capacity.sql
```

- **سبب الترتيب:** `20261120` يضيف `billing_plans.feature_limits` (تقرأه `plan_feature_limit`)؛ `20261121` يبني RPCs الحصص؛ `20261122` RPCs الدفع التجريبي؛ `20261123` (الجديدة) تعيد تعريف `feature_capacity_status` وتضيف trigger + lock table + RPC الاستشاري.
- **فحص Rerun-safety:** أعد تنفيذ كل ملف مرة ثانية على التوالي؛ يجب أن تكتمل كل ثانية **بدون أي خطأ** (كل الأشياء `create or replace` / `if not exists` / `drop trigger if exists`).
- سجّل مخرجات كل تشغيل في التقرير (عدد statements + أي تحذيرات).

## 2. فحوص RLS

```sql
-- 2.1 RLS مفعّل على جدول الأقفال، وبدون أي سياسات
select relname, relrowsecurity
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relname = 'user_capacity_locks';
-- متوقع: user_capacity_locks | t

select * from pg_policies
 where schemaname = 'public' and tablename = 'user_capacity_locks';
-- متوقع: 0 صفوف
```

- **2.2 نفْي anon/authenticated (عبر PostgREST بمفتاح anon):**
```bash
# قراءة — يجب ألا ترجع بيانات (قائمة فارغة أو 401/403)
curl -sS -o /dev/null -w "%{http_code}\n" "$STAGING_URL/rest/v1/user_capacity_locks" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"

# كتابة — يجب أن تفشل (لا صفوف مضافة)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$STAGING_URL/rest/v1/user_capacity_locks" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" -d '{"user_id":"00000000-0000-0000-0000-000000000000"}'

# التحقق المباشر بعد المحاولتين:
psql "$DB" -c "select count(*) from public.user_capacity_locks;"
-- متوقع: لم يتغير (0 في قاعدة نظيفة)
```
- سجّل الأكواد الفعلية (200+قائمة فارغة مقبول مع RLS بدون سياسات؛ 401/403/42501 مقبول أيضًا — المهم: **صفر صفوف مقروءة/مضافة**).

## 3. فحوص الصلاحيات (grants) وdefiner

```sql
\dp public.user_capacity_locks
\sf public.enforce_saved_application_capacity
\sf public.check_saved_application_capacity
\sf public.feature_capacity_status
\sf public.plan_feature_limit
```

المتوقع لكل دالة: `Owner: postgres`، `Security: DEFINER`، `Options: search_path=public`، وEXECUTE فقط لـ `postgres`/`service_role` (لا `anon` ولا `authenticated` ولا `public`).

- **3.1 execute probe بدور غير مسموح:** في جلسة psql بدور `authenticated` (أو أي دور غير service_role/postgres):
```sql
select public.check_saved_application_capacity('<uid>', 1);
-- متوقع: ERROR 42501 (permission denied to function)
```
- **3.2 service_role probe:** بنفس الجلسة السابقة لا يمكن؛ استخدم PostgREST بمفتاح service أو جلسة بدور postgres:
```sql
select public.check_saved_application_capacity('<uid>', 1, null);
-- متوقع: صف واحد (status/plan_limit/used/remaining)
```

## 4. فحوص التزامن الحيّة (البرهان الوحيد الحقيقي لسلوك القفل)

### 4.0 تجهيز المستخدم والحصة
```sql
-- مستخدم اختبار (Supabase admin function ترجع user id)
select auth.admin_create_user('cap-test@example.com');
-- (انسخ الـ uuid الناتج = $UID)

-- اشتراك trial نشط (حصة saved_applications = 3 من بذرة billing_plans)
insert into public.subscriptions (user_id, plan, status, provider, current_period_start, current_period_end)
values ('$UID', 'trial', 'active', 'mock', now(), now() + interval '72 hours');

select public.plan_feature_limit('$UID', 'saved_applications');
-- متوقع: 3

-- حملة واحدة (العمودات: انظر 20261112000000) ثم صفّان بهما محتوى
insert into public.bew_applications (campaign_id, user_id, seq, company_name, company_email, status)
values ('$CAMP', '$UID', 1, 'Seed One GmbH', 'seed1@seed.de', 'pending'),
       ('$CAMP', '$UID', 2, 'Seed Two GmbH', 'seed2@seed.de', 'pending');
```

### 4.1 Probe A — سباق INSERT عند الحد (used = 2 من 3)
افتح **5 جلسات psql متوازية** (أو `for i in 1..5; do psql ... & done`)، كل واحدة:
```sql
insert into public.bew_applications (campaign_id, user_id, seq, company_name, company_email, status)
values ('$CAMP', '$UID', 10$i, 'Racer $i GmbH', 'racer$i@race.de', 'pending');
```
**المتوقع:** نجاح واحد بالضبط، 4 أخطاء `P0001: saved_application_capacity_exceeded`، والعدد النهائي للصفوف ذات المحتوى = **3** (أبدًا 4).

### 4.2 Probe B — سباق UPDATE (empty→content) عند الحد
عدّل التجهيز: used = 2، وأضف 5 صفوف فارغة (seq 20..24). خمس جلسات متوازية:
```sql
update public.bew_applications
   set company_name = 'Fill $i GmbH', company_email = 'fill$i@fill.de'
 where id = '$ROW_i' and user_id = '$UID';
```
**المتوقع:** نجاح واحد بالضبط، 4 أخطاء P0001، النهائي = **3**.
> **مهم:** هذا البرهان يختبر أيضًا إصلاح off-by-one في فرع UPDATE (الترIGGER يرى الصف في حالته القديمة → المعيار `used + 1 > limit`؛ الكود القديم `used > limit` كان سيسمح باثنين → 4 > 3).

### 4.3 Probe C — دفعة INSERT واحدة تتجاوز الحد
used = 2، جلسة واحدة:
```sql
insert into public.bew_applications (campaign_id, user_id, seq, company_name, company_email, status)
values ('$CAMP', '$UID', 30, 'Batch A GmbH', 'ba@b.de', 'pending'),
       ('$CAMP', '$UID', 31, 'Batch B GmbH', 'bb@b.de', 'pending'),
       ('$CAMP', '$UID', 32, 'Batch C GmbH', 'bc@b.de', 'pending');
```
**المتوقع:** P0001 على **الجملة كاملة** → 0 صفوف مضافة (rollback ذري)، النهائي يبقى 3.

### 4.4 Probe D — بلا حد (مستخدم بدون اشتراك)
مستخدم جديد `$UID2` بلا subscription: 10 إدراجات محتوى سريعة → كلها تنجح (سلوك الـ legacy/المجاني محفوظ)، ثم:
```sql
select count(*) from public.user_capacity_locks where user_id = '$UID2';
-- متوقع: 1 (صف القفل يُنشأ قبل قراءة الحد)
```

### 4.5 Probe E — حصة معطّلة (0)
(Staging فقط) `update public.billing_plans set feature_limits = jsonb_set(feature_limits, '{saved_applications}', '0') where plan_id = 'trial';` ثم أي كتابة محتوى → P0001 `(limit disabled)`. أعد القيمة 3 بعد الفحص.

**تسجيل:** لكل Probe — عدد النجاحات، عدد P0001، العدد النهائي، زمن الجدار، وأي deadlock (لا يجب أن يظهر: القفل الصفّي واحد لكل مستخدم).

## 5. قراءة العدادات

```sql
select public.feature_capacity_status('$UID', 'saved_applications');
-- متوقع: {"used": 3, "resets_at": null} (بعد Probes 4.1/4.2)
select public.feature_capacity_status('$UID', 'saved_opportunities');
-- فرع لم يُعدَّل — نفس سلوك 20261121000000
select public.plan_feature_limit('$UID2', 'saved_applications');
-- متوقع: NULL (unmetered)
```

## 6. التدفق من مستوى التطبيق (اختياري لكن موصى به)

- انشر الفرع الحالي على **preview** (Vercel preview / staging) — لا الإنتاج.
- فعّل trial → احفظ 3 شركات → المحاولة الرابعة → رسالة `CAPACITY_EXCEEDED` بالغة الواجهة (de/en/fr/ar) → احذف سجلًا → الحفظ ينجح (إعادة المحاولة).
- تبويبان متوازيان يضيفان الرابع → نجاح واحد فقط.

## 7. التفكيك (Teardown)

```sql
drop trigger if exists bew_applications_enforce_saved_capacity on public.bew_applications;
drop function if exists public.check_saved_application_capacity(uuid, integer, uuid);
drop function if exists public.enforce_saved_application_capacity();
drop function if exists public.feature_capacity_status(uuid, text);
-- أعد نسخة 20261121000000 الأصلية من feature_capacity_status إن لزم
drop table if exists public.user_capacity_locks;
```
ثم: حذف صفّات الاختبار (subscriptions/bew_*/user_capacity_locks) و`auth.delete_user('$UID')` و`('$UID2')`، وحذف مشروع Staging إن كان قابلاً للحذف.

## 8. معايير القبول (Checklist)

- [ ] الهجرات الأربع طُبّقت بالترتيب الصحيح
- [ ] كل هجرة أعيد تنفيذها مرتين بدون خطأ (rerun-safe)
- [ ] `user_capacity_locks`: RLS مفعّل، 0 سياسات، anon/authenticated بلا وصول
- [ ] الدوال الثلاث: `definer`/`postgres`/`search_path=public`/EXECUTE لـ service_role فقط
- [ ] Probe A: بالضبط limit صفًا، والباقي P0001
- [ ] Probe B: نجاح واحد بالضبط (إثبات إصلاح off-by-one)
- [ ] Probe C: الدفعة المرفوضة = 0 صفوف (rollback ذري)
- [ ] Probe D: بلا حد = مرور كامل
- [ ] Probe E: 0 = رفض كل كتابة محتوى
- [ ] `feature_capacity_status` يطابق العدّ الفعلي لـ `bew_applications`
- [ ] لم يُنفَّذ أي شيء على الإنتاج

## 9. ما يثبته هذا الإجراء مقابل ما لا يثبته

| مُثبت فعليًا (في Staging) | غير مُثبت (يبقى وثيقيًا/محاكاة) |
|---|---|
| سلوك SQL الفعلي: trigger + lock + RPC | أي شيء لم يُشغَّل بعد في هذه البيئة |
| التزامن الحقيقي عبر جلسات psql متوازية | تزامن Supabase Pooler (Transaction pooler يولّد سلوكًا مختلفًا — استخدم Direct connection) |
| RLS/grants كما تُطبَّق | سلوك واجهة المستخدم على الإنتاج |
