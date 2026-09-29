-- Первичное хранилище персональных данных в РФ (ч. 5 ст. 18 152-ФЗ).
-- Здесь только то, что относится к ПД: имена, телефоны, email, реквизиты.
-- Бонусы, визиты и прочее остаются в Firestore.
CREATE TABLE IF NOT EXISTS guest_profiles (
  tenant_id   TEXT NOT NULL DEFAULT '',   -- '' = сборка одного заведения; у сети 'chain:<id>'
  uid         TEXT NOT NULL,               -- Firebase Auth uid гостя
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',    -- нормализованный (lib/utils/phone_utils.dart)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, uid)
);

-- Пока ищем гостя по телефону в Firestore (phoneIndex), индекс на будущее.
CREATE INDEX IF NOT EXISTS guest_profiles_phone_idx
  ON guest_profiles (tenant_id, phone) WHERE phone <> '';

-- Контакты из броней и листа ожидания. Документ в Firestore создаётся
-- только после успешной записи сюда.
CREATE TABLE IF NOT EXISTS contact_records (
  tenant_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- 'reservation' | 'waitlist'
  record_id   TEXT NOT NULL,               -- id документа в Firestore
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',    -- uid, от чьего имени записано
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, record_id)
);

-- Владельцы кабинета: email попадает сюда до регистрации в Firebase Auth.
-- Отметки о принятии оферты и согласия — доказательство согласия.
-- firebase_uid проставляется после первого входа.
CREATE TABLE IF NOT EXISTS owner_registrations (
  email               TEXT PRIMARY KEY,           -- в нижнем регистре
  firebase_uid        TEXT NOT NULL DEFAULT '',
  offer_accepted_at   TIMESTAMPTZ,
  pd_consent_at       TIMESTAMPTZ,
  pd_consent_edition  TEXT NOT NULL DEFAULT '',
  ip                  TEXT NOT NULL DEFAULT '',
  user_agent          TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Реквизиты плательщиков по счёту: у ИП ФИО и ИНН — персональные данные.
-- Нужны для чека с ИНН покупателя в «Мой налог».
CREATE TABLE IF NOT EXISTS payer_requisites (
  invoice_id  TEXT PRIMARY KEY,               -- номер счёта (bankInvoices/{id})
  billing_id  TEXT NOT NULL,                  -- заведение или сеть
  payer_type  TEXT NOT NULL,                  -- 'ip' | 'org'
  name        TEXT NOT NULL DEFAULT '',
  inn         TEXT NOT NULL,
  kpp         TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL DEFAULT '',       -- uid владельца
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Схему применяет postgres (setup.sh), поэтому права сервису выдаём явно.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pii_gateway') THEN
    GRANT SELECT, INSERT, UPDATE ON guest_profiles, contact_records, owner_registrations, payer_requisites TO pii_gateway;
    -- «Удалить мои данные» у гостя (kind guest_delete).
    GRANT DELETE ON guest_profiles, contact_records TO pii_gateway;
  END IF;
END
$$;
