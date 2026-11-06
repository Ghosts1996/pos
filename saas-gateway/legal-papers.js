"use strict";
/**
 * Бумаги владельцу платформы — сами, по событиям, сразу заполненные:
 * распечатать, подписать, хранить.
 *
 *  * Удалили персональные данные (гость сам, по запросу, по сроку хранения) —
 *    акт об уничтожении и выгрузка из журнала событий: так требуют п. 3, 4
 *    Требований к подтверждению уничтожения ПДн (приказ Роскомнадзора от
 *    28.10.2022 № 179). Хранить 3 года.
 *  * Менеджер-партнёр указал реквизиты для выплат — договор с ним, уже с его
 *    ФИО и ИНН (partner-contract.js).
 *
 * Файл уходит только владельцу: на почту из LEGAL_PAPERS_TO, а если её нет —
 * на почту из реквизитов платформы; копия — на сервере (PAPERS_DIR). Сбой
 * бумаг не мешает самому удалению: ошибка — в журнал, данные всё равно удалены.
 */
const fs = require("fs");
const path = require("path");
const { docx } = require("./support-docs");

const LINE = "________________";
const val = (v, blank = LINE) => (String(v || "").trim() ? String(v).trim() : blank);
const SYSTEM = "Информационная система персональных данных «Платформа ZalPOS» (база данных на сервере Оператора в Российской Федерации)";
const METHOD = "Удаление записей из базы данных средствами программного обеспечения информационной системы без возможности восстановления; резервные копии удаляются по истечении срока их хранения (не более 8 недель), восстановление из них уничтоженных данных не производится";

