"use strict";
// Вычистка персональных данных из текста перед отправкой провайдеру ИИ.
// Провайдеры ИИ (OpenAI, Anthropic, Google, OpenRouter и их посредники)
// работают за рубежом: телефон, почта или номер карты в запросе — это
// трансграничная передача персональных данных, которую платформа не ведёт.
// Поэтому всё, что похоже на телефон, почту, карту, ИНН/СНИЛС/паспорт,
// заменяется пометкой ещё на сервере в РФ. ИИ для советов, сводок отзывов
// и ответов поддержки эти данные не нужны.

const RULES = [
  // Почта.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[почта]"],
  // Номер карты: 13–19 цифр, можно группами через пробел/дефис.
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[номер]"],
  // Российский телефон: +7 / 8 / 7, затем 10 цифр в любом оформлении.
  [/(?:\+7|\b8|\b7)[\s\-().]*\d{3}[\s\-().]*\d{3}[\s\-().]*\d{2}[\s\-().]*\d{2}\b/g, "[телефон]"],
  // Телефон без кода страны: 9XX XXX-XX-XX.
  [/\b9\d{2}[\s\-().]*\d{3}[\s\-().]*\d{2}[\s\-().]*\d{2}\b/g, "[телефон]"],
  // СНИЛС 123-456-789 01, паспорт 12 34 567890, ИНН физлица 12 цифр.
  [/\b\d{3}-\d{3}-\d{3}[ -]?\d{2}\b/g, "[номер]"],
  [/\b\d{2}\s?\d{2}\s?\d{6}\b/g, "[номер]"],
  [/\b\d{12}\b/g, "[номер]"],
];

function scrubText(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  for (const [re, mark] of RULES) out = out.replace(re, mark);
  return out;
}

/** Копия запроса к ИИ, где все строки сообщений вычищены (формат OpenAI и Anthropic). */
function scrubAiPayload(payload) {
  const walk = (v, key) => {
    if (typeof v === "string") return ["model", "role", "type", "tool_choice", "id", "name", "media_type"].includes(key) ? v : scrubText(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        // Картинки (data:/base64) не трогаем — в них не бывает текста-номера.
        o[k] = k === "url" || k === "data" || k === "image_url" ? x : walk(x, k);
      }
      return o;
    }
    return v;
  };
  return walk(payload, "");
}

module.exports = { scrubText, scrubAiPayload };
