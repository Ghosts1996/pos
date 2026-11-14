#!/bin/bash
# Обычное обновление сервера после изменений в коде (от root):
#
#   bash /root/pos-deploy/saas-gateway/update-server.sh
#
# Что делает: веб-версия гостя, saas-gateway (новое демо, оплаты и т.п.),
# pii-gateway со схемой базы, сайт zalpos.ru (на этом сервере; Firebase не
# используется). Сертификаты и nginx не трогает —
# это делает migrate-domain.sh, его хватило запустить один раз.
# То же самое делает автообновление (auto-deploy.sh) после каждого пуша.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
say() { echo; echo "== $*"; }
die() { echo; echo "ОШИБКА: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "запустите от root"

# Полный диск роняет Postgres и не даёт обновиться. При каждом обновлении:
# безопасная уборка мусора (только то, что заново появится само: кэши
# пакетов, старые сжатые журналы, временные файлы старше недели, остатки
# прерванных сборок карты) и отчёт, что занимает место (виден в логе
# обновления). Данные, резервные копии, Docker и nginx не трогаются.
say "Место на диске"
free_mb() { df -Pm / | awk 'NR==2 {print $4}'; }
before_mb=$(free_mb)
echo "свободно: ${before_mb} МБ из $(df -Pm / | awk 'NR==2 {print $2}') МБ"
# Оперативная память и кто её занимает — только показываем: по логу
# обновления видно, хватает ли серверу памяти.
awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} /^SwapTotal:/ {s=$2} /^SwapFree:/ {f=$2}
  END {printf "память: всего %d МБ, доступно %d МБ; swap %d МБ, занято %d МБ\n", t/1024, a/1024, s/1024, (s-f)/1024}' \
  /proc/meminfo 2>/dev/null || true
echo "процессоров: $(nproc 2>/dev/null || echo '?')"
# Служба systemd рядом с процессом — по ней видно, чья это программа.
ps -eo rss=,comm=,unit= --sort=-rss 2>/dev/null | head -n 6 |
  awk '{printf "  %s — %d МБ%s\n", $2, $1/1024, ($3 != "" && $3 != "-" ? " (служба " $3 ")" : "")}' || true
# Сторонние программы в Docker (ZalPOS его не использует) — только названия
# и сколько места занимают; Docker не чистим.
if command -v docker >/dev/null 2>&1; then
  docker ps --format '  контейнер: {{.Names}} ({{.Image}}), {{.Status}}' 2>/dev/null | head -n 10 || true
  docker system df 2>/dev/null | sed 's/^/  docker: /' || true
fi

echo "уборка мусора:"
# Скачанные пакеты apt (ставятся заново из сети при надобности).
apt-get clean >/dev/null 2>&1 || true
# Журнал systemd: не больше 200 МБ и не старше месяца.
journalctl --vacuum-size=200M --vacuum-time=30d >/dev/null 2>&1 || true
# Старые сжатые и прокрученные журналы (logrotate) старше 2 недель.
find /var/log -xdev -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -mtime +14 -delete 2>/dev/null || true
# Свои журналы ZalPOS: больше 50 МБ — оставить последние 5 МБ.
for f in /var/log/zalpos-*.log; do
  [[ -f "$f" ]] || continue
  if (( $(stat -c %s "$f") > 52428800 )); then
    tail -c 5242880 "$f" > "$f.cut" && cat "$f.cut" > "$f" && rm -f "$f.cut"
    echo "  журнал $f укорочен до 5 МБ"
  fi
done
# Кэш npm (пакеты лежат в node_modules, кэш нужен только при установке).
npm cache clean --force >/dev/null 2>&1 || true
# Временные файлы крупнее 1 МБ, которые не открывали больше недели
# (кроме личных папок служб systemd).
find /tmp /var/tmp -xdev -type f -size +1M -atime +7 -not -path '*/systemd-private-*' -delete 2>/dev/null || true
# Старые выключенные версии snap-пакетов (если snap есть).
if command -v snap >/dev/null 2>&1; then
  snap list --all 2>/dev/null | awk '/disabled/ {print $1, $3}' | while read -r n r; do
    snap remove "$n" --revision="$r" >/dev/null 2>&1 && echo "  snap: убрана старая версия $n ($r)"
  done
