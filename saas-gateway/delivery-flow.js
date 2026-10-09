"use strict";
/** Статусы заказа с собой и доставки — копия lib/models/delivery_status.dart.
 *  Двигаться можно только на следующий шаг. */
const PATHS = {
  delivery: ["new", "accepted", "cooking", "courier", "done"],
  takeaway: ["new", "accepted", "cooking", "ready", "done"],
};
const pathOf = (orderType) => (orderType === "delivery" ? PATHS.delivery : PATHS.takeaway);
const normalize = (orderType, status) => (pathOf(orderType).includes(status) ? status : "new");
function next(orderType, status) {
  const p = pathOf(orderType);
  const i = p.indexOf(normalize(orderType, status));
  return i >= 0 && i < p.length - 1 ? p[i + 1] : null;
}
const canMove = (orderType, from, to) => next(orderType, from) === to;
const LABELS = { new: "Новый", accepted: "Принят", cooking: "Готовится", courier: "У курьера", ready: "Готов к выдаче" };
function label(orderType, status) {
  const s = normalize(orderType, status);
  if (s === "done") return orderType === "delivery" ? "Доставлен" : "Выдан";
  return LABELS[s];
}
const ACTIONS = { accepted: "Принять заказ", cooking: "Начать готовить", courier: "Передать курьеру", ready: "Готов к выдаче" };
function actionLabel(orderType, status) {
  const n = next(orderType, status);
  if (!n) return null;
  if (n === "done") return orderType === "delivery" ? "Доставлен" : "Выдан гостю";
  return ACTIONS[n];
}
module.exports = { next, canMove, label, actionLabel, normalize };