const msk = (ms) => new Date(ms + 3 * 3600 * 1000);
const dayStr = (ms) => {
  const d = msk(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
};
const timeStr = (ms) => {
  const d = msk(ms);
  return `${dayStr(ms)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} МСК`;
};

/** «ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ ИВАНОВ ИВАН» → «Индивидуальный предприниматель Иванов Иван». */
function operatorName(fullName) {
  const raw = String(fullName || "").trim().replace(/^(ИП|ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ)\s+/i, "");
  if (!raw) return "Индивидуальный предприниматель " + LINE;
  const nice = raw === raw.toUpperCase() ? raw.toLowerCase().replace(/(^|[\s-])([а-яёa-z])/g, (m, s, c) => s + c.toUpperCase()) : raw;
  return /^(ООО|АО|ПАО)(?![А-Яа-яЁё])/.test(raw) ? raw : `Индивидуальный предприниматель ${nice}`;
}
function shortName(fullName) {
  const parts = operatorName(fullName).replace(/^Индивидуальный предприниматель\s+/, "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || LINE;
  return `${parts[0]} ${parts.slice(1).map((p) => `${p[0]}.`).join(" ")}`;
}

/**
 * Акт об уничтожении ПДн + выгрузка из журнала событий.
 * items — [{ subject, categories, processor, at }]; reason — причина.
 */
function destructionActBlocks({ legal = {}, number, at, items, reason }) {
  const l = legal || {};
  const op = `${operatorName(l.fullName)}, ОГРНИП ${val(l.ogrnip)}, ИНН ${val(l.inn)}`;
  const processors = [...new Set(items.map((i) => i.processor).filter(Boolean))];
  const subjects = items.length === 1 ? items[0].subject
    : `${items.length} субъектов персональных данных — перечень в выгрузке из журнала событий ниже`;
  const categories = [...new Set(items.flatMap((i) => i.categories || []))].join(", ");
  return [
    { h: `АКТ № ${number}` },
    { c: "об уничтожении персональных данных" },
    { r: dayStr(at) },
    { table: [
      ["Сведения", "Значение"],
      ["Оператор", op],
      ["Адрес оператора", val(l.address)],
      ["Лица, обрабатывавшие данные по поручению Оператора", processors.length ? processors.join("; ") : "не привлекались"],
      ["Субъект(ы) персональных данных", subjects],
      ["Категории уничтоженных персональных данных", categories || "—"],
      ["Наименование информационной системы", SYSTEM],
      ["Способ уничтожения", METHOD],
      ["Причина уничтожения", reason],
      ["Дата уничтожения", dayStr(at)],
    ], widths: [3400, 5955] },
    "",
    { l: `Лицо, уничтожившее персональные данные: ${operatorName(l.fullName)} (ответственный за организацию обработки персональных данных)` },
    { l: `Подпись: ____________ / ${shortName(l.fullName)}` },
    "",
    { h: "ВЫГРУЗКА ИЗ ЖУРНАЛА РЕГИСТРАЦИИ СОБЫТИЙ" },
    { c: `к акту № ${number} от ${dayStr(at)} · ${SYSTEM.split(" (")[0]}` },
    { table: [
      ["Дата и время", "Субъект", "Категории данных", "Причина"],
      ...items.map((i) => [timeStr(i.at || at), i.subject, (i.categories || []).join(", "), reason]),
    ], widths: [1700, 3000, 2955, 1700] },
    "",
    { l: "Акт и выгрузка хранятся 3 года с даты уничтожения персональных данных." },
  ];
}

function createLegalPapers({ db, getMailer, platformLegal, dir = process.env.PAPERS_DIR || path.join(__dirname, "state", "papers"), now = () => Date.now(), env = process.env }) {
  /** Номер документа по порядку — свой счётчик на каждый вид. */
  // Номера выдаются по очереди: два удаления одновременно не получат один номер.
  let numbering = Promise.resolve();
  function nextNumber(kind) {
    const run = numbering.then(async () => {
      const ref = db().collection("platformConfig").doc("legalPapers");
      const snap = await ref.get();
      const n = (Number((snap.exists && snap.data()[kind]) || 0) || 0) + 1;
      await ref.set({ [kind]: n }, { merge: true });
      return n;
    });
    numbering = run.catch(() => {});
    return run;
  }

  /** Сохранить на сервере и отправить владельцу. */
  async function deliver({ fileName, buf, subject, text }) {
    let saved = "";
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      saved = path.join(dir, fileName);
      fs.writeFileSync(saved, buf, { mode: 0o600 });
    } catch (e) {
      console.error(`legal-papers: не сохранил ${fileName}: ${e.message || e}`);
    }
    const legal = (await platformLegal().catch(() => null)) || {};
    const to = String(env.LEGAL_PAPERS_TO || legal.email || "").trim();
    const mailer = getMailer();
    if (!to || !mailer) {
      console.warn(`legal-papers: ${fileName} — почта не настроена, файл только на сервере: ${saved || "(не сохранён)"}`);
      return { saved, emailed: false };
    }
    await mailer.send({
      to, subject, text,
      attachments: [{ filename: fileName, content: buf, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
    });
    console.log(`legal-papers: ${fileName} отправлен владельцу`);
    return { saved, emailed: true };
  }

  /** Данные уничтожены → акт. Ошибки не выбрасываются: удаление уже сделано. */
  async function destruction(items, { reason }) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return null;
    try {
      const at = now();
      const number = await nextNumber("destructionAct");
      const legal = (await platformLegal().catch(() => null)) || {};
      const buf = docx(destructionActBlocks({ legal, number, at, items: list, reason }));
      return await deliver({
        fileName: `Акт_уничтожения_ПДн_${number}_${dayStr(at)}.docx`,
        buf,
        subject: `Акт № ${number} об уничтожении персональных данных — распечатать и подписать`,
        text: [
          `Удалены персональные данные: ${list.length === 1 ? list[0].subject : `${list.length} субъектов`}.`,
          `Причина: ${reason}.`,
          "",
          "По закону (приказ Роскомнадзора № 179) нужен акт об уничтожении с выгрузкой из журнала событий — он во вложении, уже заполнен.",
          "Распечатайте, подпишите и храните 3 года вместе с приказом № 1-ПД.",
        ].join("\n"),
      });
    } catch (e) {
      console.error(`legal-papers: акт об уничтожении не сформирован: ${e.message || e}`);
      return null;
    }
  }

  /** Готовый файл (например, договор с менеджером) — владельцу. */
  async function sendFile({ fileName, buf, subject, text }) {
    try {
      return await deliver({ fileName, buf, subject, text });
    } catch (e) {
      console.error(`legal-papers: ${fileName} не отправлен: ${e.message || e}`);
      return null;
    }
  }

  return { destruction, sendFile };
}

module.exports = { createLegalPapers, destructionActBlocks, operatorName, shortName };
