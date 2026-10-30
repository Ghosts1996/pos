#!/usr/bin/env node
// Текст лендинга прямо в index.html: посетитель видит страницу сразу, ещё
// до загрузки кабинета (console.js — сотни килобайт), а поисковики —
// заголовок, возможности и ответы на вопросы без выполнения скриптов.
// Когда кабинет загрузится, он заменит этот текст живой страницей.
//
//   node saas/scripts/prerender-landing.mjs путь/к/index.html
//
// Запускает build-site.sh на копии сайта (не в репозитории). Данные — те же
// массивы, что рисует кабинет: LANDING_FEATURES и FAQ_ITEMS в console.js.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readFaq, esc } from './build-blog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE = path.join(HERE, '..', 'console');

/** Литерал массива из console.js по имени (данные без браузера). */
export function readArray(name, file = path.join(CONSOLE, 'console.js')) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) return [];
  const from = src.indexOf('[', start);
  const end = src.indexOf('\n];', from);
  if (end < 0) return [];
  try {
    const v = vm.runInNewContext(`(${src.slice(from, end + 2)})`, {}, { timeout: 500 });
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

const plain = (s) => esc(String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' '));

export function landingHtml({ features = readArray('LANDING_FEATURES'), faq = readFaq() } = {}) {
  return `<div id="prerender" class="pre">
  <header class="pre-nav"><b class="pre-logo">ZalPOS</b>
    <nav><a href="/blog/">Статьи</a> <a href="/guide/">Инструкция</a> <a href="/faq/">Вопросы</a> <a href="/#/login">Войти</a></nav></header>
  <h1>Касса, в которой персонал разберётся за вечер</h1>
  <p class="pre-lede">Касса и управление заведением для кафе, ресторанов, баров, кофеен, кальянных и тайм-кафе:
  зал, заказы, оплата и фискальные чеки, склад с техкартами, ЕГАИС, смены и зарплата — на планшете или компьютере,
  который у вас уже есть. Приложение гостя с вашим логотипом, заказ со стола, бонусы и брони. Выручку и смену
  владелец смотрит с телефона. 7 дней бесплатно, без процента с продаж.</p>
  <p><a class="pre-cta" href="/#/">Попробовать бесплатно</a></p>
  <h2>Что умеет ZalPOS</h2>
  <div class="pre-grid">
${features.filter((f) => f && f.title).map((f) => `    <section><h3>${plain(f.title)}</h3><p>${plain(f.desc)}</p></section>`).join('\n')}
  </div>
  <h2>Частые вопросы</h2>
${faq.slice(0, 10).map((i) => `  <h3>${plain(i.q)}</h3>\n  <p>${plain(i.a)}</p>`).join('\n')}
  <p class="pre-links"><a href="/blog/">Статьи для владельцев заведений</a> · <a href="/guide/">Инструкция по кассе</a> · <a href="/faq/">Все вопросы</a></p>
</div>`;
}

// Пока кабинет грузится — показываем текст только там, где он к месту:
// главная без входа. Вошедшему (или на других адресах) — привычная крутилка.
const HEAD = `<style id="prerender-css">
.pre{max-width:1080px;margin:0 auto;padding:20px 16px 48px;line-height:1.55}
.pre-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:28px}
.pre-nav nav a{margin-right:14px;color:inherit;opacity:.75;text-decoration:none}
.pre-logo{font-size:22px}
.pre h1{font-size:clamp(30px,5vw,52px);line-height:1.1;margin:0 0 16px}
.pre-lede{font-size:18px;max-width:760px;opacity:.85}
.pre-cta{display:inline-block;padding:12px 22px;border-radius:999px;background:#9A4A2A;color:#fff;text-decoration:none;font-weight:600}
.pre-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px 24px}
.pre h2{margin:40px 0 12px;font-size:26px}
.pre h3{margin:16px 0 4px;font-size:17px}
.pre p{margin:0 0 8px}
.pre-links{margin-top:28px}
html.no-pre .pre{display:none}
html:not(.no-pre) .pre-spin{display:none}
</style>
<script>
(function () {
  var auth = null;
  try { auth = localStorage.getItem('zalAuth:v1'); } catch (e) {}
  var h = location.hash || '';
  if (auth || (h && h !== '#/' && h !== '#') || location.search.indexOf('tgapp') >= 0) document.documentElement.classList.add('no-pre');
})();
</script>`;

/** Вписать текст лендинга в index.html (между метками; повторно — заменить). */
export function prerender(file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<style id="prerender-css">[\s\S]*?<\/script>\n?/, '');
  html = html.replace(/<div id="prerender"[\s\S]*?<\/div>\n<!--\/prerender-->\n?/, '');
  html = html.replace('</head>', `${HEAD}\n</head>`);
  html = html.replace(/<div class="wrap" id="screen">\s*<div class="spinner(?: pre-spin)?"><\/div>/,
    `<div class="wrap" id="screen">\n${landingHtml()}\n<!--/prerender-->\n  <div class="spinner pre-spin"></div>`);
  if (!html.includes('id="prerender"')) throw new Error('в index.html нет <div class="wrap" id="screen"> со спиннером — текст лендинга не вписан');
  fs.writeFileSync(file, html);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error('укажите путь к index.html'); process.exit(2); }
  prerender(file);
  console.log(`ok: текст лендинга вписан в ${file}`);
}
