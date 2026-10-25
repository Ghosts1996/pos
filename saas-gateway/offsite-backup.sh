#!/bin/bash
# Зашифрованная копия всех данных платформы в хранилище S3 в другом городе.
# Запуск от root: каждый час таймером systemd zalpos-offsite.timer (ставит update-server.sh), вручную —
#
#   bash offsite-backup.sh            копия сейчас
#   bash offsite-backup.sh verify [ключ]  скачать копию (по умолчанию последнюю) и проверить, что она читается
#   bash offsite-backup.sh check      проверить доступ к хранилищу (ключи, бакет, регион)
#   bash offsite-backup.sh list       какие копии лежат в хранилище
#   bash offsite-backup.sh fetch [ключ]  скачать и расшифровать копию в /root/zalpos-restore-…
#
# Настройки — /etc/zalpos-offsite.env (права 600):
#   OFFSITE_S3_ENDPOINT=https://s3.twcstorage.ru
#   OFFSITE_S3_BUCKET=zalpos-backup
#   OFFSITE_S3_REGION=ru-1
#   OFFSITE_S3_ACCESS_KEY=…
#   OFFSITE_S3_SECRET_KEY=…
#   OFFSITE_BACKUP_PASSWORD=…   пароль шифрования: без него копию не прочитать
#                               никому, в том числе хостингу. Храните его и вне сервера.
#
# Что в копии: база заведений (SQLite), вход, поддержка, партнёры и прочее
# из state/, ключи /var/lib/zalpos, файлы окружения сервисов, справочник
# персональных данных (pg_dump). Раз в сутки — ещё логотипы, фото меню и
# вложения поддержки. Хранится, чтобы не захламлять хранилище: ежечасные —
# за сегодня и вчера, суточные — 14 дней, недельные (по понедельникам) —
# 8 недель; общий объём — не больше OFFSITE_MAX_MB (800 МБ).
# Итог последнего запуска — /var/lib/zalpos-offsite/status.json (его видит
# сервер и сообщает в бот поддержки, если копия не уходит).
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

CONF="${OFFSITE_CONF:-/etc/zalpos-offsite.env}"
APP="${OFFSITE_APP_DIR:-/opt/saas-gateway}"
STATUS_DIR="${OFFSITE_STATUS_DIR:-/var/lib/zalpos-offsite}"
STATUS="$STATUS_DIR/status.json"
KEEP_HOURLY_DAYS="${OFFSITE_KEEP_HOURLY_DAYS:-1}"
KEEP_DAILY_DAYS="${OFFSITE_KEEP_DAILY_DAYS:-14}"
KEEP_WEEKLY_DAYS="${OFFSITE_KEEP_WEEKLY_DAYS:-56}"
# Потолок объёма в хранилище: выше — удаляются самые старые копии (кроме
# трёх последних). Тариф 1 ГБ — держимся ниже.
MAX_MB="${OFFSITE_MAX_MB:-800}"
DAILY_HOUR="${OFFSITE_DAILY_HOUR:-03}"
MODE="${1:-backup}"

mkdir -p "$STATUS_DIR"
chmod 755 "$STATUS_DIR"

