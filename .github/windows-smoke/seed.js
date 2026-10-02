// Данные для проверки запуска Windows-кассы (windows-smoke.yml): только
// эмуляторы Firestore/Auth, к боевой базе не обращается.
//
//   node seed.js demo    — демо-сеть из двух точек через локальный шлюз
//                          (те же залы, меню, брони, что видит владелец)
//   node seed.js single  — первая точка становится отдельным заведением
//                          с кодом win-smoke (сборка кассы с этим кодом)
//   node seed.js chain   — код win-smoke переезжает на вторую точку сети:
//                          касса, уже подключённая к первой, переподключается
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const admin = require(path.join(__dirname, '..', '..', 'saas-gateway', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'demo-hookah' });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const SLUG = 'win-smoke';
const INVITE = 'SMOKE1234';

async function state() {
  const doc = await db.doc('smoke/state').get();
  return doc.data() || {};
}

async function points(chainId) {
  const snap = await db.collection('tenants').where('chainId', '==', chainId).get();
  return snap.docs.map((d) => d.id).sort();
}

async function makeTarget(tenantId) {
  await db.doc(`tenants/${tenantId}`).set({ slug: SLUG, demo: false, status: 'active' }, { merge: true });
  await db.doc(`tenants/${tenantId}/settings/deviceInvite`).set({ code: INVITE, rotatedAt: Timestamp.now() });
}

// Эмулятор не ответил — не висим до таймаута задания.
setTimeout(() => { console.error('seed.js: нет ответа за 3 минуты'); process.exit(1); }, 180000).unref();

(async () => {
  const mode = process.argv[2];
  if (mode === 'demo') {
    const r = await fetch('http://127.0.0.1:8095/createDemoTenant', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(90000),
    });
    const json = await r.json();
    if (!r.ok || !json.chainId) throw new Error(`createDemoTenant: ${r.status} ${JSON.stringify(json)}`);
    const ids = await points(json.chainId);
    await db.doc('smoke/state').set({ chainId: json.chainId, p1: ids[0], p2: ids[1] });
    await db.doc('plans/standard').set({ name: 'Бизнес', priceRub: 1990, maxEmployees: 15, aiEnabled: true,
      features: { reservations: true, loyalty: true, guestApp: true } }, { merge: true });
    console.log('демо-сеть', json.chainId, 'точки', ids.join(', '));
  } else if (mode === 'single') {
    const { p1 } = await state();
    await db.doc(`tenants/${p1}`).update({ chainId: FieldValue.delete() });
    await makeTarget(p1);
    const trialEndsAt = Timestamp.fromMillis(Date.now() + 7 * 86400000);
    await db.doc(`subscriptions/${p1}`).set({ tenantId: p1, planId: 'standard', status: 'trial', trialEndsAt,
      currentPeriodEnd: trialEndsAt, provider: null });
    console.log('отдельное заведение', p1);
  } else if (mode === 'chain') {
    const { chainId, p1, p2 } = await state();
    await db.doc(`tenants/${p1}`).set({ slug: 'win-old' }, { merge: true });
    await db.doc(`chains/${chainId}`).set({ demo: false }, { merge: true });
    await makeTarget(p2);
    console.log('точка сети', p2, 'сеть', chainId);
  } else {
    throw new Error('режим: demo | single | chain');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
