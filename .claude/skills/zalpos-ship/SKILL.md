---
name: zalpos-ship
description: Как довести любое изменение ZalPOS до сервера — тесты, коммит от имени владельца, push в production, проверка деплоя и отчёт. Использовать перед каждым коммитом в этом репозитории.
---

# Выпуск изменения в ZalPOS

1. **Тесты.** `cd saas-gateway && npm ci` (если нет node_modules) и `npm test` — должны пройти все наборы.
   Затронут `pii-gateway/` — ещё `cd pii-gateway && npm test`.
   Затронут блог — `node saas/scripts/test-blog.mjs`.
   Затронут Dart (`lib/`, `test/`) — Flutter в песочнице обычно нет: проверка идёт сборкой на GitHub
   (workflow публичной сборки запускает `flutter test`). Пиши аккуратно и только под `kSaasMode` / `AppScope.isSaasMode`.
   Если пакеты не скачиваются (сеть выключена) — честно скажи владельцу, что тесты не запускались;
   код без тестов не коммить, кроме чисто текстовых правок (документы, история).
2. **Проверка на деле.** Кабинет и сайт — стенд `saas-gateway/test-data-harness.js` + Playwright.
   `saas/console/zal-db.js` и `saas/guest-web/app/zal-db.js` должны совпадать байт в байт.
3. **Коммит** — только через переменные окружения, git config не трогать, без строк Co-Authored-By и Claude-Session,
   без названий моделей:
   ```
   GIT_AUTHOR_NAME="Константин Бикоев" GIT_COMMITTER_NAME="Константин Бикоев" \
   GIT_AUTHOR_EMAIL="53391673+Ghosts1996@users.noreply.github.com" \
   GIT_COMMITTER_EMAIL="53391673+Ghosts1996@users.noreply.github.com" \
   git commit -m "Раздел: что изменилось и зачем"
   ```
   Сообщение — по-русски, коротко: что было, что стало.
4. **Push** — только `git push origin HEAD:production`. В `main` никогда. PR #3 не мержить.
   Перед push в мелкой копии: `git fetch origin production`.
5. **Деплой.** Push сам запускает «Обновление сервера» (`server-deploy.yml`). Проверь запуск
   (GitHub MCP `actions_list`), затем версию: `https://pii.zalpos.ru/saas/health` должна вернуть первые
   символы нового коммита. zalpos.ru из песочницы недоступен — снаружи через check-host.net.
6. **Отчёт владельцу** по-русски, просто: что было, что исправил, что проверено, что сделать ему самому.
7. Заметное изменение — одной строкой в `CLAUDE.md` раздел 4.

Нельзя: трогать `.github/workflows/*.yml` без разрешения, `.env`, корневые `functions/` и `public/`,
nginx из `update-server.sh`; печатать ключи; удалять данные сервера.