status() { # status ok|error|off "текст" [ключ] [байт]
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local prev_ok=""
  [[ -f "$STATUS" ]] && prev_ok="$(grep -o '"lastOkAt":"[^"]*"' "$STATUS" | cut -d'"' -f4)"
  local verified=""
  [[ -f "$STATUS" ]] && verified="$(grep -o '"verifiedAt":"[^"]*"' "$STATUS" | cut -d'"' -f4)"
  [[ "$1" == "ok" ]] && prev_ok="$now"
  [[ "$1" == "verified" ]] && verified="$now"
  local state="$1"; [[ "$state" == "verified" ]] && state="ok"
  local msg="${2//\"/\'}"
  printf '{"state":"%s","at":"%s","lastOkAt":"%s","verifiedAt":"%s","key":"%s","bytes":%s,"message":"%s"}\n' \
    "$state" "$now" "$prev_ok" "$verified" "${3:-}" "${4:-0}" "$msg" > "$STATUS.tmp"
  chmod 644 "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}

if [[ ! -f "$CONF" ]]; then
  status off "не настроено: нет $CONF"
  [[ "$MODE" == "backup" ]] && exit 0
  echo "нет $CONF — см. начало этого файла" >&2; exit 1
fi
set -a
# shellcheck disable=SC1090
. "$CONF"
set +a
for v in OFFSITE_S3_ENDPOINT OFFSITE_S3_BUCKET OFFSITE_S3_ACCESS_KEY OFFSITE_S3_SECRET_KEY OFFSITE_BACKUP_PASSWORD; do
  if [[ -z "${!v:-}" ]]; then status error "в $CONF не задано $v"; echo "в $CONF не задано $v" >&2; exit 1; fi
done
REGION="${OFFSITE_S3_REGION:-ru-1}"
BASE="${OFFSITE_S3_ENDPOINT%/}/$OFFSITE_S3_BUCKET"

# S3 — через s3-mini.js (подпись AWS Signature V4 на Node, тот же Node, что
# у сервиса): curl из Ubuntu 22.04 неверно подписывает загрузку файла.
# Отказ хранилища — понятной строкой из его ответа (Code и Message, без ключей).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${OFFSITE_NODE:-/usr/bin/node}"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { status error "нет node"; echo "нет node" >&2; exit 1; }
s3() { # s3 МЕТОД ключ-или-запрос [-T файл] [-o файл]
  local method="$1" path="$2"; shift 2
  local args=()
  while (($#)); do
    case "$1" in
      -T) args+=(--upload "$2"); shift 2 ;;
      -o) args+=(--out "$2"); shift 2 ;;
      *) shift ;;
    esac
  done
  # Предел времени — чтобы обрыв связи не держал блокировку часами.
  timeout 1900 "$NODE" "$SCRIPT_DIR/s3-mini.js" "$method" "$path" "${args[@]}"
}
s3_keys() { # ключи с префиксом
  s3 GET "?list-type=2&prefix=$1" | grep -o '<Key>[^<]*</Key>' | sed -e 's/<Key>//' -e 's#</Key>##'
}

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -pass env:OFFSITE_BACKUP_PASSWORD; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:OFFSITE_BACKUP_PASSWORD; }

latest_key() {
  { s3_keys "hourly/"; s3_keys "daily/"; } | grep '\.tar\.gz\.enc$' | sort -t/ -k2 | tail -1
}

case "$MODE" in
  check)
    # Доступ к хранилищу: список, запись, чтение и удаление пробного файла.
    t="$(mktemp)"; echo "zalpos $(date -u +%FT%TZ)" > "$t"
    s3 GET "?list-type=2&max-keys=1" -o /dev/null && echo "ok: список бакета" || exit 1
    s3 PUT "check/ping.txt" -T "$t" -o /dev/null && echo "ok: запись" || exit 1
    s3 GET "check/ping.txt" -o "$t.got" && cmp -s "$t" "$t.got" && echo "ok: чтение" || exit 1
    s3 DELETE "check/ping.txt" -o /dev/null && echo "ok: удаление" || exit 1
    rm -f "$t" "$t.got"
    exit 0 ;;
  list)
    echo "== ежечасные"; s3_keys "hourly/"
    echo "== суточные"; s3_keys "daily/"
    echo "== недельные"; s3_keys "weekly/"
    exit 0 ;;
  verify)
    key="${2:-$(latest_key)}"
    [[ -n "$key" ]] || { status error "проверка: в хранилище нет копий"; echo "копий нет" >&2; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    if s3 GET "$key" -o "$tmp/c.enc" && decrypt < "$tmp/c.enc" | tar -tz > "$tmp/list" && grep -q 'state/' "$tmp/list"; then
      status verified "проверена: $key ($(wc -l < "$tmp/list") файлов)" "$key" "$(stat -c %s "$tmp/c.enc")"
      echo "ok: $key читается ($(wc -l < "$tmp/list") файлов)"
      exit 0
    fi
    status error "проверка не прошла: $key не скачивается или не расшифровывается" "$key"
    echo "ОШИБКА: $key не прочитать" >&2; exit 1 ;;
  fetch)
    key="${2:-$(latest_key)}"
    [[ -n "$key" ]] || { echo "копий нет" >&2; exit 1; }
    out="/root/zalpos-restore-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$out" && chmod 700 "$out"
    s3 GET "$key" -o "$out/copy.enc" || { echo "не скачать $key" >&2; exit 1; }
    decrypt < "$out/copy.enc" | tar -xz -C "$out" || { echo "не расшифровать — проверьте OFFSITE_BACKUP_PASSWORD" >&2; exit 1; }
    rm -f "$out/copy.enc"
    echo "ok: $key → $out"
    echo "Внутри: state/ (база data.sqlite и *.json → $APP/state), lib-zalpos/ (→ /var/lib/zalpos),"
    echo "env/ (→ /etc), pii.dump (pg_restore -d pii_gateway), uploads/ (если суточная)."
    exit 0 ;;
  backup) ;;
  *) echo "неизвестная команда: $MODE" >&2; exit 2 ;;
