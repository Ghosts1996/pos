#!/bin/bash
# Задача 20: корневой сертификат Минцифры (Russian Trusted Root CA) — им
# подписаны API Сбера, Альфы и Т-Банка. Скачиваем с Госуслуг, проверяем, что
# он подтверждает цепочки банков, и печатаем PEM (сертификат публичный) —
# шлюз будет доверять ему только в запросах к банкам.
set -u
D=$(mktemp -d)
for n in root sub; do
  curl -sS -m 20 -o "$D/$n.cer" "https://gu-st.ru/content/Other/doc/russian_trusted_${n}_ca.cer" || echo "не скачался $n"
  if openssl x509 -inform DER -in "$D/$n.cer" -out "$D/$n.pem" 2>/dev/null; then :; else cp "$D/$n.cer" "$D/$n.pem"; fi
  echo "== $n"; openssl x509 -in "$D/$n.pem" -noout -subject -issuer -dates -fingerprint -sha256
done
cat /etc/ssl/certs/ca-certificates.crt "$D/root.pem" "$D/sub.pem" > "$D/bundle.pem"
echo "== цепочки банков с этим корнем"
for h in securepay.tinkoff.ru securepayments.sberbank.ru 3dsec.sberbank.ru payment.alfabank.ru pay.alfabank.ru alfa.rbsuat.com; do
  r=$(echo | timeout 15 openssl s_client -connect "$h:443" -servername "$h" -CAfile "$D/root.pem" 2>/dev/null | grep -E "Verify return code" | head -1)
  printf '%-28s %s\n' "$h" "${r:-нет ответа}"
done
probe() {
  r=$(curl -sS -m 15 --cacert "$D/bundle.pem" -w '\n%{http_code}' -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data "$3" "$2" 2>&1)
  code=$(printf '%s' "$r" | tail -1); body=$(printf '%s' "$r" | sed '$d' | tr -d '\r\n' | cut -c1-200)
  printf '%-26s %s | %s\n' "$1" "$code" "$body"
}
F='userName=probe-api&password=probe&orderNumber=probe1&amount=100&returnUrl=https%3A%2F%2Fzalpos.ru'
echo "== API банков"
probe "sber prod register"    https://securepayments.sberbank.ru/payment/rest/register.do "$F"
probe "sber prod status"      https://securepayments.sberbank.ru/payment/rest/getOrderStatusExtended.do 'userName=probe-api&password=probe&orderId=x'
probe "sber test register"    https://3dsec.sberbank.ru/payment/rest/register.do "$F"
probe "alfa payment.alfabank" https://payment.alfabank.ru/payment/rest/register.do "$F"
probe "alfa pay.alfabank"     https://pay.alfabank.ru/payment/rest/register.do "$F"
probe "alfa test rbsuat"      https://alfa.rbsuat.com/payment/rest/register.do "$F"
r=$(curl -sS -m 15 --cacert "$D/bundle.pem" -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"TerminalKey":"probe","PaymentId":"1","Token":"x"}' https://securepay.tinkoff.ru/v2/GetState 2>&1)
printf '%-26s %s | %s\n' "tbank GetState" "$(printf '%s' "$r" | tail -1)" "$(printf '%s' "$r" | sed '$d' | tr -d '\r\n' | cut -c1-200)"
echo "== PEM root"; cat "$D/root.pem"
echo "== PEM sub"; cat "$D/sub.pem"
echo "== node: есть ли в системе NODE_EXTRA_CA_CERTS"; systemctl show saas-gateway -p Environment | sed 's/=.*KEY[^ ]*/=***/g' | cut -c1-200
rm -rf "$D"
