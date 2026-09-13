/**
 * Cloud Functions для «Колибри Лаундж» + POS.
 *
 * Здесь живёт то, что нельзя делать на планшете:
 *  • рассылка push (серверный ключ FCM не должен попадать в APK);
 *  • сторож броней: напоминания и авто-noShow по расписанию;
 *  • прокси к tooken.club для гостей — ключ ИИ не уезжает на телефоны;
 *  • начисление бонусов при закрытии чека — считается на сервере, гость
 *    не может подделать сумму.
 *
 * Развёртывание:
 *   cd functions && npm i
 *   firebase functions:secrets:set TOOKEN_API_KEY
 *   firebase deploy --only functions
 *
 * Node 20, firebase-functions v2.
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const REGION = "europe-west1";

const TOOKEN_API_KEY = defineSecret("TOOKEN_API_KEY");

/** Часовой пояс заведения. Функции работают в UTC, поэтому любое время,
 *  которое увидит человек (push смене, расчёт дня рождения), обязано
 *  форматироваться явно в этой зоне, а не через getHours()/getDate(). */
const VENUE_TZ = "Europe/Moscow";

/** «16:30» в зоне заведения. */
function formatVenueTime(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: VENUE_TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Календарные день/месяц/год даты в зоне заведения. */
function venueDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VENUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// ---------------------------------------------------------------- push

/** Очередь push: приложение пишет документ, функция рассылает. */
exports.sendQueuedPush = onDocumentCreated(
  { region: REGION, document: "pushQueue/{id}" },
  async (event) => {
    const d = event.data?.data();
    if (!d) return;

    const message = {
      notification: { title: d.title, body: d.body },
      data: Object.fromEntries(
        Object.entries(d.data || {}).map(([k, v]) => [k, String(v)])
      ),
      android: { priority: "high" },
    };

    try {
      if (d.topic) {
        await admin.messaging().send({ ...message, topic: d.topic });
      } else if (d.token) {
        await admin.messaging().send({ ...message, token: d.token });
      }
      await event.data.ref.update({ status: "sent", sentAt: new Date() });
    } catch (e) {
      await event.data.ref.update({ status: "error", error: String(e) });
    }
  }
);

/** Новая бронь из приложения → уведомление смене. */
exports.onReservationCreated = onDocumentCreated(
  { region: REGION, document: "reservations/{id}" },
  async (event) => {
    const r = event.data?.data();
    if (!r || r.source !== "kolibri") return;
    const t = r.startTime?.toDate?.() ?? new Date();
    await db.collection("pushQueue").add({
      topic: "staff",
      title: "Новая бронь",
      // ВАЖНО: getHours() у Node в Cloud Functions считает по UTC, поэтому
      // смене прилетала бронь «на 13:00» вместо 16:00. Форматируем явно в
      // зоне заведения.
      body: `${r.guestName}, ${r.guestsCount} чел, ${formatVenueTime(t)}`,
      data: { type: "reservation", id: event.params.id },
      status: "new",
      createdAt: new Date(),
    });
  }
);

/** Подтверждение/отмена брони → уведомление гостю. */
exports.onReservationUpdated = onDocumentUpdated(
  { region: REGION, document: "reservations/{id}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === after.status) return;
    if (!after.clientUid) return;

    const titles = {
      confirmed: ["Бронь подтверждена", "Ждём вас! Стол закреплён за вами."],
      cancelled: ["Бронь отменена", "Если это ошибка — забронируйте заново в приложении."],
      seated: ["Добро пожаловать", "Ваш стол открыт — счёт виден в приложении."],
    };
    const entry = titles[after.status];
    if (!entry) return;

    const client = await db.collection("clients").doc(after.clientUid).get();
    const token = client.data()?.pushToken;
    if (!token) return;

    await db.collection("pushQueue").add({
      token,
      title: entry[0],
      body: entry[1],
      data: { type: "reservation", id: event.params.id },
      status: "new",
      createdAt: new Date(),
    });
  }
);

/** Вызов кальянщика гостем → уведомление смене. */
exports.onWaiterCall = onDocumentCreated(
  { region: REGION, document: "waiterCalls/{id}" },
  async (event) => {
    const c = event.data?.data();
    if (!c) return;
    const labels = {
      waiter: "Зовут кальянщика",
      coal: "Просят поменять угли",
      bill: "Просят счёт",
      refill: "Просят перезабивку",
    };
    await db.collection("pushQueue").add({
      topic: "staff",
      title: labels[c.type] || "Обращение гостя",
      body: `${c.tableName || "Стол"}${c.comment ? ` — ${c.comment}` : ""}`,
      data: { type: "call", tableId: c.tableId || "" },
      status: "new",
      createdAt: new Date(),
    });
  }
);

// ---------------------------------------------------- сторож броней

/**
 * Каждые 10 минут: напоминание гостю за час до брони и авто-noShow
 * через 25 минут после начала, если гостя не посадили.
 */
exports.reservationWatchdog = onSchedule(
  { region: REGION, schedule: "every 10 minutes", timeZone: "Europe/Moscow" },
  async () => {
    const now = new Date();

    // --- напоминания за час ---
    const from = new Date(now.getTime() + 55 * 60000);
    const to = new Date(now.getTime() + 65 * 60000);
    const soon = await db
      .collection("reservations")
      .where("startTime", ">=", from)
      .where("startTime", "<", to)
      .get();

    for (const doc of soon.docs) {
      const r = doc.data();
      if (r.status !== "confirmed" || r.reminderSent || !r.clientUid) continue;
      const client = await db.collection("clients").doc(r.clientUid).get();
      const token = client.data()?.pushToken;
      if (token) {
        await db.collection("pushQueue").add({
          token,
          title: "Через час ждём вас",
          body: `Стол ${r.tableName || ""} на ${r.guestsCount} чел.`.trim(),
          data: { type: "reservation", id: doc.id },
          status: "new",
          createdAt: new Date(),
        });
      }
      await doc.ref.update({ reminderSent: true });
    }

    // --- авто-noShow ---
    const lateFrom = new Date(now.getTime() - 3 * 3600000);
    const lateTo = new Date(now.getTime() - 25 * 60000);
    const late = await db
      .collection("reservations")
      .where("startTime", ">=", lateFrom)
      .where("startTime", "<", lateTo)
      .get();

    for (const doc of late.docs) {
      const r = doc.data();
      if (r.status !== "new" && r.status !== "confirmed") continue;
      await doc.ref.update({ status: "noShow", handledBy: "auto" });
      // Освобождаем стол и в обезличенном зеркале занятости, иначе бронь
      // гостя, который не пришёл, продолжала бы держать слот в приложении
      // до конца своего интервала.
      await db
        .collection("reservationSlots")
        .doc(doc.id)
        .set({ active: false }, { merge: true });
      await db.collection("staffNotes").add({
        title: "Бронь без гостя",
        text: `${r.guestName} (${r.guestsCount} чел) не пришёл — стол ${r.tableName || "—"} освобождён.`,
        priority: "warning",
        source: "watchdog",
        read: false,
        createdAt: new Date(),
      });
    }
  }
);

// ------------------------------------------------- бонусы и отзывы

/** Закрытие чека: кешбэк гостю и просьба оценить визит. */
exports.onSessionClosed = onDocumentUpdated(
  { region: REGION, document: "sessions/{id}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === "closed" || after.status !== "closed") return;

    const paid =
      (after.paymentCash || 0) +
      (after.paymentCard || 0) +
      (after.paymentTerminal || 0);
    if (paid <= 0) return;

    // Полная сумма чека со скидкой. Кешбэк считается с живых денег (paid),
    // а уровень лояльности двигает именно эта сумма: гость «наел» на неё,
    // чем бы он её ни закрыл. Логика должна совпадать с accrueBonuses в
    // guest_link_service.dart, иначе сервер и касса дадут разный уровень.
    const orderTotal = (after.orderItems || []).reduce(
      (sum, i) => sum + (i.price || 0) * (i.qty || 0),
      0
    );
    const billTotal = orderTotal * (1 - (after.discountPercent || 0) / 100);
    const spentDelta = billTotal > 0 ? billTotal : paid;

    const clients = await db
      .collection("clients")
      .where("activeSessionId", "==", event.params.id)
      .limit(1)
      .get();
    if (clients.empty) return;

    const ref = clients.docs[0].ref;

    // Бонус начисляет ещё и касса на планшете (accrueBonuses в
    // guest_link_service.dart) — причём ровно в тот же момент, сразу после
    // закрытия чека. Раньше здесь было «прочитали документ → проверили
    // bonusAccruedFor → записали», без транзакции: оба начисления успевали
    // прочитать профиль ДО того, как любое из них поставило отметку, и
    // гость получал двойной кешбэк, двойной visits и двойной totalSpent.
    // Транзакция закрывает эту гонку: кто пришёл вторым, увидит уже
    // выставленный bonusAccruedFor и не начислит ничего.
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const c = snap.data() || {};
      if (c.bonusAccruedFor === event.params.id) return null;

      const spent = (c.totalSpent || 0) + spentDelta;
      // Пороги и проценты должны совпадать с ClientProfile.cashbackPercent
      // в приложении — иначе гость видит в профиле один процент, а
      // получает другой. Алмаз (15% от 100 000) здесь раньше отсутствовал.
      const percent =
        spent >= 100000 ? 15 :
        spent >= 50000 ? 10 :
        spent >= 25000 ? 7 :
        spent >= 10000 ? 5 : 3;
      const bonus = Math.round((paid * percent) / 100);

      tx.update(ref, {
        bonusBalance: (c.bonusBalance || 0) + bonus,
        totalSpent: spent,
        visits: (c.visits || 0) + 1,
        bonusAccruedFor: event.params.id,
        activeSessionId: "",
        activeTableId: "",
        lastVisitAt: new Date(),
      });
      return { bonus, pushToken: c.pushToken };
    });

    if (!result) return; // касса уже начислила этот чек

    const { bonus } = result;
    const c = { pushToken: result.pushToken };

    // Вечная история визитов гостя — её же пишет касса. Id документа равен
    // id чека, поэтому повторная запись не создаёт дубль.
    await ref.collection("visits").doc(event.params.id).set({
      date: new Date(),
      tableName: after.tableName || "",
      total: spentDelta,
      paid,
      bonusEarned: bonus,
      bonusSpent: 0,
      items: (after.orderItems || []).map((i) => ({
        name: i.name || "",
        qty: i.qty || 0,
        price: i.price || 0,
      })),
    });

    await db.collection("bonusOperations").add({
      clientUid: ref.id,
      sessionId: event.params.id,
      type: "accrual",
      amount: paid,
      bonus,
      createdAt: new Date(),
    });

    if (c.pushToken) {
      await db.collection("pushQueue").add({
        token: c.pushToken,
        title: `Начислено ${bonus} бонусов`,
        body: "Спасибо за визит! Оцените вечер в приложении.",
        data: { type: "review", sessionId: event.params.id },
        status: "new",
        createdAt: new Date(),
      });
    }
  }
);