fi
# Остатки прерванных сборок карты (выгрузки округов, недособранные файлы):
# только если сборка сейчас не идёт — иначе это её рабочие файлы.
# Служба сборки — oneshot: пока работает, её состояние «activating», не «active».
map_running() { [[ "$(systemctl show -p ActiveState --value zalpos-map.service 2>/dev/null)" =~ ^(active|activating|reloading|deactivating)$ ]]; }
if [[ -d /opt/zalpos-maps ]] && ! map_running && ! pgrep -f 'map-build.js' >/dev/null 2>&1; then
  rm -rf /opt/zalpos-maps/work 2>/dev/null || true
  find /opt/zalpos-maps -maxdepth 1 -type f \( -name '*.new' -o -name '*.part' -o -name '*.tmp' -o -name 'dry.pmtiles' \) -delete 2>/dev/null || true
fi
# Старая история git в папке обновления — сжать (сам код не меняется).
git -C "$REPO" gc --auto --quiet 2>/dev/null || true
echo "  освобождено: $(( $(free_mb) - before_mb )) МБ, свободно: $(free_mb) МБ"

echo "что занимает место:"
for d in /opt /var/lib /var/log /usr /root /home /tmp /var/tmp /var/cache /snap /swapfile /swap.img; do
  [[ -e "$d" ]] && du -xsh "$d" 2>/dev/null | awk '{printf "  %s — %s\n", $2, $1}'
done
echo "  внутри /opt:"
du -xhd1 /opt 2>/dev/null | sort -rh | sed -n '2,9p' | awk '{printf "    %s — %s\n", $2, $1}' || true
echo "  внутри /var/lib:"
du -xhd1 /var/lib 2>/dev/null | sort -rh | sed -n '2,7p' | awk '{printf "    %s — %s\n", $2, $1}' || true
echo "  ZalPOS: данные, копии, сборки:"
for d in /opt/saas-gateway/state /opt/saas-gateway/backups /opt/saas-gateway/tenant-builds /opt/saas-gateway/support-uploads /opt/saas-gateway/node_modules /opt/zalpos-maps "$REPO/.git"; do
  [[ -e "$d" ]] && du -xsh "$d" 2>/dev/null | awk '{printf "    %s — %s\n", $2, $1}'
done
echo "  крупные файлы (больше 300 МБ):"
find / -xdev -type f -size +300M -printf '    %p — %s\n' 2>/dev/null |
  awk -F' — ' '{printf "%s — %d МБ\n", $1, $2/1048576}' | head -n 15 || true
echo "  журнал systemd: $(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMGT]B*' | head -n 1 || echo '?')"
old_kernels=$( (dpkg -l 'linux-image-[0-9]*' 2>/dev/null || true) | awk -v cur="$(uname -r)" '/^ii/ && index($2, cur) == 0 {n++} END {print n + 0}')
if (( old_kernels > 1 )); then
  echo "  установлено ядер, кроме текущего: $old_kernels (лишние после перезагрузки убирает: apt-get autoremove --purge)"
fi

say "Веб-версия гостя"
mkdir -p /opt/saas-guest-web
cp -r "$REPO/saas/guest-web/"* /opt/saas-guest-web/
chown -R www-data:www-data /opt/saas-guest-web
echo "ok"

# Общий секрет saas-gateway и pii-gateway: по нему сервер берёт имена и
# телефоны из справочника в РФ сам (Telegram, заказ из приложения).
# Создаётся один раз и дописывается в оба файла настроек; остальные строки
# не трогаем, значение в лог не выводим.
say "Секрет между сервисами"
token=""
for f in /etc/pii-gateway.env /etc/saas-gateway.env; do
  [[ -f "$f" ]] || continue
  v="$(awk -F= '$1 == "PII_INTERNAL_TOKEN" { sub(/^[^=]*=/, ""); last = $0 } END { print last }' "$f")"
  [[ -n "$v" ]] && token="$v"
done
if [[ -z "$token" ]]; then
  token="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "создан"
