#!/usr/bin/env node
// Блог zalpos.ru: обычные HTML-страницы для поисковиков из saas/blog/posts.
//
// Кнопки «Блог» на сайте нет — страницы находят поисковики: по
// /sitemap.xml (он указан в /robots.txt), RSS и уведомлениям IndexNow.
// Пост выходит в свой день: в сборку попадают только посты с датой не
// позже сегодняшней (по Москве). Каждый день сервер пересобирает сайт
// (scripts/blog-publish.sh, cron из update-server.sh) — так новые посты
// публикуются сами, по расписанию в датах.
//
//   node scripts/build-blog.mjs                  — сборка на сегодня
//   node scripts/build-blog.mjs --date=2026-12-01 — как будто сегодня 1 декабря
//   node scripts/build-blog.mjs --all             — все посты (предпросмотр)
//   node scripts/build-blog.mjs --out=DIR         — собрать в другую папку
//   node scripts/build-blog.mjs --indexnow=slug1,slug2 — сообщить поисковикам
//
// Пост — блок в saas/blog/posts/*.md (в одном файле можно несколько):
//
//   ---
//   date: 2026-10-10
//   slug: kak-vybrat-programmu-dlya-kafe
//   title: Как выбрать программу для кафе
//   description: Короткое описание для поиска, до 160 символов.
//   tags: Выбор системы, Открытие заведения
//   ---
//   Текст в Markdown: ## и ### заголовки, абзацы, списки «- » и «1. »,
//   **жирный**, [ссылка](/blog/slug/), таблицы | a | b |, цитаты «> ».
//
// Ссылка на пост, который ещё не вышел, становится обычным текстом —
// битых ссылок на сайте не бывает. Сборка не падает из-за одного
// неудачного поста: он пропускается с предупреждением.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://zalpos.ru';
const BRAND = 'ZalPOS';
const PER_PAGE = 12;
const INDEXNOW_KEY_FILE = /^[0-9a-f]{32}\.txt$/;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAAS = path.resolve(HERE, '..');
const POSTS_DIR = path.join(SAAS, 'blog', 'posts');
const ASSETS_DIR = path.join(SAAS, 'blog');
const CONSOLE = path.join(SAAS, 'console');

// ---------- даты ----------

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря'];

