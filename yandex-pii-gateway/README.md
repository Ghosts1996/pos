# PII-шлюз (первичная запись данных гостей в РФ)

Отдельный сервис на Yandex Cloud — первичная запись имени/телефона гостя
(Managed PostgreSQL, физически в РФ), которая затем сама зеркалирует те же
данные в Firestore проекта `hoocah-pos`. Зачем это вообще нужно и что
именно закрывает (а что сознательно не закрывает) — см. docstring
[`PiiGatewayService`](../lib/services/pii_gateway_service.dart) в
Flutter-коде и раздел 7 политики конфиденциальности платформы
(`saas/console/console.js`, `screenLegalPrivacy`).

**Область Phase 1**: только имя и телефон гостя, только в момент, когда
гость сам их сообщает (подтверждение SMS-кода, сохранение профиля в
приложении, форма брони, правка телефона в админском экране «Гости»).
Мид-смена (касса во время оплаты) и коллекции `reservations`/
`discountCards`/`waitlist` со своими независимыми копиями имени/телефона —
не в этой фазе, см. тот же docstring.

## Что я (модель) не могу сделать за вас

Всё ниже требует входа в ВАШ личный аккаунт Yandex Cloud и Firebase — я не
могу выполнить эти шаги из этой сессии физически. Дальше в этом файле —
точные команды, которые нужно выполнить самостоятельно (или прислать мне
готовые значения/креды в сессию, если хотите, чтобы деплой довёл я).

## 1. Создать базу данных

```bash
yc managed-postgresql cluster create \
  --name hookah-pii-gateway \
  --environment production \
  --network-name default \
  --postgresql-version 16 \
  --resource-preset s2.micro \
  --disk-size 10 \
  --disk-type network-ssd \
  --host zone-id=ru-central1-a,subnet-name=default-ru-central1-a

yc managed-postgresql database create \
  --cluster-name hookah-pii-gateway \
  --name guestdb \
  --owner gatewayuser

yc managed-postgresql user create \
  --cluster-name hookah-pii-gateway \
  --name gatewayuser \
  --password '<придумайте пароль>'
```

Примените схему (`schema.sql` в этой папке) — проще всего через `psql`,
подключившись по хосту, который покажет `yc managed-postgresql cluster get
hookah-pii-gateway`:

```bash
psql "host=<хост-из-yc> port=6432 dbname=guestdb user=gatewayuser sslmode=verify-full" \
  -f schema.sql
```

Скачайте корневой сертификат Managed PostgreSQL (актуальный адрес — в
документации Yandex Cloud, раздел Managed Service for PostgreSQL →
«Подключение к кластеру» → SSL/TLS-сертификат; на момент написания это
`https://storage.yandexcloud.net/cloud-certs/CA.pem`, но сверьте перед
использованием — адрес может измениться) и закодируйте в base64:

```bash
base64 -w0 CA.pem > ca.b64.txt
```

## 2. Получить сервисный аккаунт Firebase проекта `hoocah-pos`

Firebase Console → проект `hoocah-pos` → Project settings → Service accounts
→ Generate new private key → скачается JSON. **Это ключ от боевого проекта
приложения — храните как секрет, не коммитьте в репозиторий.**

```bash
base64 -w0 hoocah-pos-service-account.json > firebase.b64.txt
```

## 3. Задеплоить функцию

```bash
cd yandex-pii-gateway
npm install --omit=dev

yc serverless function create --name hookah-pii-gateway

yc serverless function version create \
  --function-name hookah-pii-gateway \
  --runtime nodejs20 \
  --entrypoint index.handler \
  --memory 128m \
  --execution-timeout 10s \
  --source-path . \
  --environment PGHOST=<хост-из-yc> \
  --environment PGPORT=6432 \
  --environment PGDATABASE=guestdb \
  --environment PGUSER=gatewayuser \
  --environment PGPASSWORD='<пароль-с-шага-1>' \
  --environment PGSSLROOTCERT_B64="$(cat ca.b64.txt)" \
  --environment FIREBASE_SERVICE_ACCOUNT_B64="$(cat firebase.b64.txt)"

# Публичный доступ по HTTP — без него мобильное приложение не сможет
# достучаться до функции (авторизация проверяется ВНУТРИ хендлера через
# Firebase ID-токен, см. index.js, а не на уровне Yandex Cloud).
yc serverless function allow-unauthenticated-invoke hookah-pii-gateway

yc serverless function get hookah-pii-gateway
# ... смотрите поле http_invoke_url — это и есть PII_GATEWAY_URL
```

## 4. Прописать URL в сборку приложения

`PII_GATEWAY_URL` — тот же `http_invoke_url` из шага 3. В CI (`.github/
workflows/build-apk.yml`, аналогично уже существующим `--dart-define`)
добавьте:

```
--dart-define=PII_GATEWAY_URL=https://functions.yandexcloud.net/<function-id>
```

Для локальной сборки/отладки — тот же флаг у `flutter run`/`flutter build`.

## Проверка перед боевым использованием

- `node test.smoke.js` — быстрая проверка валидации входа (не требует
  живой базы/Firebase, уже пройдено при написании кода, но стоит повторить
  после любых правок `index.js`).
- Полноценно проверить весь путь (SMS-код → шлюз → Postgres → Firestore →
  касса видит гостя) можно только на реальном стенде — сделайте это
  вручную хотя бы один раз перед тем, как выкатывать сборку с новым
  `PII_GATEWAY_URL` на реальные заведения.
