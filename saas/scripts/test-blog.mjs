#!/usr/bin/env node
// Проверка блога: посты разбираются, расписание ровное (2 поста каждые 2
// дня), ссылки ведут на существующие посты, будущие посты не попадают на
// сайт раньше срока, текст экранируется.
//
//   node scripts/test-blog.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, readPosts, markdown } from './build-blog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAAS = path.resolve(HERE, '..');
const TAGS = new Set(['Выбор системы', 'Сравнения', 'Законы и кассы', 'Финансы', 'Склад и меню', 'Персонал',
  'Гости и маркетинг', 'Открытие заведения', 'Работа в ZalPOS', 'Кальянные', 'Сезон и праздники']);
const FIRST_DAY = '2026-10-10';

let n = 0;
const check = (name, fn) => { fn(); n++; void name; };
const quiet = { log() {}, warn() {} };

const warnings = [];
const posts = readPosts(undefined, (m) => warnings.push(m));
const slugs = new Set(posts.map((p) => p.slug));

check('все посты разобраны, без пропусков', () => {
  assert.deepEqual(warnings, []);
  assert.ok(posts.length >= 6, `постов: ${posts.length}`);
});

check('заголовки, описания и темы', () => {
  for (const p of posts) {
    assert.ok(p.title.length >= 15 && p.title.length <= 120, `${p.slug}: заголовок ${p.title.length} символов`);
    assert.ok(p.description.length >= 70 && p.description.length <= 200, `${p.slug}: описание ${p.description.length} символов`);
    assert.ok(p.tags.length >= 1, `${p.slug}: нет темы`);
    for (const t of p.tags) assert.ok(TAGS.has(t), `${p.slug}: неизвестная тема «${t}»`);
  }
});

check('расписание: сегодня пачка, дальше по 2 поста каждые 2 дня', () => {
  const byDate = new Map();
  for (const p of posts) byDate.set(p.date, (byDate.get(p.date) || 0) + 1);
  for (const [d, c] of byDate) {
    assert.ok(d >= FIRST_DAY, `${d}: раньше старта блога`);
    if (d === FIRST_DAY) continue;
    assert.equal(c, 2, `${d}: постов ${c}, а нужно 2`);
    const days = Math.round((Date.parse(d) - Date.parse('2026-10-12')) / 86400000);
    assert.ok(days >= 0 && days % 2 === 0, `${d}: не через день`);
  }
});

check('каждый пост: содержание из разделов и ссылки на другие посты', () => {
  for (const p of posts) {
    const h2 = p.body.split('\n').filter((l) => l.startsWith('## ')).length;
    assert.ok(h2 >= 2, `${p.slug}: разделов ${h2}, для содержания нужно от 2`);
    const links = [...p.body.matchAll(/\]\(\/blog\/([a-z0-9-]+)\/\)/g)].map((m) => m[1]);
    assert.ok(links.length >= 1, `${p.slug}: нет ссылок на другие посты`);
    for (const s of links) assert.ok(slugs.has(s), `${p.slug}: ссылка на несуществующий пост ${s}`);
    assert.ok(!/^---$/m.test(p.body), `${p.slug}: строка «---» в тексте`);
  }
});

check('будущие посты не попадают на сайт раньше срока', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-'));
  const day = '2026-12-01';
  const res = build({ today: day, out, log: quiet });
  const visible = posts.filter((p) => p.date <= day).map((p) => p.slug).sort();
  assert.deepEqual([...res.published].sort(), visible);
  const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
  for (const p of posts) {
    const page = path.join(out, 'blog', p.slug, 'index.html');
    if (p.date <= day) {
      assert.ok(fs.existsSync(page), `${p.slug}: нет страницы`);
      assert.ok(sitemap.includes(`/blog/${p.slug}/`), `${p.slug}: нет в sitemap`);
    } else {
      assert.ok(!fs.existsSync(page), `${p.slug}: вышел раньше ${p.date}`);
      assert.ok(!sitemap.includes(`/blog/${p.slug}/`), `${p.slug}: в sitemap раньше срока`);
    }
  }
  // На вышедших страницах нет ссылок на будущие посты.
  for (const slug of res.published) {
    const html = fs.readFileSync(path.join(out, 'blog', slug, 'index.html'), 'utf8');
    for (const m of html.matchAll(/href="\/blog\/([a-z0-9-]+)\/"/g)) {
      assert.ok(res.published.includes(m[1]), `${slug}: ссылка на будущий ${m[1]}`);
    }
  }
  fs.rmSync(out, { recursive: true, force: true });
});

check('страница поста: заголовок, canonical, разметка, кнопка на сайт', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-'));
  build({ today: FIRST_DAY, out, log: quiet });
  const p = posts.find((x) => x.date === FIRST_DAY);
  const html = fs.readFileSync(path.join(out, 'blog', p.slug, 'index.html'), 'utf8');
  assert.ok(html.includes(`<link rel="canonical" href="https://zalpos.ru/blog/${p.slug}/">`));
  assert.ok(html.includes('"@type":"BlogPosting"'));
  assert.ok(html.includes('class="toc"'), 'нет содержания');
  assert.ok(html.includes('Подключить бесплатно'), 'нет кнопки «Подключить бесплатно»');
  assert.ok(/<a class="btn" href="\/">/.test(html), 'кнопка не ведёт на zalpos.ru');
  const index = fs.readFileSync(path.join(out, 'blog', 'index.html'), 'utf8');
  assert.ok(index.includes(`/blog/${p.slug}/`));
  const rss = fs.readFileSync(path.join(out, 'blog', 'rss.xml'), 'utf8');
  assert.ok(rss.startsWith('<?xml') && rss.includes('<rss version="2.0"'));
  fs.rmSync(out, { recursive: true, force: true });
});

check('текст экранируется, чужие ссылки открываются отдельно', () => {
  const ctx = { published: new Set(['a-post']), known: new Set(['a-post']), pending: new Set(), warn() {} };
  const { html } = markdown('Текст <script>alert(1)</script> и [пост](/blog/a-post/), [внешняя](https://example.com) и [будущий](/blog/next-post/)', ctx);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<a href="/blog/a-post/">'));
  assert.ok(html.includes('rel="noopener" target="_blank"'));
  assert.ok(!html.includes('next-post'));
});

check('robots.txt и ключ IndexNow', () => {
  const robots = fs.readFileSync(path.join(SAAS, 'console', 'robots.txt'), 'utf8');
  assert.ok(robots.includes('Sitemap: https://zalpos.ru/sitemap.xml'));
  const key = fs.readdirSync(path.join(SAAS, 'console')).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.ok(key, 'нет файла ключа IndexNow');
  assert.equal(fs.readFileSync(path.join(SAAS, 'console', key), 'utf8').trim(), key.replace('.txt', ''));
});

console.log(`blog: ${n} проверок, постов ${posts.length}`);