// ------------------------------------------------- дни рождения

/**
 * Раз в сутки: поздравляем гостей, у которых день рождения через 3 дня,
 * и начисляем подарочные бонусы. Год поздравления запоминается, поэтому
 * повторно за тот же год гость поздравление не получит.
 */
exports.birthdayGreetings = onSchedule(
  { region: REGION, schedule: "every day 12:00", timeZone: "Europe/Moscow" },
  async () => {
    const GIFT = 500;
    // Дату считаем в зоне заведения: getMonth()/getDate() дают UTC, и у
    // именинников 1-го числа поздравление уезжало на сутки.
    const target = venueDateParts(new Date(Date.now() + 3 * 86400000));
    const year = venueDateParts(new Date()).year;

    const snap = await db
      .collection("clients")
      .where("birthdayMonth", "==", target.month)
      .where("birthdayDay", "==", target.day)
      .get();

    const names = [];
    for (const doc of snap.docs) {
      const c = doc.data();
      if (c.birthdayGreetedYear === year) continue;

      await doc.ref.update({
        bonusBalance: (c.bonusBalance || 0) + GIFT,
        birthdayGreetedYear: year,
      });
      await db.collection("bonusOperations").add({
        clientUid: doc.id,
        type: "accrual",
        amount: GIFT,
        reason: "birthday",
        createdAt: new Date(),
      });
      if (c.pushToken) {
        await db.collection("pushQueue").add({
          token: c.pushToken,
          title: "С наступающим днём рождения!",
          body: `${GIFT} бонусов уже на счету — ждём вас отметить.`,
          status: "new",
          createdAt: new Date(),
        });
      }
      names.push(c.name || "Гость");
    }

    if (names.length) {
      await db.collection("staffNotes").add({
        title: "Именинники",
        text: `Через 3 дня отмечают: ${names.join(", ")}. Подарочные бонусы начислены.`,
        priority: "info",
        source: "birthday",
        read: false,
        createdAt: new Date(),
      });
    }
  }
);