esac

# Запуск отмечаем сразу: сервер отличит «cron не запускает скрипт» от
# «скрипт запускается, но копия не уходит».
date -u +%Y-%m-%dT%H:%M:%SZ > "$STATUS_DIR/last-run"
chmod 644 "$STATUS_DIR/last-run"

# Не два запуска сразу (cron и ручной). Прошлый запуск завис дольше 1,5 ч
# (сеть, хранилище) — останавливаем его, иначе копии больше не пойдут.
LOCK=/var/lock/zalpos-offsite.lock
PIDF=/var/lock/zalpos-offsite.pid
exec 8>"$LOCK"
if ! flock -n 8; then
  pid="$(cat "$PIDF" 2>/dev/null || true)"
  started="$(stat -c %Y "$PIDF" 2>/dev/null || echo 0)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && (( $(date +%s) - started > 5400 )); then
    echo "$(date '+%F %T') прошлый запуск (PID $pid) идёт дольше 1,5 ч — останавливаю"
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [[ -n "$pgid" && "$pgid" != "$(ps -o pgid= -p $$ | tr -d ' ')" ]]; then kill -TERM -- "-$pgid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
    sleep 5
    kill -KILL "$pid" 2>/dev/null
    flock -w 60 8 || { status error "прошлый запуск завис и не остановился (PID $pid)"; exit 1; }
  else
    echo "$(date '+%F %T') копия уже делается (PID ${pid:-?})"
    exit 0
  fi
fi
echo $$ > "$PIDF"

hour="$(date +%H)"
day="$(date +%Y-%m-%d)"
daily=0
[[ "$hour" == "$DAILY_HOUR" || "${OFFSITE_FORCE_DAILY:-0}" == "1" ]] && daily=1

work="$(mktemp -d /var/tmp/zalpos-offsite.XXXXXX)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/c/state" "$work/c/env"

# База заведений: согласованный снимок SQLite на ходу (VACUUM INTO), без остановки сервиса.
db="$(grep -E '^DATA_DB_FILE=' /etc/saas-gateway.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
db="${db:-$APP/state/data.sqlite}"
# Снимок — тем же Node (в нём есть node:sqlite); нет — sqlite3 или копия файла.
if [[ -f "$db" ]]; then
  snap="$work/c/state/data.sqlite"
  if [[ -n "$NODE" ]] && "$NODE" -e 'const {DatabaseSync}=require("node:sqlite");new DatabaseSync(process.argv[1]).exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`)' "$db" "$snap" 2>"$work/err"; then
    :
  elif command -v sqlite3 >/dev/null && sqlite3 "$db" ".backup '$snap'" 2>"$work/err"; then
    :
  else
    # Последний способ: копия файла с журналом (на случай, если базу пишут прямо сейчас).
    rm -f "$snap"
    cp -p "$db" "$snap" && for x in -wal -shm; do [[ -f "$db$x" ]] && cp -p "$db$x" "$snap$x"; done
    [[ -f "$snap" ]] || { status error "снимок базы не сделан: $(head -c 200 "$work/err")"; exit 1; }
  fi
