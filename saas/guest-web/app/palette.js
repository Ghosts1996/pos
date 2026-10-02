// Палитра веб-версии гостя из «Брендинга» — одна на app.js, кэш в
// index.html и table.html, чтобы все красили одинаково.
//
// Цвета владельца напрямую в CSS не подставляем: второстепенный цвет в
// пресетах тёмный и на тёмном фоне почти не виден, а светлые палитры давали
// бледные подписи и невидимые рамки. Всё выводится из фона и текста с
// проверкой контраста WCAG 2, как в lib/client/theme/kolibri_theme.dart.
//
// Классический скрипт без import/const — для старых браузеров Android.
(function () {
  // Гость видит только цвета заведения. Пока брендинг не загружен или
  // владелец какой-то цвет не задал — нейтральная палитра без оттенка
  // (как KolibriColors в lib/client/theme/kolibri_theme.dart), а не цвета
  // ZalPOS.
  var DEFAULT_BG = '#141414';
  var DEFAULT_TEXT = '#F2F2F2';
  var DARK_ON_PRIMARY = '#17110C';

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
    var text = isHex(b.textColor) ? b.textColor.trim() : (luminance(bg) > 0.4 ? '#1A1A1A' : DEFAULT_TEXT);
    // Слишком похожие фон и текст — откат на нейтральную пару целиком (та же
    // защита, что и в Android-приложении).
    if (contrast(bg, text) < 3.0) { bg = DEFAULT_BG; text = DEFAULT_TEXT; }
    // Нет основного цвета — нейтральный: цвет текста заведения.
    var primary = isHex(b.primaryColor) ? b.primaryColor.trim() : text;
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
    var secondary = isHex(b.secondaryColor) ? b.secondaryColor : null;
    [secondary, primary].some(function (c) {
      if (!isHex(c)) return false;
      var ok = surfaces.every(function (s) { return contrast(c.trim(), s) >= 3; });
      if (ok) gold = c.trim();
      return ok;
    });
    if (!gold) gold = readable(primary, surfaces, text, 3);

    var primaryReadable = readable(primary, surfaces, text, 3);
    var muted = readable(mix(text, bg, 0.42), surfaces, text, 4.5);
    // Текст поверх цветной плашки — тёмный или светлый, что контрастнее.
    var onColor = function (c) { return contrast(c, '#FFFFFF') >= contrast(c, DARK_ON_PRIMARY) ? '#FFFFFF' : DARK_ON_PRIMARY; };
    var busy = mix(text, bg, 0.62);
    // Кнопки вызова — цвет «Кнопки» из «Брендинга» (accentColor в кабинете
    // не задаётся и остаётся от настроек по умолчанию — его не берём).
    var accent = isHex(b.buttonColor) ? b.buttonColor.trim() : primary;
    var rgb = hexToRgb(bg);
    var vars = {
      '--bg': bg,
      '--text': text,
      '--surface': surface,
      '--surface-2': surface2,
      '--border': border,
      '--muted': muted,
      '--primary': primary,
      '--on-primary': onColor(primary),
      '--accent': accent,
      '--gold': gold,
      '--on-gold': onColor(gold),
      // Состояния — тоже из цветов заведения: успех — основной цвет,
      // предупреждение — «золото». Красный только у ошибок (app.css).
      '--success': primaryReadable,
      '--warning': gold,
      // Столы на схеме: свободен — основной цвет, скоро освободится —
      // «золото», занят — приглушённый тон текста.
      '--t-free': primary,
      '--t-free-on': onColor(primary),
      '--t-risky': gold,
      '--t-risky-on': onColor(gold),
      '--t-busy': busy,
      '--t-busy-on': onColor(busy),
      '--tabbar-bg': 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.96)',
      '--inset': light ? 'rgba(0,0,0,.05)' : 'rgba(0,0,0,.25)',
    };
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
