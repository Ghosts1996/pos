// Данные для проверки запуска Windows-кассы (windows-smoke.yml). Шлюз и
// касса работают как в бою — своя база (SQLite) и свой вход, без Firebase;
// к боевому серверу проверка не обращается.
//
//   node seed.js demo    — демо-сеть из двух точек через запущенный шлюз
//                          (те же залы, меню, брони, что видит владелец)
//   node seed.js single  — первая точка становится отдельным заведением
//                          с кодом win-smoke (сборка кассы с этим кодом)
//   node seed.js chain   — код win-smoke переезжает на вторую точку сети:
//                          касса, уже подключённая к первой, переподключается
//
// single и chain правят файл базы напрямую — шлюз в это время остановлен
// (он держит данные в памяти). Файл базы — DATA_DB_FILE, как у шлюза.
const fs = require('fs');
const path = require('path');
const gw = path.join(__dirname, '..', '..', 'saas-gateway');
// Классы меток времени и служебных значений — те же, что у шлюза.
const admin = require(path.join(gw, 'node_modules', 'firebase-admin'));
const { createDataStore } = require(path.join(gw, 'data-server'));
const { Timestamp, FieldValue } = admin.firestore;

const SLUG = 'win-smoke';
const INVITE = 'SMOKE1234';
const GATEWAY = process.env.SMOKE_GATEWAY || 'http://127.0.0.1:8095';
const stateFile = path.join(process.env.RUNNER_TEMP || __dirname, 'smoke-state.json');

setTimeout(() => { console.error('seed.js: нет ответа за 3 минуты'); process.exit(1); }, 180000).unref();

function openDb() {
  const file = process.env.DATA_DB_FILE;
  if (!file) throw new Error('DATA_DB_FILE не задан');
  return createDataStore({ admin, file });
}

async function makeTarget(db, tenantId) {
  await db.doc(`tenants/${tenantId}`).set({ slug: SLUG, demo: false, status: 'active' }, { merge: true });
  await db.doc(`tenants/${tenantId}/settings/deviceInvite`).set({ code: INVITE, rotatedAt: Timestamp.now() });
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'demo') {
    const r = await fetch(`${GATEWAY}/createDemoTenant`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(90000),
    });
    const json = await r.json();
    if (!r.ok || !json.chainId) throw new Error(`createDemoTenant: ${r.status} ${JSON.stringify(json)}`);
    fs.writeFileSync(stateFile, JSON.stringify({ chainId: json.chainId }));
    console.log('демо-сеть', json.chainId);
  } else if (mode === 'single' || mode === 'chain') {
    const { chainId } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const db = openDb();
    const ids = (await db.collection('tenants').where('chainId', '==', chainId).get()).docs.map((d) => d.id).sort();
    let { p1, p2 } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!p1) [p1, p2] = ids;
    if (!p1 || !p2) throw new Error(`в демо-сети нет двух точек: ${ids.join(', ')}`);
    if (mode === 'single') {
      await db.doc(`tenants/${p1}`).update({ chainId: FieldValue.delete() });
      await makeTarget(db, p1);
      const trialEndsAt = Timestamp.fromMillis(Date.now() + 7 * 86400000);
      await db.doc(`subscriptions/${p1}`).set({ tenantId: p1, planId: 'standard', status: 'trial', trialEndsAt,
        currentPeriodEnd: trialEndsAt, provider: null });
      await db.doc('plans/standard').set({ name: 'Бизнес', priceRub: 1990, maxEmployees: 15, aiEnabled: true,
        features: { reservations: true, loyalty: true, guestApp: true } }, { merge: true });
      console.log('отдельное заведение', p1);
    } else {
      await db.doc(`tenants/${p1}`).set({ slug: 'win-old' }, { merge: true });
      await db.doc(`chains/${chainId}`).set({ demo: false }, { merge: true });
      await makeTarget(db, p2);
      console.log('точка сети', p2, 'сеть', chainId);
    }
    fs.writeFileSync(stateFile, JSON.stringify({ chainId, p1, p2 }));
    db.close();
  } else {
    throw new Error('режим: demo | single | chain');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