fi
for f in /etc/pii-gateway.env /etc/saas-gateway.env; do
  [[ -f "$f" ]] || continue
  cur="$(awk -F= '$1 == "PII_INTERNAL_TOKEN" { sub(/^[^=]*=/, ""); last = $0 } END { print last }' "$f")"
  if [[ "$cur" != "$token" ]]; then
    sed -i '/^PII_INTERNAL_TOKEN=/d' "$f"
    # Последняя строка без перевода строки склеилась бы с нашей.
    [[ -s "$f" && -n "$(tail -c1 "$f")" ]] && echo >> "$f"
    printf 'PII_INTERNAL_TOKEN=%s\n' "$token" >> "$f"
    echo "записан в $f"
  fi
done
unset token v cur
echo "ok"

# Ветка сборок (GITHUB_REF). Если указанной ветки на GitHub больше нет
# (переименовали), сборки берутся из той, с которой обновился сервер.
# ls-remote --exit-code: 2 — ветки нет; другие ошибки (сеть, доступ)
# настройку не трогают.
say "Ветка для сборок"
ref="$(awk -F= '$1 == "GITHUB_REF" { sub(/^[^=]*=/, ""); last = $0 } END { print last }' /etc/saas-gateway.env 2>/dev/null || true)"
here="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -n "$ref" && -n "$here" && "$ref" != "$here" ]]; then
  rc=0
  git -C "$REPO" ls-remote --exit-code --heads origin "$ref" >/dev/null 2>&1 || rc=$?
  if [[ $rc -eq 2 ]]; then
    sed -i "s#^GITHUB_REF=.*#GITHUB_REF=$here#" /etc/saas-gateway.env
    echo "ветки $ref нет — сборки из $here"
  fi
fi
unset ref here rc
echo "ok"

