-- ---------------------------------------------------------------------------
-- Applicant profile fields (mandatory for NEW Anschreiben PDFs).
--
-- profiles gains five address/contact columns so a generated Anschreiben can
-- carry the full applicant header (name, street, "PLZ City", country,
-- e-mail, phone — the classic German letter layout, top right).
--
-- The columns are NULLABLE at the schema level, on purpose:
--   * existing accounts have no values yet — nothing is back-filled or
--     invented, and no existing row changes shape;
--   * the "all seven mandatory" rule is enforced in the application layer:
--     the settings form (client + server action) and the letter
--     generation/send gates (stable PROFILE_INCOMPLETE / per-row failure).
--
-- Additive and rerunnable (add column if not exists / drop+add the same
-- length CHECKs as the first/last_name pattern in 20261013000000).
-- No trigger changes (the documented bew_campaigns 42703 lesson: profiles
-- already has set_updated_at + protect_profile_system_fields, untouched).
--
-- Apply MANUALLY like every other migration in this repo.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists street text,
  add column if not exists postal_code text,
  add column if not exists city text,
  add column if not exists country text,
  add column if not exists phone text;

alter table public.profiles
  drop constraint if exists profiles_street_length,
  drop constraint if exists profiles_postal_code_length,
  drop constraint if exists profiles_city_length,
  drop constraint if exists profiles_country_length,
  drop constraint if exists profiles_phone_length;

alter table public.profiles
  add constraint profiles_street_length
    check (street is null or char_length(trim(street)) between 1 and 120),
  add constraint profiles_postal_code_length
    check (postal_code is null or char_length(trim(postal_code)) between 1 and 32),
  add constraint profiles_city_length
    check (city is null or char_length(trim(city)) between 1 and 80),
  add constraint profiles_country_length
    check (country is null or char_length(trim(country)) between 1 and 80),
  add constraint profiles_phone_length
    check (phone is null or char_length(trim(phone)) between 1 and 40);