/** Сегодня по Москве, YYYY-MM-DD. */
export function todayMsk(now = new Date()) {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

function humanDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------- текст ----------

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(s) {
  return String(s).toLowerCase().split('').map((c) => (c in TRANSLIT ? TRANSLIT[c] : c)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Неразрывные пробелы: «100 ₽», «в зале», «и т. д.» не разрываются строкой. */
function typo(html) {
  return html
    .replace(/(\d) (₽|%|руб|мин|ч\b|дн|мес|тыс|млн|кг|г\b|мл|л\b)/g, '$1&nbsp;$2')
    .replace(/(^|[\s(«>])(в|во|к|ко|с|со|о|об|у|и|а|но|на|по|за|от|до|из|не|ни|для|при|без|что|как|это|или) /gi, '$1$2&nbsp;')
    .replace(/ — /g, '&nbsp;— ');
}

/** Ссылки и жирный внутри строки; всё остальное — экранированный текст. */
function inline(text, ctx) {
  const parts = [];
  let rest = text;
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) { parts.push(typo(esc(rest))); break; }
    parts.push(typo(esc(rest.slice(0, m.index))));
    if (m[3] !== undefined) {
      parts.push(`<strong>${typo(esc(m[3]))}</strong>`);
    } else {
      const label = typo(esc(m[1]));
      const href = m[2];
      const blog = /^\/blog\/([a-z0-9-]+)\/?$/.exec(href);
      if (blog && !ctx.published.has(blog[1])) {
        // Пост ещё впереди: пока текст, в день выхода станет ссылкой.
        ctx.pending?.add(blog[1]);
        if (!ctx.known?.has(blog[1])) ctx.warn(`ссылка на несуществующий пост ${href}`);
        parts.push(label);
      } else if (blog) {
        parts.push(`<a href="/blog/${blog[1]}/">${label}</a>`);
      } else if (/^https?:\/\//.test(href) || href.startsWith('/') || href.startsWith('#')) {
        const ext = /^https?:\/\//.test(href) && !href.startsWith(SITE);
        parts.push(`<a href="${esc(href)}"${ext ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`);
      } else {
        parts.push(label);
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return parts.join('');
}

/** Небольшой Markdown: заголовки, абзацы, списки, таблицы, цитаты. */
export function markdown(src, ctx) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  const headings = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{2,3} |[-*] |\d+\. |> |\|)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{2,3}) (.+)$/.exec(line))) {
      const level = m[1].length;
      const id = slugify(m[2]).slice(0, 60) || `h${headings.length + 1}`;
      headings.push({ level, id, text: m[2] });
      out.push(`<h${level} id="${id}">${inline(m[2], ctx)}</h${level}>`);
      i++;
    } else if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
      out.push(`<ul>${items.map((t) => `<li>${inline(t, ctx)}</li>`).join('')}</ul>`);
    } else if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, '')); i++; }
      out.push(`<ol>${items.map((t) => `<li>${inline(t, ctx)}</li>`).join('')}</ol>`);
    } else if (/^> /.test(line)) {
      const q = [];
      while (i < lines.length && /^> ?/.test(lines[i]) && lines[i].trim()) { q.push(lines[i].replace(/^> ?/, '')); i++; }
      out.push(`<blockquote><p>${inline(q.join(' '), ctx)}</p></blockquote>`);
    } else if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(/^\|[\s:-]+\|/.test(rows[1] || '') ? 2 : 1).map(cells);
      out.push('<div class="table-wrap"><table><thead><tr>'
        + head.map((c) => `<th>${inline(c, ctx)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>');
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) {
        para.push(lines[i].trim()); i++;
      }
      out.push(`<p>${inline(para.join(' '), ctx)}</p>`);
    }
  }
  return { html: out.join('\n'), headings };
}

// ---------- посты ----------

/** Все посты из папки: [{date, slug, title, description, tags, body, file}]. */
export function readPosts(dir = POSTS_DIR, warn = () => {}) {
  const posts = [];
  if (!fs.existsSync(dir)) return posts;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() !== '---') { i++; continue; }
      const meta = {};
      i++;
      while (i < lines.length && lines[i].trim() !== '---') {
        const m = /^([a-z]+):\s*(.*)$/.exec(lines[i]);
        if (m) meta[m[1]] = m[2].trim();
        i++;
      }
      i++;
      const body = [];
      while (i < lines.length && !(lines[i].trim() === '---' && /^[a-z]+:/.test(lines[i + 1] || ''))) {
        body.push(lines[i]); i++;
      }
      const post = {
        file,
        date: meta.date || '',
        updated: meta.updated || '',
        slug: meta.slug || '',
        title: meta.title || '',
        description: meta.description || '',
        tags: (meta.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
        body: body.join('\n').trim(),
      };
      const problem = !/^\d{4}-\d{2}-\d{2}$/.test(post.date) ? 'нет даты'
        : !/^[a-z0-9-]{3,90}$/.test(post.slug) ? 'неверный slug'
          : !post.title ? 'нет заголовка' : !post.body ? 'нет текста' : '';
      if (problem) { warn(`${file}: пост «${post.title || post.slug}» пропущен — ${problem}`); continue; }
      posts.push(post);
    }
  }
  const seen = new Set();
  return posts.filter((p) => {
    if (seen.has(p.slug)) { warn(`${p.file}: slug ${p.slug} повторяется — второй пропущен`); return false; }
    seen.add(p.slug);
    return true;
  });
}

// ---------- страницы ----------

const CSS_VERSION = () => {
  try { return String(fs.statSync(path.join(ASSETS_DIR, 'blog.css')).size); } catch (_) { return '1'; }
};

function layout({ title, description, canonical, body, ogType = 'website', extraHead = '', noindex = false }) {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="color-scheme" content="light dark">
<script>try{var t=localStorage.getItem('zalpos-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:locale" content="ru_RU">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og-image.png">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="alternate" type="application/rss+xml" title="Блог ${BRAND}" href="${SITE}/blog/rss.xml">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/blog/blog.css?v=${CSS_VERSION()}">
${extraHead}</head>
<body>
<header class="top"><div class="wrap">
  <a class="logo" href="/">${BRAND}</a>
  <nav><a href="/blog/">← <span class="wide">Все статьи</span><span class="narrow">Статьи</span></a><a class="cta-mini" href="/">Подключить бесплатно</a></nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer class="foot"><div class="wrap">
  <p><a href="/">${BRAND}</a> — касса, зал, склад и гости для кафе, ресторанов, баров и лаунжей.</p>
  <p class="muted">Материалы блога носят справочный характер. Законы и цены меняются — сверяйтесь с первоисточниками и консультируйтесь с бухгалтером или юристом.</p>
</div></footer>
</body>
</html>
`;
}

function ldJson(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>\n`;
}

function postCard(p) {
  return `<article class="card">
  <p class="meta"><time datetime="${p.date}">${humanDate(p.date)}</time>${p.tags[0] ? ` · <a href="/blog/tema/${slugify(p.tags[0])}/">${esc(p.tags[0])}</a>` : ''}</p>
  <h2><a href="/blog/${p.slug}/">${typo(esc(p.title))}</a></h2>
  <p>${typo(esc(p.description))}</p>
</article>`;
}

function pager(page, pages, base) {
  if (pages <= 1) return '';
  const href = (n) => (n === 1 ? base : `${base}page/${n}/`);
  const links = [];
  if (page > 1) links.push(`<a rel="prev" href="${href(page - 1)}">← Новее</a>`);
  links.push(`<span>Страница ${page} из ${pages}</span>`);
  if (page < pages) links.push(`<a rel="next" href="${href(page + 1)}">Раньше →</a>`);
  return `<nav class="pager">${links.join('')}</nav>`;
}

const CTA = `<aside class="cta">
  <p>${BRAND} — касса и управление заведением: карта зала, оплата и фискальные чеки, склад, брони, бонусы и приложение гостя. Касса на Android и Windows, кабинет в браузере. 14 дней бесплатно, карта не нужна.</p>
  <a class="btn" href="/">Подключить бесплатно на zalpos.ru</a>
  <a class="btn btn-ghost" href="/#/guide">Как всё устроено</a>
</aside>`;

/** «Читайте также»: заголовок и дата, как список ссылок. */
function relatedBlock(list) {
  return `<section class="related"><p class="block-title">Читайте также</p>${list.map((p) => `
  <a class="rel" href="/blog/${p.slug}/"><span>${typo(esc(p.title))}</span><time datetime="${p.date}">${humanDate(p.date)}</time></a>`).join('')}
</section>`;
}

function readingMinutes(text) {
  return Math.max(2, Math.round(text.split(/\s+/).length / 180));
}

// ---------- сборка ----------

/**
 * Собирает блог в out (по умолчанию saas/console). Возвращает
 * { published, skippedFuture, warnings } — slug'и вышедших постов.
 */
export function build({ today = todayMsk(), all = false, out = CONSOLE, postsDir = POSTS_DIR, log = console } = {}) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); log.warn?.(`блог: ${m}`); };
  const posts = readPosts(postsDir, warn)
    .filter((p) => all || p.date <= today)
    .sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)));
  const known = new Set(readPosts(postsDir).map((p) => p.slug));
  const future = known.size - posts.length;
  const published = new Set(posts.map((p) => p.slug));
  const pending = new Set();

  const blogDir = path.join(out, 'blog');
  fs.rmSync(blogDir, { recursive: true, force: true });
  fs.mkdirSync(blogDir, { recursive: true });
  fs.copyFileSync(path.join(ASSETS_DIR, 'blog.css'), path.join(blogDir, 'blog.css'));
  const write = (rel, html) => {
    const f = path.join(blogDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, html);
  };

  const tags = new Map(); // slug → { name, posts }
  for (const p of posts) {
    for (const t of p.tags) {
      const s = slugify(t);
      if (!tags.has(s)) tags.set(s, { name: t, posts: [] });
      tags.get(s).posts.push(p);
    }
  }

  // Посты.
  for (const p of posts) {
    const ctx = { published, known, pending, warn: (m) => warn(`${p.slug}: ${m}`) };
    let rendered;
    try {
      rendered = markdown(p.body, ctx);
    } catch (e) {
      warn(`${p.slug}: не собрался (${e.message}) — пропущен`);
      continue;
    }
    const related = posts
      .filter((q) => q.slug !== p.slug && q.tags.some((t) => p.tags.includes(t)))
      .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(p.date)) - Math.abs(Date.parse(b.date) - Date.parse(p.date)))
      .slice(0, 4);
    const url = `${SITE}/blog/${p.slug}/`;
    const toc = rendered.headings.filter((h) => h.level === 2);
    const head = ldJson({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.description,
      datePublished: p.date,
      dateModified: p.updated || p.date,
      inLanguage: 'ru-RU',
      mainEntityOfPage: url,
      url,
      image: `${SITE}/og-image.png`,
      keywords: p.tags.join(', '),
      author: { '@type': 'Organization', name: BRAND, url: `${SITE}/` },
      publisher: { '@type': 'Organization', name: BRAND, url: `${SITE}/`, logo: { '@type': 'ImageObject', url: `${SITE}/favicon.png` } },
    }) + ldJson({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: BRAND, item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Блог', item: `${SITE}/blog/` },
        { '@type': 'ListItem', position: 3, name: p.title, item: url },
      ],
    }) + `<meta property="article:published_time" content="${p.date}">\n`
      + (p.updated ? `<meta property="article:modified_time" content="${p.updated}">\n` : '')
      + p.tags.map((t) => `<meta property="article:tag" content="${esc(t)}">\n`).join('');
    const body = `<nav class="crumbs"><a href="/">Главная</a> / <a href="/blog/">Блог</a>${p.tags[0] ? ` / <a href="/blog/tema/${slugify(p.tags[0])}/">${esc(p.tags[0])}</a>` : ''}</nav>
<article class="post">
  <h1>${typo(esc(p.title))}</h1>
  <p class="meta">Опубликовано <time datetime="${p.date}">${humanDate(p.date)}</time> · ${readingMinutes(p.body)} мин чтения${p.updated ? ` · обновлено ${humanDate(p.updated)}` : ''}</p>
${toc.length >= 2 ? `  <nav class="toc" aria-label="Содержание"><p class="block-title">Содержание</p><ol>${toc.map((h) => `<li><a href="#${h.id}">${typo(esc(h.text))}</a></li>`).join('')}</ol></nav>\n` : ''}  <div class="content">
${rendered.html}
  </div>
${p.tags.length ? `  <p class="tags">${p.tags.map((t) => `<a href="/blog/tema/${slugify(t)}/">${esc(t)}</a>`).join('')}</p>\n` : ''}</article>
${related.length ? relatedBlock(related) : ''}
${CTA}`;
    write(`${p.slug}/index.html`, layout({
      title: p.title.length > 55 ? p.title : `${p.title} — блог ${BRAND}`,
      description: p.description,
      canonical: url,
      body,
      ogType: 'article',
      extraHead: head,
    }));
  }

  // Списки: главная блога с листанием и темы.
  const listPages = (list, base, heading, intro, metaTitle) => {
    const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    for (let n = 1; n <= pages; n++) {
      const slice = list.slice((n - 1) * PER_PAGE, n * PER_PAGE);
      const canonical = `${SITE}${n === 1 ? base : `${base}page/${n}/`}`;
      const tagNav = base === '/blog/' && n === 1 && tags.size
        ? `<nav class="topics">${[...tags.entries()].sort((a, b) => b[1].posts.length - a[1].posts.length)
          .map(([s, t]) => `<a href="/blog/tema/${s}/">${esc(t.name)} <span>${t.posts.length}</span></a>`).join('')}</nav>` : '';
      const body = `${base === '/blog/' ? '' : `<nav class="crumbs"><a href="/">${BRAND}</a> / <a href="/blog/">Блог</a></nav>`}
<header class="list-head"><h1>${esc(heading)}${n > 1 ? ` — страница ${n}` : ''}</h1><p>${typo(esc(intro))}</p></header>
${tagNav}
<div class="cards">${slice.map(postCard).join('\n') || '<p>Скоро здесь появятся статьи.</p>'}</div>
${pager(n, pages, base)}`;
      write(`${base.replace(/^\/blog\//, '')}${n === 1 ? '' : `page/${n}/`}index.html`, layout({
        title: n > 1 ? `${metaTitle} — страница ${n}` : metaTitle,
        description: intro,
        canonical,
        body,
      }));
    }
    return pages;
  };
  const blogIntro = 'Статьи для владельцев и управляющих кафе, ресторанов, баров и лаунжей: как выбрать кассу и POS-систему, считать фудкост, вести склад, работать с ЕГАИС и 54-ФЗ, мотивировать персонал и возвращать гостей.';
  const blogPages = listPages(posts, '/blog/', 'Блог ZalPOS', blogIntro, `Блог ${BRAND}: автоматизация кафе и ресторанов`);
  const tagPages = new Map();
  for (const [s, t] of tags) {
    tagPages.set(s, listPages(t.posts, `/blog/tema/${s}/`, t.name,
      `Статьи блога ${BRAND} на тему «${t.name}»: практические советы для кафе, ресторанов, баров и лаунжей.`,
      `${t.name} — блог ${BRAND}`));
  }

  // RSS — последние 50.
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>Блог ${BRAND}</title>
<link>${SITE}/blog/</link>
<description>${esc(blogIntro)}</description>
<language>ru</language>
<atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${posts.slice(0, 50).map((p) => `<item>
<title>${esc(p.title)}</title>
<link>${SITE}/blog/${p.slug}/</link>
<guid isPermaLink="true">${SITE}/blog/${p.slug}/</guid>
<pubDate>${new Date(`${p.date}T07:00:00+03:00`).toUTCString()}</pubDate>
<description>${esc(p.description)}</description>
${p.tags.map((t) => `<category>${esc(t)}</category>`).join('')}
</item>`).join('\n')}
</channel>
</rss>
`;
  write('rss.xml', rss);

  // Карта сайта: главная, блог, посты, темы.
  const latest = posts[0]?.date || today;
  const urls = [{ loc: `${SITE}/`, lastmod: latest, priority: '1.0' }, { loc: `${SITE}/blog/`, lastmod: latest, priority: '0.8' }];
  for (let n = 2; n <= blogPages; n++) urls.push({ loc: `${SITE}/blog/page/${n}/`, lastmod: latest, priority: '0.3' });
  for (const p of posts) urls.push({ loc: `${SITE}/blog/${p.slug}/`, lastmod: p.updated || p.date, priority: '0.7' });
  for (const [s, t] of tags) urls.push({ loc: `${SITE}/blog/tema/${s}/`, lastmod: t.posts[0].date, priority: '0.5' });
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemap);

  // Для автопубликации: какие посты вышли (файл с точкой хостинг не отдаёт).
  fs.writeFileSync(path.join(blogDir, '.published'), [...published].sort().join('\n') + '\n');
  log.log?.(`блог: ${posts.length} постов на ${all ? 'все даты' : today}, впереди ${future}; тем ${tags.size}`
    + (pending.size ? `; ссылок на будущие посты (пока текстом): ${pending.size}` : ''));
  return { published: [...published], future, warnings, tags: [...tagPages.keys()] };
}

/** Сообщает Яндексу и IndexNow-поисковикам о новых страницах. */
export async function pingIndexNow(slugs, { consoleDir = CONSOLE } = {}) {
  const keyFile = fs.readdirSync(consoleDir).find((f) => INDEXNOW_KEY_FILE.test(f));
  if (!keyFile) throw new Error('нет файла ключа IndexNow в saas/console');
  const key = keyFile.replace(/\.txt$/, '');
  const urlList = [`${SITE}/blog/`, ...slugs.map((s) => `${SITE}/blog/${s}/`)];
  const body = JSON.stringify({ host: 'zalpos.ru', key, keyLocation: `${SITE}/${keyFile}`, urlList });
  for (const endpoint of ['https://yandex.com/indexnow', 'https://api.indexnow.org/indexnow']) {
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body });
      console.log(`IndexNow ${endpoint}: ${r.status}`);
    } catch (e) {
      console.log(`IndexNow ${endpoint}: ${e.message}`);
    }
  }
}

// ---------- командная строка ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const ping = arg('indexnow');
  if (ping !== undefined) {
    await pingIndexNow(ping.split(',').map((s) => s.trim()).filter(Boolean));
  } else {
    try {
      build({ today: arg('date') || todayMsk(), all: process.argv.includes('--all'), out: arg('out') ? path.resolve(arg('out')) : CONSOLE });
    } catch (e) {
      // Блог не должен останавливать выкладку сайта.
      console.error(`блог: сборка не удалась — ${e.stack || e}`);
    }
  }
}