say "saas-gateway"
command -v rsync >/dev/null || apt-get install -y rsync >/dev/null
rsync -a --exclude node_modules "$REPO/saas-gateway/" /opt/saas-gateway/
# Инструкция и частые вопросы кабинета — база знаний ИИ-бота поддержки (support-bot.js).
mkdir -p /opt/saas-gateway/kb
cp "$REPO/saas/console/guide.js" /opt/saas-gateway/kb/guide.mjs 2>/dev/null || true
# Правила доступа — их же исполняет собственный сервер данных (data-server.js).
cp "$REPO/saas/firestore.rules" /opt/saas-gateway/kb/firestore.rules 2>/dev/null || true
cp "$REPO/saas/console/console.js" /opt/saas-gateway/kb/console.js 2>/dev/null || true
# Карта кода — что за что отвечает (описания и надписи, без кода и секретов).
node /opt/saas-gateway/build-code-map.js "$REPO" /opt/saas-gateway/kb/code-map.json || true
# Что нового — последние изменения программы, бот поддержки рассказывает о них клиентам.
git -C "$REPO" log -60 --no-merges --date=short --pretty='%ad %s' > /opt/saas-gateway/kb/changes.txt 2>/dev/null || true
git -C "$REPO" rev-parse --short HEAD > /opt/saas-gateway/VERSION 2>/dev/null || true
(cd /opt/saas-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
chown -R saas-gateway:saas-gateway /opt/saas-gateway
systemctl restart saas-gateway
sleep 3
systemctl is-active --quiet saas-gateway || die "saas-gateway не запустился — посмотрите: journalctl -u saas-gateway -n 50"
echo "ok, версия $(cat /opt/saas-gateway/VERSION 2>/dev/null || echo '?')"

if [[ -d /opt/zalpos-site ]]; then
  # Сайт уже на этом сервере (move-site-to-server.sh) — собираем сюда;
  # настройки nginx не трогаем.
  say "Сайт zalpos.ru (этот сервер)"
  if bash "$REPO/saas-gateway/build-site.sh" /opt/zalpos-site; then
    node "$REPO/saas/scripts/build-blog.mjs" --announce --state=/var/lib/zalpos-blog/sitemap-announced || true
  else
    echo "!! сайт не собран — работает прежняя версия; повторите: bash $REPO/saas-gateway/build-site.sh"
  fi
  # Firebase (Google, США) не используется: ни сайт, ни правила базы туда не
  # выкладываются — правила работают на этом сервере (saas/firestore.rules),
  # трансграничной передачи нет. Проверяем только, что домен смотрит сюда.
  here="$(getent ahostsv4 pii.zalpos.ru | awk 'NR==1{print $1}' || true)"
  there="$(getent ahostsv4 zalpos.ru | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  if [[ -n "$here" && -n "$there" && "$there" != "$here " ]]; then
    echo "!! zalpos.ru указывает на: ${there}— а этот сервер: $here."
    echo "!! У регистратора домена (раздел DNS): A-запись «@» и «www» → $here, прочие A-записи удалите."
  fi
else
  say "Сайт zalpos.ru"
  echo "сайт ещё не на этом сервере — перенесите: bash $REPO/saas-gateway/move-site-to-server.sh"
fi

# Блог выходит по расписанию (даты в saas/blog/posts): раз в день в 7:07 по
# Москве сервер собирает его на сегодня и, если вышли новые посты,
# выкладывает сайт и сообщает поисковикам (saas/scripts/blog-publish.sh).
#
# Расписание — таймеры systemd, а не cron: в минимальной Ubuntu на
# сервере cron не установлен, и задачи из /etc/cron.d не запускались.
# timer ИМЯ "OnCalendar" "команда" "описание" [предел времени]
timer() {
  local name="$1" cal="$2" cmd="$3" desc="$4" limit="${5:-1h}"
  cat > "/etc/systemd/system/$name.service" <<UNIT
[Unit]
Description=$desc (создано update-server.sh)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
TimeoutStartSec=$limit
ExecStart=/bin/bash -c '$cmd'
UNIT
  cat > "/etc/systemd/system/$name.timer" <<UNIT
[Unit]
Description=$desc — расписание (создано update-server.sh)

[Timer]
OnCalendar=$cal
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  # Прежняя запись cron — убрать: если cron когда-нибудь поставят, задача не пойдёт дважды.
  rm -f "/etc/cron.d/$name"
  if systemctl daemon-reload && systemctl enable --now "$name.timer" >/dev/null 2>&1; then
    echo "ok: таймер $name.timer ($cal), следующий запуск: $(systemctl show -p NextElapseUSecRealtime --value "$name.timer" 2>/dev/null || echo '?')"
  else
    echo "!! таймер $name.timer не включился — посмотрите: systemctl status $name.timer"
  fi
}

say "Автопубликация блога"
timer zalpos-blog "*-*-* 07:07:00 Europe/Moscow" "/bin/bash $REPO/saas/scripts/blog-publish.sh >> /var/log/zalpos-blog.log 2>&1" "Блог zalpos.ru: новые посты по расписанию"
echo "журнал: /var/log/zalpos-blog.log"

# Зашифрованная копия всех данных в хранилище S3 в другом городе — каждый
# час (offsite-backup.sh). Пока нет /etc/zalpos-offsite.env, скрипт ничего
# не делает, а панель и бот подсказывают, что копия не настроена.
# Сторож: зависшие службы, остановленный nginx, пропавшие файлы сайта,
# истекающие сертификаты, кончающееся место (self-heal.sh). Пишет в журнал
# только то, что сделал.
say "Сторож сервера"
timer zalpos-heal "*:0/2" "/bin/bash $REPO/saas-gateway/self-heal.sh >> /var/log/zalpos-heal.log 2>&1" "Сторож ZalPOS: службы, сайт, сертификаты, диск" 5min
echo "журнал: /var/log/zalpos-heal.log (пишет только о сделанном)"

# Своя карта для курьеров (map-build.js): тайлы OpenStreetMap и граф дорог
# вокруг точек заведений, всё на этом сервере. Раз в сутки ночью, работа идёт
# только при изменениях; тяжёлые шаги — с пределом памяти и низким
# приоритетом. Если карты ещё нет — первая сборка сразу, в фоне (обновление
# её не ждёт). nginx не трогает: карту отдаёт сам шлюз (/saas/map/).
say "Своя карта"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
timer zalpos-map "*-*-* 04:40:00 Europe/Moscow" "nice -n 15 $NODE_BIN $REPO/saas-gateway/map-build.js >> /var/log/zalpos-map.log 2>&1" "Своя карта ZalPOS: тайлы и дороги" 10h
# Сборка — в фоне при каждом обновлении: если районы и версия те же, она
# сразу выходит; добавилась точка или город (демо) — карта дособерётся сама.
# Код карты обновился, а сборка идёт по-старому — перезапустить её: готовые
# города и дороги сохраняются, заново пойдёт только недоделанное.
if map_running; then
  new_code=$(cat "$REPO/saas-gateway/map-build.js" "$REPO/saas-gateway/map-graph.js" "$REPO/saas-gateway/map-districts.js" | sha1sum | cut -d' ' -f1)
  if [[ "$(cat /opt/zalpos-maps/.code 2>/dev/null)" != "$new_code" ]]; then
    echo "код карты обновился — перезапускаю идущую сборку"
    systemctl stop zalpos-map.service 2>/dev/null || true
    # Тяжёлые шаги идут в своих рамках памяти (systemd-run) — их тоже остановить.
    pkill -x osmconvert 2>/dev/null || true
    pkill -x osmfilter 2>/dev/null || true
    pkill -x osmium 2>/dev/null || true
    pkill -x pmtiles 2>/dev/null || true
    pkill -f 'map-graph.js build' 2>/dev/null || true
    pkill -f 'map-districts.js build' 2>/dev/null || true
    rm -f /opt/zalpos-maps/.build.lock
    sleep 2
  fi
fi
systemctl start --no-block zalpos-map.service && echo "сборка карты запущена в фоне (без изменений — сразу выйдет), журнал: /var/log/zalpos-map.log"
[[ -d /opt/zalpos-maps ]] && echo "карта сейчас: $(du -sh /opt/zalpos-maps 2>/dev/null | cut -f1)"

# Защита самой машины: fail2ban для SSH, обновления безопасности, настройки
# ядра, права на папки с данными, закрытые наружу порты баз (server-shield.sh).
# nginx, Docker и вход по SSH не трогает; не вышло — обновление идёт дальше.
say "Защита сервера"
bash "$REPO/saas-gateway/server-shield.sh" || echo "!! защита сервера настроилась не полностью — повторится при следующем обновлении"

say "Копия данных в другом городе"
# Предел 100 минут: зависший запуск systemd остановит сам, и следующий пойдёт.
timer zalpos-offsite "*-*-* *:17:00" "/bin/bash $REPO/saas-gateway/offsite-backup.sh >> /var/log/zalpos-offsite.log 2>&1" "Копия данных ZalPOS в хранилище S3" 100min
if [[ -f /etc/zalpos-offsite.env ]]; then
  chmod 600 /etc/zalpos-offsite.env
  echo "ok: каждый час в :17, журнал: /var/log/zalpos-offsite.log"
else
  echo "не настроено: нет /etc/zalpos-offsite.env (см. начало saas-gateway/offsite-backup.sh)"
fi

if [[ -d /opt/pii-gateway ]]; then
  say "pii-gateway (данные в РФ)"
  rsync -a --exclude node_modules "$REPO/pii-gateway/" /opt/pii-gateway/
  (cd /opt/pii-gateway && npm install --omit=dev --no-audit --no-fund >/dev/null)
  chown -R pii-gateway:pii-gateway /opt/pii-gateway
  # База должна отвечать до применения схемы. Если Postgres остановился
  # (перезагрузка, нехватка памяти), поднимаем его; не вышло — причина
  # будет прямо в логе обновления.
  if ! pg_isready -q; then
    echo "Postgres не отвечает — запускаю"
    systemctl start postgresql || true
    pg_lsclusters -h 2>/dev/null | while read -r ver name _ status _; do
      [[ "$status" == online* ]] || pg_ctlcluster "$ver" "$name" start || true
    done || true
    for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
    if ! pg_isready -q; then
      pg_lsclusters 2>&1 || true
      systemctl --no-pager --full status 'postgresql*' 2>&1 | tail -n 40 || true
      df -h / /var/lib/postgresql 2>&1 || true
      free -m 2>&1 || true
      die "Postgres не запустился — причина выше. Вручную: systemctl start postgresql; journalctl -u 'postgresql*' -n 50"
    fi
    echo "Postgres запущен"
  fi
  (cd / && sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d pii_gateway -f /opt/pii-gateway/schema.sql)
  systemctl restart pii-gateway
  sleep 2
  systemctl is-active --quiet pii-gateway || die "pii-gateway не запустился — посмотрите: journalctl -u pii-gateway -n 50"
  echo "ok"
fi

echo
echo "Готово. Проверка: curl -s https://pii.zalpos.ru/saas/health"
