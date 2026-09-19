-- Первичное хранилище персональных данных гостей (имя, телефон) — физически
-- в РФ (Yandex Managed Service for PostgreSQL). См. README.md рядом и
-- раздел 7 политики конфиденциальности платформы (saas/console/console.js,
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
