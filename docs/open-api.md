# Открытый API ZalPOS

API для своих программ заведения: бухгалтерии, сайта, BI-системы, интегратора. Только чтение.

## Ключ

Владелец заведения создаёт ключ: кабинет zalpos.ru → «Настройки» → «Открытый API» → «Создать ключ».
Ключ показывается один раз, его вид — `zp_<12 символов>_<32 символа>`. У точки до 5 активных ключей.
Отозванный ключ перестаёт работать сразу (не позже чем через минуту на всех серверах).

Ключ передаётся в заголовке:

```
Authorization: Bearer zp_XXXXXXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Ключ в адресе запроса не принимается: адреса попадают в журналы.

## Адрес

```
https://pii.zalpos.ru/saas/api/v1/<метод>
```

Ответ — JSON `{ "ok": true, "data": … }`, ошибка — `{ "error": "текст" }` с кодом 400, 401, 403, 404, 405 или 429.

## Методы

| Метод | Что отдаёт |
|---|---|
| `GET /venue` | id, название, код, часовой пояс, тип заведения, id сети |
| `GET /menu` | `categories` (id, name, order, kind) и `items` (id, categoryId, name, price, available, description, weight, weightUnit, imageUrl, vat) |
| `GET /stoplist` | позиции, которые сейчас недоступны: id, name |
| `GET /stock` | остатки склада: id, name, category, unit, quantity, minQuantity, costPrice, active |
| `GET /sales?from=…&to=…` | закрытые чеки за период |
| `GET /shifts?from=…&to=…` | закрытые смены с цифрами Z-отчёта |

### Период

- `from`, `to` — дата `2026-11-01` (сутки по часовому поясу заведения, `to` включительно) или время ISO 8601 с поясом `2026-11-01T06:00:00+03:00` (`to` не включается).
- Без `to` — до текущего момента. Период — не больше 31 дня.

### Страницы

В ответе `/sales` и `/shifts` не больше 500 записей. Если записей больше, в ответе есть `next` — передайте его в следующем запросе как `cursor`, остальные параметры те же. `next: null` — это последняя страница. Записи идут по времени закрытия, без пропусков и повторов.

### Чек (`/sales`)

```json
{
  "id": "…", "openedAt": "2026-11-05T12:00:00.000Z", "closedAt": "2026-11-05T13:10:00.000Z",
  "table": "Стол 3", "guests": 2, "orderType": "hall", "source": null, "employeeId": "…",
  "items": [{ "menuItemId": "…", "name": "Суп", "qty": 2, "price": 350, "total": 700 }],
  "subtotal": 700, "discountPercent": 0, "paid": 700,
  "payments": { "cash": 500, "card": 0, "terminal": 200, "aggregator": 0, "comp": 0 },
  "tips": { "cash": 50, "card": 0 },
  "withoutPayment": false, "training": false, "fiscal": true, "refunded": false, "refundedAt": null
}
```

`orderType`: `hall` (зал), `takeaway`, `delivery`. `training: true` — учебный чек стажёра: без фискального чека и денег, в выручку не входит (пропускайте его при расчётах). У заказа агрегатора ещё есть поля `aggregator` и `aggregatorCommission` (%).

### Смена (`/shifts`)

`id`, `status`, `openedAt`, `closedAt`, `z`: number, salesCount, salesTotal, salesCash, salesCard, salesTerminal, salesAggregator, salesComp, discounts, refundsCount, refundsTotal, refundsCash, refundsCashless, unpaidCount, unpaidTotal, tipsCash, tipsCard, openingCash, deposits, payouts, collections, expectedCash, countedCash, leftCash.

## Персональные данные

В ответах нет имён, телефонов, адресов и пожеланий гостей, а также имён сотрудников. Сотрудник передаётся только как `employeeId`.

## Лимиты

- 120 запросов в минуту на ключ.
- 30 неверных ключей в минуту с одного IP-адреса, после этого адрес ждёт минуту.

## Пример

```bash
curl -H "Authorization: Bearer $ZALPOS_KEY" \
  "https://pii.zalpos.ru/saas/api/v1/sales?from=2026-11-01&to=2026-11-07"
```

## Вебхуки (события сами)

Владелец добавляет адрес в Кабинет · «Настройки» → «Вебхуки» (до 5 на точку) и выбирает события. ZalPOS отправляет `POST` с JSON:

```json
{"id": "evt_…", "type": "order.closed", "createdAt": "2026-11-21T12:00:00.000Z", "venueId": "…", "data": { … }}
```

События и `data`:

| type | data |
|---|---|
| `order.closed` | чек — как в `/sales` |
| `order.refunded` | чек — как в `/sales`, `refunded: true` |
| `shift.closed` | смена — как в `/shifts` |
| `reservation.created`, `reservation.updated` | `id, status, startAt, durationMinutes, guests, tableId, table, source, guestConfirmed, createdAt` |
| `delivery.status` | `id, status, courierStage, courierNo, total, paidOnline, createdAt` |
| `stoplist.changed` | `id, name, available` |
| `stock.low` | `id, name, unit, quantity, minQuantity` |
| `review.created` | `id, rating, text` (телефоны и почты скрыты), `createdAt, sessionId, table, waiter` — без имени гостя |
| `ping` | кнопка «Проверить» в кабинете |

Заголовки: `X-ZalPOS-Event` (тип), `X-ZalPOS-Delivery` (id события — повтор приходит с тем же id, обрабатывайте один раз), `X-ZalPOS-Signature: t=<unix>,v1=<hex>`, где `v1 = HMAC-SHA256(секрет, "<t>.<тело запроса>")`. Секрет (`whsec_…`) показывается один раз при создании. Отбрасывайте запросы, где `t` старше 5 минут.

Ответьте `2xx` за 10 секунд. Иначе повтор через 1 мин, 5 мин, 30 мин, 2 ч, 6 ч; после 20 неудач подряд вебхук выключается, владельцу — сигнал в бот заведения. Адрес — только внешний `https://` (внутренние сети и localhost запрещены). Персональных данных гостей в событиях нет. Учебные чеки (режим «Стажёр») не отправляются.

Проверка подписи (Node.js):

```js
const [t, v1] = sig.split(",").map((x) => x.split("=")[1]);
const ok = crypto.createHmac("sha256", SECRET).update(`${t}.${rawBody}`).digest("hex") === v1
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```
