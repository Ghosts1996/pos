-- Первичное хранилище персональных данных гостей (имя, телефон) — физически
-- в РФ (PostgreSQL на собственном сервере, см. README.md/setup.sh рядом).
-- См. также раздел 7 политики конфиденциальности платформы (saas/console/console.js,
-- screenLegalPrivacy) о том, зачем это отдельная база, а не ещё одна
-- коллекция в Firestore.
--
-- Область Phase 1: только имя и телефон гостя (clients.name/clients.phone
-- во Flutter-приложении). Остальные поля профиля (бонусы, история визитов,
-- активная сессия, ИИ-квота и т.п.) остаются в Firestore как есть — они не
-- являются персональными данными сами по себе и требуют офлайн-транзакций,
-- которые эта база не обеспечивает.
CREATE TABLE IF NOT EXISTS guest_profiles (
  tenant_id   TEXT NOT NULL DEFAULT '',   -- '' = одно-арендная сборка (см. AppScope.tenantId)
  uid         TEXT NOT NULL,               -- Firebase Auth uid гостя
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',    -- уже нормализованный (см. lib/utils/phone_utils.dart)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, uid)
);

-- Не используется в Phase 1 (поиск по телефону остаётся на стороне
-- Firestore/phoneIndex, см. docstring PiiGatewayService), но готовим на
-- будущее — Phase 2 может захотеть искать по телефону и на этой стороне.
CREATE INDEX IF NOT EXISTS guest_profiles_phone_idx
  ON guest_profiles (tenant_id, phone) WHERE phone <> '';

-- Первичная запись контактов из броней и листа ожидания (имя, телефон).
-- Касса и гостевое приложение сначала пишут сюда (РФ) и только после
-- успешного ответа создают документ брони/очереди в Firestore — так
-- соблюдается требование ст. 18 ч. 5 152-ФЗ о первичной записи в РФ.
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

-- Первичная запись владельцев личного кабинета ZalPOS (ч. 5 ст. 18 152-ФЗ):
-- email попадает сюда, на сервер в РФ, ДО регистрации в Firebase Auth
-- (Google). Здесь же — моменты принятия оферты и согласия на обработку ПД
-- (доказательство согласия). firebase_uid проставляется после первого входа.
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

-- Реквизиты плательщиков по счёту (ИП и организации): у ИП ФИО и ИНН —
-- персональные данные, поэтому сначала сюда (РФ), затем счёт в Firestore
-- (saas-gateway, /createBankInvoice). Нужны для чека с ИНН покупателя в
-- «Мой налог» (ст. 14 закона № 422-ФЗ).
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

-- Схему применяет суперпользователь postgres (setup.sh) — права сервису
-- выдаём явно, иначе он не сможет писать в новые таблицы.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pii_gateway') THEN
    GRANT SELECT, INSERT, UPDATE ON guest_profiles, contact_records, owner_registrations, payer_requisites TO pii_gateway;
    -- Гость удаляет свои данные сам (kind "guest_delete" в server.js).
    GRANT DELETE ON guest_profiles, contact_records TO pii_gateway;
  END IF;
END
$$;