// --------------------------------------------------- прокси к ИИ

/**
 * Прокси к tooken.club для клиентского приложения.
 *
 * Гость вызывает функцию, ключ живёт в секрете Firebase и на телефон не
 * попадает. Ограничения: только гостевые агенты, короткий ответ и лимит
 * запросов на пользователя в сутки.
 */
exports.aiProxy = onCall(
  { region: REGION, secrets: [TOOKEN_API_KEY], cors: true },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Нужен вход в приложение");

    const { messages, model } = request.data || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpsError("invalid-argument", "Пустой запрос");
    }

    // Лимит: 40 обращений в сутки на гостя — защита от накрутки баланса.
    const today = new Date().toISOString().slice(0, 10);
    const counterRef = db.collection("aiUsage").doc(`${uid}_${today}`);
    const counter = await counterRef.get();
    const used = counter.data()?.count || 0;
    if (used >= 40) {
      throw new HttpsError("resource-exhausted", "Слишком много запросов, попробуйте завтра");
    }
    await counterRef.set({ count: used + 1, uid, day: today }, { merge: true });

    const settings = (await db.doc("meta/aiSettings").get()).data() || {};
    const baseUrl = (settings.baseUrl || "https://tooken.club/v1").replace(/\/+$/, "");

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOOKEN_API_KEY.value()}`,
      },
      body: JSON.stringify({
        model: model || settings.model || "gpt-4o-mini",
        messages,
        temperature: 0.5,
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      throw new HttpsError("internal", `Ошибка ИИ ${resp.status}`);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";

    await db.collection("aiLogs").add({
      agentId: "proxy:guest",
      model: model || settings.model || "",
      totalTokens: data.usage?.total_tokens || 0,
      createdAt: new Date(),
    });

    return { text };
  }
);
