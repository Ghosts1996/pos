// Палитра гостевого веба из раздела «Брендинг» личного кабинета — ОДНА
// функция на приложение (app.js, кэш в index.html) и страницу стола
// (table.html, подключает этот файл как /app/palette.js), чтобы все три
// места красили одинаково.
//
// Почему не просто «подставить цвета владельца в CSS-переменные», как было
// раньше. Пресеты консоли (PREMIUM_PALETTES в saas/console/console.js) —
// это «фон + текст + основной + второстепенный ТЁМНЫЙ тон», а гостевой веб
// брал второстепенный цвет для суммы бонусов (--gold): на тёмном фоне
// тёмная сумма читалась с контрастом ~1.2:1, то есть её почти не было
// видно ни в одном пресете. Остальные цвета (приглушённый текст, рамки,
// нижнее меню, текст на кнопке) были жёстко рассчитаны на тёмную тему, и
// светлая палитра «Песочный светлый» давала бледные подписи, невидимые
// рамки карточек и тёмно-зелёное меню на светлой странице.
//
// Здесь всё, что видит гость, выводится из фона/текста владельца с
// проверкой контраста по WCAG 2 (та же формула, что и в
// lib/client/theme/kolibri_theme.dart для Android-приложения).
//
// Классический скрипт без import/const — table.html тоже классический и
// рассчитан на старые браузеры Android.
(function () {
  var DEFAULT_BG = '#0E1512';
  var DEFAULT_TEXT = '#EAF3EF';
  var DEFAULT_PRIMARY = '#12B886';
  var DARK_ON_PRIMARY = '#04140E';

  function isHex(c) {
    return typeof c === 'string' && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim());
  }

  function hexToRgb(hex) {
    var h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var num = parseInt(h, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }

  function toHex(rgb) {
    return '#' + rgb.map(function (c) {
      var s = Math.max(0, Math.min(255, Math.round(c))).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  /// t=0 → a, t=1 → b.
  function mix(a, b, t) {
    var A = hexToRgb(a);
    var B = hexToRgb(b);
    return toHex([0, 1, 2].map(function (i) { return A[i] + (B[i] - A[i]) * t; }));
  }

  function luminance(hex) {
    var ch = function (c) {
      var v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    var rgb = hexToRgb(hex);
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
  }

  function contrast(a, b) {
    var la = luminance(a) + 0.05;
    var lb = luminance(b) + 0.05;
    return la > lb ? la / lb : lb / la;
  }

  /// Тот же оттенок, но читаемый на ВСЕХ фонах из backgrounds не хуже
  /// minRatio: сам color, если он уже подходит, иначе шаг за шагом
  /// смешанный с цветом текста.
  function readable(color, backgrounds, text, minRatio) {
    for (var step = 0; step <= 10; step++) {
      var c = step ? mix(color, text, step / 10) : color;
      var ok = backgrounds.every(function (bg) { return contrast(c, bg) >= minRatio; });
      if (ok) return c;
    }
    return text;
  }

  /// branding/config → { vars: {'--bg': …}, appName }.
  function brandPalette(b) {
    b = b || {};
    var bg = isHex(b.backgroundColor) ? b.backgroundColor.trim() : DEFAULT_BG;
    var text = isHex(b.textColor) ? b.textColor.trim() : DEFAULT_TEXT;
    // Слишком похожие фон и текст — откат на дефолтную пару целиком (та же
    // защита, что и в Android-приложении).
    if (contrast(bg, text) < 3.0) { bg = DEFAULT_BG; text = DEFAULT_TEXT; }
    var primary = isHex(b.primaryColor) ? b.primaryColor.trim() : DEFAULT_PRIMARY;
    var light = luminance(bg) > 0.4;

    var surface, surface2, border;
    if (light) {
      // Светлая тема: карточки белее фона, поля ввода и рамки — чуть темнее
      // (осветлять и без того светлый фон — значит получить невидимые рамки).
      surface = mix(bg, '#FFFFFF', 0.55);
      surface2 = mix(bg, text, 0.05);
      border = mix(bg, text, 0.16);
    } else {
      surface = mix(bg, '#FFFFFF', 0.06);
      surface2 = mix(bg, '#FFFFFF', 0.10);
      border = mix(bg, '#FFFFFF', 0.16);
    }
    var surfaces = [bg, surface, surface2];

    // «Золото» — сумма бонусов, прогресс уровня, «доступно бонусов». Берём
    // второстепенный цвет владельца, только если он читается на фоне; иначе
    // основной (он и так фирменный акцент), и лишь в крайнем случае —
    // основной, подтянутый к цвету текста.
    var gold = null;
    [b.secondaryColor, primary].some(function (c) {
      if (!isHex(c)) return false;
      var ok = surfaces.every(function (s) { return contrast(c.trim(), s) >= 3; });
      if (ok) gold = c.trim();
      return ok;
    });
    if (!gold) gold = readable(primary, surfaces, text, 3);

    var rgb = hexToRgb(bg);
    var vars = {
      '--bg': bg,
      '--text': text,
      '--surface': surface,
      '--surface-2': surface2,
      '--border': border,
      '--muted': readable(mix(text, bg, 0.42), surfaces, text, 4.5),
      '--primary': primary,
      '--on-primary': contrast(primary, '#FFFFFF') >= contrast(primary, DARK_ON_PRIMARY) ? '#FFFFFF' : DARK_ON_PRIMARY,
      '--gold': gold,
      '--tabbar-bg': 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.96)',
      '--inset': light ? 'rgba(0,0,0,.05)' : 'rgba(0,0,0,.25)',
    };
    if (isHex(b.accentColor)) vars['--accent'] = b.accentColor.trim();
    return { vars: vars, appName: b.appName || '' };
  }

  function applyBrandPalette(b) {
    var p = brandPalette(b);
    var css = document.documentElement.style;
    Object.keys(p.vars).forEach(function (k) { css.setProperty(k, p.vars[k]); });
    if (p.appName) document.title = p.appName;
    return p;
  }

  window.brandPalette = brandPalette;
  window.applyBrandPalette = applyBrandPalette;
})();
