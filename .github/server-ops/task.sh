#!/bin/bash
# Задача 8: заменить истёкший ключ GitHub (GITHUB_PAT) в /etc/saas-gateway.env
# на секрет SAAS_GITHUB_PAT и перезапустить автообновление приложений.
# NEW_GITHUB_PAT приходит первой строкой stdin из workflow; не печатается.
set -u
if [ -z "${NEW_GITHUB_PAT:-}" ]; then echo "Секрет SAAS_GITHUB_PAT ещё не добавлен в GitHub — ничего не меняю."; exit 0; fi
ENVF=/etc/saas-gateway.env
cp -p "$ENVF" "$ENVF.bak-pat"
grep -v '^GITHUB_PAT=' "$ENVF.bak-pat" > "$ENVF.tmp" && printf 'GITHUB_PAT=%s\n' "$NEW_GITHUB_PAT" >> "$ENVF.tmp"
chmod 600 "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF" && rm -f "$ENVF.bak-pat"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEW_GITHUB_PAT" https://api.github.com/repos/ghosts1996/pos/actions/workflows)
echo "проверка ключа в GitHub: $code (200 — подходит)"
systemctl restart saas-gateway; sleep 3; printf 'saas-gateway: '; systemctl is-active saas-gateway
# Новая раскатка: прежняя стоит на паузе из-за упавших сборок.
cd /opt/saas-gateway && node -e '
const fs=require("fs");const admin=require("firebase-admin");
const line=fs.readFileSync("/etc/saas-gateway.env","utf8").split("\n").find(l=>l.startsWith("FIREBASE_SERVICE_ACCOUNT_B64="));
const sa=JSON.parse(Buffer.from(line.split("=").slice(1).join("=").trim().replace(/^["\x27]|["\x27]$/g,""),"base64").toString());
admin.initializeApp({credential:admin.credential.cert(sa)});
const now=admin.firestore.Timestamp.now();
admin.firestore().doc("platformStatus/appRollout").set({sha:"manual-"+Date.now(),requestedBy:"platform",requestedAt:now,startAfter:now,state:"waiting",pausedReason:null,lastError:null,finishedAt:null})
.then(()=>{console.log("автообновление запущено заново");process.exit(0)}).catch(e=>{console.log("ошибка",e.message);process.exit(0)});'
