/* Тема приложения курьера: «Как в телефоне» / «Светлая» / «Тёмная».
 * Подключается в <head> без defer — до первой отрисовки, чтобы экран не мигал. */
(function () {
  "use strict";
  var KEY = "zc_theme";
  function read() {
    try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "auto"; } catch (e) { return "auto"; }
  }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
    var dark = mode === "dark" || (mode !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      // Выбрана тема — оба тега показывают её цвет; «как в телефоне» — по своим media.
      var own = metas[i].getAttribute("data-color") || metas[i].getAttribute("content");
      metas[i].setAttribute("data-color", own);
      metas[i].setAttribute("content", mode === "auto" ? own : dark ? "#0B0B0C" : "#F3F0EA");
    }
  }
  window.ZalTheme = {
    get: read,
    set: function (mode) {
      mode = mode === "light" || mode === "dark" ? mode : "auto";
      try { if (mode === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) { /* без памяти — до перезапуска */ }
      apply(mode);
    },
    dark: function () {
      var m = read();
      return m === "dark" || (m !== "light" && !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches));
    },
  };
  apply(read());
})();
