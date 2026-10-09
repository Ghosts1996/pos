#!/bin/bash
# Задача 11: колонка адреса доставки в первичной базе ПДн (pii-gateway).
# Добавляется ДО выкладки кода, который в неё пишет. Безопасно: колонка с
# значением по умолчанию, существующие строки не меняются; повтор — без
# ошибок (IF NOT EXISTS).
set -u
sudo -u postgres psql -v ON_ERROR_STOP=1 -d pii_gateway \
  -c "ALTER TABLE contact_records ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';" \
  && echo "contact_records.address: OK"
sudo -u postgres psql -d pii_gateway -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='contact_records' ORDER BY ordinal_position;" | tr '\n' ' '
echo
curl -s -o /dev/null -w "pii health: %{http_code}\n" -m 10 https://pii.zalpos.ru/saas/health
