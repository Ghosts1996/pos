#!/bin/bash
# Задача 19: живы ли адреса API банков для онлайн-оплаты гостей (без реквизитов —
# ждём ответ «неверный логин/подпись», это и подтверждает адрес и метод).
set -u
probe() { # $1 — подпись, $2 — URL, $3 — тело (form) или пусто для GET
  if [ -n "${3:-}" ]; then
    r=$(curl -sS -m 15 -w '\n%{http_code}' -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data "$3" "$2" 2>&1)
  else
    r=$(curl -sS -m 15 -w '\n%{http_code}' "$2" 2>&1)
  fi
  code=$(printf '%s' "$r" | tail -1); body=$(printf '%s' "$r" | sed '$d' | tr -d '\r\n' | cut -c1-220)
  printf '%-34s %s | %s\n' "$1" "$code" "$body"
}
F='userName=probe-api&password=probe&orderNumber=probe1&amount=100&returnUrl=https%3A%2F%2Fzalpos.ru'
probe "sber prod register"      https://securepayments.sberbank.ru/payment/rest/register.do "$F"
probe "sber prod status"        https://securepayments.sberbank.ru/payment/rest/getOrderStatusExtended.do 'userName=probe-api&password=probe&orderId=00000000-0000-0000-0000-000000000000'
probe "sber test register"      https://3dsec.sberbank.ru/payment/rest/register.do "$F"
probe "alfa payment.alfabank"   https://payment.alfabank.ru/payment/rest/register.do "$F"
probe "alfa pay.alfabank"       https://pay.alfabank.ru/payment/rest/register.do "$F"
probe "alfa test alfa.rbsuat"   https://alfa.rbsuat.com/payment/rest/register.do "$F"
probe "alfa test web.rbsuat/ab" https://web.rbsuat.com/ab/rest/register.do "$F"
probe "robokassa OpStateExt"    "https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt?MerchantLogin=probe&InvoiceID=1&Signature=00000000000000000000000000000000"
probe "robokassa Index.aspx"    "https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=probe&OutSum=1.00&InvId=1&SignatureValue=0"
probe "yookassa payments"       https://api.yookassa.ru/v3/payments/probe
probe "tbank GetState"          https://securepay.tinkoff.ru/v2/GetState '{}'
