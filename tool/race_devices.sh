#!/bin/bash
# Гонка касс: несколько процессов кассы жмут кнопки по одним чекам в одну
# миллисекунду (tool/local_db_race_device_test.dart). Нужны Flutter и стенд:
#   node saas-gateway/test-data-harness.js 8787 &
#   node tool/race_proxy.js &        # «интернет» одной кассы (8788 → 8787)
#   bash tool/race_devices.sh
# Проверяет: закрытие одного чека с N касс, добавление позиций с N касс,
# закрытие против добавления, открытие чека на свободном столе, касса без
# связи против кассы онлайн.
set -u
N=${N:-3}
cd "$(dirname "$0")/.."
D=$(mktemp -d)
export LOCAL_DB_URL=${LOCAL_DB_URL:-http://127.0.0.1:8787} RACE_DIR=$D
T=tool/local_db_race_device_test.dart
run() { flutter test --dart-define=SAAS_MODE=true $T; }
RACE_ROLE=seed run > $D/seed.log 2>&1 || { tail -30 $D/seed.log; exit 1; }
# Компиляция у каждого процесса ~20–40 с — общий старт с запасом.
START=$(( $(date +%s%3N) + 75000 ))
for i in $(seq 0 $((N-1))); do
  RACE_ROLE=device RACE_DEV=$i RACE_START=$START run > $D/dev$i.log 2>&1 &
done
wait
START=$(( $(date +%s%3N) + 75000 ))
RACE_ROLE=offline RACE_DEV=0 RACE_START=$START LOCAL_DB_URL=http://127.0.0.1:8788 RACE_CUT=http://127.0.0.1:8789/cut run > $D/off0.log 2>&1 &
RACE_ROLE=offline RACE_DEV=1 RACE_START=$START run > $D/off1.log 2>&1 &
wait
RACE_ROLE=verify run > $D/verify.log 2>&1; rc=$?
sed -n '/^{/,/^}/p' $D/verify.log
tail -3 $D/verify.log
echo "журналы: $D"
exit $rc
