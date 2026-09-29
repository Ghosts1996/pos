// Русская типографика для всего, что рисуют скрипты страницы: короткие
// предлоги и союзы не остаются в конце строки, тире и «·» не начинают
// строку, «ИНН», «№», «ст.» не отрываются от номера, число — от единицы
// («30 дней», «1 200 ₽»). Страницы собираются через innerHTML в десятках
// мест, поэтому правка одна на всё: скрипт следит за изменениями страницы
// и заменяет обычные пробелы неразрывными только в тексте. Код, поля
// ввода и блоки с классом no-typo не трогаются.
//
// Тот же файл — в saas/console и saas/guest-web/app (разные сайты).
(function () {
  var NB = ' ';
  var SP = '[ \\t\\n\\r]+'; // обычные пробелы (не неразрывный)
  var SHORT = new RegExp('(^|[\\s(«„"\\u00a0])([А-Яа-яЁёA-Za-z]{1,2}|№|§)' + SP + '(?=\\S)', 'g');
  var LABEL = new RegExp('(ИНН|ОГРНИП|ОГРН|БИК|КПП|р/с|к/с|ст\\.|п\\.|ч\\.|гл\\.|им\\.|т\\.|г\\.)(:?)' + SP + '(?=[\\dА-Яа-яЁё«])', 'g');
  var THOUSANDS = new RegExp('(\\d)' + SP + '(?=\\d{3}(\\D|$))', 'g');
  var UNIT = new RegExp('(\\d)' + SP + '(?=[А-Яа-яЁёA-Za-z₽%€$])', 'g');
  var DASH = new RegExp(SP + '(—|–|·)', 'g');
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, NOSCRIPT: 1 };
  var SKIP_SEL = 'script,style,textarea,code,pre,kbd,samp,[contenteditable],.no-typo';

  function fix(s) {
    if (s.length < 2 || !/[ \t\n\r]/.test(s) || !/\S/.test(s)) return s;
    var out = s;
    // Цепочки «и в доме» — несколько проходов: соседние короткие слова
    // делят один пробел.
    for (var i = 0; i < 3; i++) {
      var next = out.replace(SHORT, '$1$2' + NB);
      if (next === out) break;
      out = next;
    }
    return out
      .replace(LABEL, '$1$2' + NB)
      .replace(THOUSANDS, '$1' + NB)
      .replace(UNIT, '$1' + NB)
      .replace(DASH, NB + '$1');
  }

  function walk(node) {
    if (node.nodeType === 3) {
      var v = fix(node.data);
      if (v !== node.data) node.data = v;
      return;
    }
    if (node.nodeType !== 1 || SKIP_TAGS[node.nodeName] || node.isContentEditable) return;
    if (node.classList && node.classList.contains('no-typo')) return;
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  function walkRoot(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    if (el && el.closest && el.closest(SKIP_SEL)) return;
    walk(node);
  }

  function start() {
    walkRoot(document.body);
    // Только появление узлов: сами замены (node.data) сюда не попадают,
    // поэтому зацикливания нет.
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var added = list[i].addedNodes;
        for (var j = 0; j < added.length; j++) walkRoot(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
