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

/** Значение const-выражения из console.js (const NAME = …;) — без браузера. */
function readExpr(src, head, endMark, ctx = {}, keep = endMark.length) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  const from = at + head.length;
  const end = src.indexOf(endMark, from);
  if (end < 0) return null;
  try { return vm.runInNewContext(`(${src.slice(from, end + keep)})`, ctx, { timeout: 500 }); } catch (_) { return null; }
}

/** Кусок шаблона лендинга из console.js между метками — тем же HTML, что
 *  рисует кабинет, с подставленными значками. null — разметка разошлась. */
function heroFromConsole(file = path.join(CONSOLE, 'console.js')) {
  const src = fs.readFileSync(file, 'utf8');
  const LI = readExpr(src, 'const LI = ', '\n})();', {}, 5);
  const THEME_ICONS = readExpr(src, 'const THEME_ICONS = ', '`;\n', {}, 1);
  if (!LI || !THEME_ICONS) return null;
  const a = src.indexOf('    <nav class="landing-nav">');
  const b = src.indexOf('    <section class="l-proof"');
  if (a < 0 || b < a) return null;
  const tpl = src.slice(a, b);
  const ctx = {
    LI,
    themeToggleHtml: () => `<button type="button" class="theme-toggle" aria-label="Сменить тему">${THEME_ICONS}</button>`,
    xborderConsentHtml: () => '',
  };
  try { return vm.runInNewContext('`' + tpl + '`', ctx, { timeout: 500 }); } catch (_) { return null; }
}

// Первый экран — точная копия живой страницы (те же классы и стили
// console.css), поэтому, когда кабинет загрузится и заменит её, на экране
// ничего не дёрнется. Ниже — возможности и вопросы для поисковиков.
export function landingHtml({ features = readArray('LANDING_FEATURES'), faq = readFaq(), hero = heroFromConsole() } = {}) {
  const top = hero || `<h1>Касса, в которой персонал разберётся за вечер</h1>`;
  return `<div id="prerender" class="pre">
${top}
  <section class="landing-section pre-seo" id="pre-features">
    <div class="landing-inner">
      <h2 class="landing-h2">Что умеет ZalPOS</h2>
      <div class="feature-grid">
${features.filter((f) => f && f.title).map((f, i) => `        <div class="feature-card"><div class="feature-no">${String(i + 1).padStart(2, '0')}</div><h3 class="feature-title">${plain(f.title)}</h3><p class="feature-desc">${plain(f.desc)}</p></div>`).join('\n')}
      </div>
    </div>
  </section>
  <section class="landing-section pre-seo">
    <div class="landing-inner">
      <h2 class="landing-h2">Частые вопросы</h2>
${faq.slice(0, 10).map((i) => `      <h3>${plain(i.q)}</h3>\n      <p>${plain(i.a)}</p>`).join('\n')}
      <p class="pre-links"><a href="/blog/">Статьи для владельцев заведений</a> · <a href="/guide/">Инструкция по кассе</a> · <a href="/faq/">Все вопросы</a></p>
    </div>
  </section>
</div>`;
}

// Пока кабинет грузится — показываем текст только там, где он к месту:
// главная без входа. Вошедшему (или на других адресах) — привычная крутилка.
// Пока текст на экране, #screen получает класс landing — как у живой страницы.
const HEAD = `<style id="prerender-css">
.pre-seo h3{margin:18px 0 4px;font-size:17px}
.pre-seo p{margin:0 0 8px}
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

const SCREEN_MARK = `<script>if(!document.documentElement.classList.contains('no-pre'))document.getElementById('screen').classList.add('landing')</script>`;

/** Вписать текст лендинга в index.html (между метками; повторно — заменить). */
export function prerender(file) {
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<style id="prerender-css">[\s\S]*?<\/script>\n?/, '');
  html = html.replace(/<script>if\(!document\.documentElement[^\n]*<\/script>\n/, '');
  html = html.replace(/<div id="prerender"[\s\S]*?<\/div>\n<!--\/prerender-->\n?/, '');
  html = html.replace('</head>', `${HEAD}\n</head>`);
  html = html.replace(/<div class="wrap" id="screen">\s*<div class="spinner(?: pre-spin)?"><\/div>/,
    `<div class="wrap" id="screen">\n${SCREEN_MARK}\n${landingHtml()}\n<!--/prerender-->\n  <div class="spinner pre-spin"></div>`);
  if (!html.includes('id="prerender"')) throw new Error('в index.html нет <div class="wrap" id="screen"> со спиннером — текст лендинга не вписан');
  fs.writeFileSync(file, html);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error('укажите путь к index.html'); process.exit(2); }
  prerender(file);
  console.log(`ok: текст лендинга вписан в ${file}`);
}