fi
# Остальное хранилище сервера — JSON (пишется атомарно: tmp → rename).
find "$APP/state" -maxdepth 1 -type f \( -name '*.json' -o -name '*.active' -o -name '*.own' -o -name '*.done' \) -exec cp -p {} "$work/c/state/" \; 2>/dev/null
[[ -d /var/lib/zalpos ]] && cp -a /var/lib/zalpos "$work/c/lib-zalpos"
for f in /etc/saas-gateway.env /etc/pii-gateway.env; do [[ -f "$f" ]] && cp -p "$f" "$work/c/env/"; done
# Справочник персональных данных (pii-gateway, Postgres).
if command -v pg_dump >/dev/null && timeout 30 sudo -n -u postgres psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw pii_gateway; then
  if ! timeout 1200 sudo -n -u postgres pg_dump -Fc pii_gateway > "$work/c/pii.dump" 2>"$work/err"; then
    status error "pg_dump не прошёл: $(head -c 200 "$work/err")"; exit 1
  fi
fi
if (( daily )); then
  mkdir -p "$work/c/uploads"
  for d in branding-uploads support-uploads; do [[ -d "$APP/$d" ]] && cp -a "$APP/$d" "$work/c/uploads/"; done
fi

key="hourly/$day/$hour.tar.gz.enc"
(( daily )) && key="daily/$day.tar.gz.enc"
echo "$(date '+%F %T') начало: $key"
if ! tar -C "$work/c" -czf - . | encrypt > "$work/copy.enc"; then
  status error "архив не собран"; exit 1
fi
bytes="$(stat -c %s "$work/copy.enc")"
if ! s3 PUT "$key" -T "$work/copy.enc" -o /dev/null 2>"$work/err"; then
  status error "загрузка не удалась: $(head -c 300 "$work/err")" "$key" "$bytes"
  echo "$(date '+%F %T') ОШИБКА загрузки $key: $(head -c 300 "$work/err")" >&2
  exit 1
fi

# Недельная копия — по понедельникам (тот же суточный архив).
if (( daily )) && [[ "$(date +%u)" == "1" ]]; then
  s3 PUT "weekly/$day.tar.gz.enc" -T "$work/copy.enc" -o /dev/null || echo "недельная копия не загрузилась" >&2
fi

# Старые копии — прочь (по дате в имени).
cut_h="$(date -d "-$KEEP_HOURLY_DAYS days" +%Y-%m-%d)"
cut_d="$(date -d "-$KEEP_DAILY_DAYS days" +%Y-%m-%d)"
cut_w="$(date -d "-$KEEP_WEEKLY_DAYS days" +%Y-%m-%d)"
while read -r k; do
  d="$(echo "$k" | cut -d/ -f2)"
  [[ -n "$d" && "$d" < "$cut_h" ]] && s3 DELETE "$k" -o /dev/null
done < <(s3_keys "hourly/" 2>/dev/null)
while read -r k; do
  d="$(basename "$k" .tar.gz.enc)"
  [[ -n "$d" && "$d" < "$cut_d" ]] && s3 DELETE "$k" -o /dev/null
done < <(s3_keys "daily/" 2>/dev/null)
while read -r k; do
  d="$(basename "$k" .tar.gz.enc)"
  [[ -n "$d" && "$d" < "$cut_w" ]] && s3 DELETE "$k" -o /dev/null
done < <(s3_keys "weekly/" 2>/dev/null)
# Потолок объёма: самые старые копии (по времени записи), кроме трёх последних.
listing="$work/listing.xml"
: > "$listing"
for pfx in hourly/ daily/ weekly/; do s3 GET "?list-type=2&prefix=$pfx" >> "$listing" 2>/dev/null; done
"$NODE" -e '
  const xml = require("fs").readFileSync(process.argv[1], "utf8");
  const max = Number(process.argv[2]) * 1048576;
  const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: (m[1].match(/<Key>([^<]*)<\/Key>/) || [])[1],
    at: Date.parse((m[1].match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1] || 0),
    size: Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
  })).filter((x) => x.key).sort((a, b) => a.at - b.at);
  let total = items.reduce((s, x) => s + x.size, 0);
  const removable = items.slice(0, Math.max(0, items.length - 3));
  for (const x of removable) { if (total <= max) break; console.log(x.key); total -= x.size; }
' "$listing" "$MAX_MB" | while read -r k; do s3 DELETE "$k" -o /dev/null && echo "объём выше ${MAX_MB} МБ — удалена старая копия $k"; done

status ok "загружено: $key" "$key" "$bytes"
echo "$(date '+%F %T') ok: $key ($bytes байт)"
# Раз в сутки — проверка, что копию можно скачать и расшифровать.
(( daily )) && bash "$0" verify "$key"
exit 0
