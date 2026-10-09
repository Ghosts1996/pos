#!/bin/bash
# Задача 21: API банков с корнем Минцифры — какие адреса и методы отвечают
# (без реквизитов ждём «неверный логин», это подтверждает адрес и метод).
set -u
D=$(mktemp -d)
curl -sS -m 20 -o "$D/root.cer" https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer
openssl x509 -inform DER -in "$D/root.cer" -out "$D/root.pem" 2>/dev/null || cp "$D/root.cer" "$D/root.pem"
SYS=/etc/ssl/certs/ca-certificates.crt; [ -f "$SYS" ] || SYS=/etc/pki/tls/certs/ca-bundle.crt
{ cat "$SYS"; echo; cat "$D/root.pem"; echo; } > "$D/bundle.pem"
probe() {
  r=$(curl -sS -m 15 --cacert "$D/bundle.pem" -w '\n%{http_code}' -X POST -H "Content-Type: $4" --data "$3" "$2" 2>&1)
  printf '%-26s %s | %s\n' "$1" "$(printf '%s' "$r" | tail -1)" "$(printf '%s' "$r" | sed '$d' | tr -d '\r\n' | cut -c1-200)"
}
FORM=application/x-www-form-urlencoded
F='userName=probe-api&password=probe&orderNumber=probe1&amount=100&returnUrl=https%3A%2F%2Fzalpos.ru'
S='userName=probe-api&password=probe&orderId=00000000-0000-0000-0000-000000000000'
probe "sber prod register"    https://securepayments.sberbank.ru/payment/rest/register.do "$F" $FORM
probe "sber prod status"      https://securepayments.sberbank.ru/payment/rest/getOrderStatusExtended.do "$S" $FORM
probe "sber test register"    https://3dsec.sberbank.ru/payment/rest/register.do "$F" $FORM
probe "alfa payment.alfabank" https://payment.alfabank.ru/payment/rest/register.do "$F" $FORM
probe "alfa payment status"   https://payment.alfabank.ru/payment/rest/getOrderStatusExtended.do "$S" $FORM
probe "alfa pay.alfabank"     https://pay.alfabank.ru/payment/rest/register.do "$F" $FORM
probe "alfa test rbsuat"      https://alfa.rbsuat.com/payment/rest/register.do "$F" $FORM
probe "tbank GetState"        https://securepay.tinkoff.ru/v2/GetState '{"TerminalKey":"probe","PaymentId":"1","Token":"x"}' application/json
rm -rf "$D"
