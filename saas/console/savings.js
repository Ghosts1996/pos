// Калькулятор экономии и сводная таблица тарифов для главной zalpos.ru.
// Чистые функции без DOM — их проверяет test.savings.mjs.
//
// Закон о рекламе (ст. 5 38-ФЗ): никаких названий и цен чужих систем — человек
// вводит СВОИ расходы (подписка на кассу сейчас, комиссия агрегатора), а мы
// считаем, сколько останется, если перейти на ZalPOS. Всё, что платится
// отдельно (эквайринг, ОФД, курьеры), в расчёт не входит и так подписано.

/** Тарифы одного заведения в продаже, от дешёвого к дорогому. */
export function singlePlans(plans) {
  return (plans || [])
    .filter((p) => p && p.archived !== true && !p.isChainPlan && Number(p.priceRub) > 0)
    .sort((a, b) => Number(a.priceRub) - Number(b.priceRub));
}

/** Самый дешёвый тариф, где хватает устройств с кассой (0 — без ограничений). */
export function planForTills(plans, tills) {
  const n = Math.max(1, Math.floor(Number(tills) || 1));
  const list = singlePlans(plans);
  return list.find((p) => !Number(p.maxDevices) || Number(p.maxDevices) >= n) || list[list.length - 1] || null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));

/**
 * Годовая экономия.
 *  tills — устройств с кассой;
 *  currentMonthly — сколько платите за кассу/учёт сейчас в месяц, ₽;
 *  deliveryMonthly — оборот доставки и заказов по QR через агрегаторы в месяц, ₽;
 *  commissionPct — комиссия агрегатора, %;
 *  sharePct — какая доля этих заказов перейдёт в свою доставку и QR, %.
 */
export function savingsEstimate(input, plans) {
  const tills = clamp(input.tills, 1, 50);
  const currentMonthly = clamp(input.currentMonthly, 0, 10_000_000);
  const deliveryMonthly = clamp(input.deliveryMonthly, 0, 1_000_000_000);
  const commissionPct = clamp(input.commissionPct, 0, 60);
  const sharePct = clamp(input.sharePct, 0, 100);
  const plan = planForTills(plans, tills);
  const ourMonthly = plan ? Number(plan.priceRub) : 0;
  const subscription = Math.round((currentMonthly - ourMonthly) * 12);
  const commission = Math.round(deliveryMonthly * (commissionPct / 100) * (sharePct / 100) * 12);
  return {
    plan, tills, ourMonthly,
    subscriptionYear: subscription, // может быть отрицательной: сейчас платите меньше
    commissionYear: commission,
    totalYear: subscription + commission,
  };
}

/** Строки сводной таблицы: тариф, ₽/мес, ₽/год, устройства, курьеры, ИИ, доп. точка. */
export function planTableRows(plans) {
  const fmt = (n) => Number(n).toLocaleString('ru-RU');
  const limit = (v) => (Number(v) > 0 ? `до ${fmt(v)}` : Number(v) === -1 ? 'без ограничений' : 'нет');
  const all = (plans || [])
    .filter((p) => p && p.archived !== true && Number(p.priceRub) > 0)
    .sort((a, b) => (!!a.isChainPlan - !!b.isChainPlan) || Number(a.priceRub) - Number(b.priceRub));
  return all.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    month: `${fmt(p.priceRub)} ₽`,
    year: Number(p.priceRubYearly) > 0 ? `${fmt(p.priceRubYearly)} ₽` : '—',
    devices: Number(p.maxDevices) > 0 ? `до ${fmt(p.maxDevices)}${p.isChainPlan ? ' на точку' : ''}` : 'без ограничений',
    couriers: p.maxCouriers === undefined || p.maxCouriers === null ? '—' : limit(p.maxCouriers),
    ai: p.aiEnabled === false ? 'нет' : 'да',
    extra: p.isChainPlan && Number(p.priceRubAdditional) > 0 ? `${fmt(p.priceRubAdditional)} ₽/мес` : '—',
  }));
}
