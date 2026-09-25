/**
 * Обязательный security-тест из ТЗ (§10, §69): пользователь Tenant A не
 * должен читать/писать данные Tenant B, и наоборот — для гостя, для
 * персонала разных ролей и для попытки создать/сменить себе tenant в обход
 * бэкенда. Плюс супер-админ должен видеть оба.
 *
 * Запуск:
 *   cd saas/test && npm i
 *   npx firebase emulators:exec --project hookah-saas-rules-test \
 *     --only firestore "npm test"
 * (или см. saas/test/run.sh — обёртка с тем же вызовом)
 */
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, updateDoc, query, where } = require("firebase/firestore");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PROJECT_ID = "hookah-saas-rules-test";

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

/** Заводит фиксацию: два заведения (A, B), их владельцев и по одному столу
 *  в каждом — в обход правил (админ-доступ эмулятора), как и положено для
 *  подготовки данных перед тестом самих правил. */
async function seedTwoTenants() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "tenants/tenantA"), { name: "Lounge A", slug: "lounge-a", status: "active" });
    await setDoc(doc(db, "tenants/tenantB"), { name: "Lounge B", slug: "lounge-b", status: "active" });

    await setDoc(doc(db, "tenantMembers/tenantA_ownerA"), {
      tenantId: "tenantA", userId: "ownerA", role: "owner", status: "active",
    });
    await setDoc(doc(db, "tenantMembers/tenantB_ownerB"), {
      tenantId: "tenantB", userId: "ownerB", role: "owner", status: "active",
    });

    await setDoc(doc(db, "tenants/tenantA/tables/table1"), { name: "Стол A1", x: 0.2, y: 0.3 });
    await setDoc(doc(db, "tenants/tenantB/tables/table1"), { name: "Стол B1", x: 0.4, y: 0.5 });

    await setDoc(doc(db, "tenants/tenantA/sessions/sess1"), { status: "active", tableId: "table1" });
    await setDoc(doc(db, "tenants/tenantB/sessions/sess1"), { status: "active", tableId: "table1" });

    // Гости: guestA привязан к tenantA (есть свой профиль clients там),
    // guestB — к tenantB. Оба анонимны, оба — валидные аккаунты одного и
    // того же Firebase-проекта платформы.
    await setDoc(doc(db, "tenants/tenantA/clients/guestA"), { name: "Гость A", activeSessionId: "" });
    await setDoc(doc(db, "tenants/tenantB/clients/guestB"), { name: "Гость B", activeSessionId: "" });

    await setDoc(doc(db, "superAdmins/root"), { since: new Date().toISOString() });
  });
}

function ctxFor(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

describe("Изоляция арендаторов — сотрудники", () => {
  beforeEach(seedTwoTenants);

  it("owner A читает столы своего заведения", async () => {
    const db = ctxFor("ownerA");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantA/tables/table1")));
  });

  it("owner A НЕ читает столы заведения B", async () => {
    const db = ctxFor("ownerA");
    await assertFails(getDoc(doc(db, "tenants/tenantB/tables/table1")));
  });

  it("owner A НЕ может править чек заведения B", async () => {
    const db = ctxFor("ownerA");
    await assertFails(updateDoc(doc(db, "tenants/tenantB/sessions/sess1"), { status: "closed" }));
  });

  it("owner A НЕ может удалить стол заведения B", async () => {
    const db = ctxFor("ownerA");
    await assertFails(deleteDoc(doc(db, "tenants/tenantB/tables/table1")));
  });

  it("owner B симметрично не видит данные A", async () => {
    const db = ctxFor("ownerB");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantB/tables/table1")));
    await assertFails(getDoc(doc(db, "tenants/tenantA/tables/table1")));
  });

  it("посторонний авторизованный пользователь без членства нигде ничего не видит", async () => {
    const db = ctxFor("stranger");
    await assertFails(getDoc(doc(db, "tenants/tenantA/tables/table1")));
    await assertFails(getDoc(doc(db, "tenants/tenantB/tables/table1")));
  });

  it("супер-админ читает оба заведения", async () => {
    const db = ctxFor("root");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantA/tables/table1")));
    await assertSucceeds(getDoc(doc(db, "tenants/tenantB/tables/table1")));
  });
});

describe("Изоляция арендаторов — гости", () => {
  beforeEach(seedTwoTenants);

  it("гость A видит меню/зал/афишу своего заведения (через isTenantGuest)", async () => {
    const db = ctxFor("guestA");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantA/tables/table1")));
  });

  it("гость A НЕ видит зал/чек чужого заведения B, хотя авторизован в том же проекте", async () => {
    const db = ctxFor("guestA");
    await assertFails(getDoc(doc(db, "tenants/tenantB/tables/table1")));
    await assertFails(getDoc(doc(db, "tenants/tenantB/sessions/sess1")));
  });

  it("гость A не может создать вызов персонала в заведении B", async () => {
    const db = ctxFor("guestA");
    await assertFails(
      setDoc(doc(db, "tenants/tenantB/waiterCalls/call1"), { clientUid: "guestA", type: "waiter" })
    );
  });

  it("анонимный пользователь без профиля clients ни в одном заведении не видит меню", async () => {
    const db = ctxFor("freshAnon");
    await assertFails(getDoc(doc(db, "tenants/tenantA/menuItems/item1")));
    await assertFails(getDoc(doc(db, "tenants/tenantB/menuItems/item1")));
  });
});

describe("Нельзя обойти бэкенд для создания/эскалации tenant", () => {
  beforeEach(seedTwoTenants);

  it("клиент не может создать себе tenant напрямую (только Cloud Function)", async () => {
    const db = ctxFor("randomUser");
    await assertFails(
      setDoc(doc(db, "tenants/hackedTenant"), { name: "Free tenant", status: "active" })
    );
  });

  it("owner не может назначить себя владельцем другого заведения (role owner запрещена клиенту)", async () => {
    const db = ctxFor("ownerA");
    await assertFails(
      setDoc(doc(db, "tenantMembers/tenantB_ownerA"), {
        tenantId: "tenantB", userId: "ownerA", role: "owner", status: "active",
      })
    );
  });

  it("рядовой employee не может повысить себя до admin", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenantMembers/tenantA_empA"), {
        tenantId: "tenantA", userId: "empA", role: "employee", status: "active",
      });
    });
    const db = ctxFor("empA");
    await assertFails(updateDoc(doc(db, "tenantMembers/tenantA_empA"), { role: "admin" }));
  });

  it("устройство без кода приглашения не может сделать себя сотрудником заведения", async () => {
    const db = ctxFor("rogueDevice");
    await assertFails(
      setDoc(doc(db, "tenantMembers/tenantA_rogueDevice"), {
        tenantId: "tenantA", userId: "rogueDevice", role: "employee", status: "active",
      })
    );
  });

  it("устройство, уже прошедшее приглашение (devices/{uid} существует), может стать employee", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantA/devices/newDevice"), {
        deviceName: "Планшет №2", platform: "android",
      });
    });
    const db = ctxFor("newDevice");
    await assertSucceeds(
      setDoc(doc(db, "tenantMembers/tenantA_newDevice"), {
        tenantId: "tenantA", userId: "newDevice", role: "employee", status: "active",
      })
    );
  });
});

describe("Полный путь joinAsDevice() как реальный клиент (без withSecurityRulesDisabled)", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "tenants/tenantA"), { name: "Lounge A", slug: "lounge-a", status: "active" });
      await setDoc(doc(db, "tenants/tenantA/settings/deviceInvite"), { code: "DEMO1234" });
    });
  });

  it("шаг 1: устройство создаёт свой devices/{uid} с верным кодом приглашения", async () => {
    const db = ctxFor("device1");
    await assertSucceeds(
      setDoc(doc(db, "tenants/tenantA/devices/device1"), {
        inviteCode: "DEMO1234", deviceName: "Демо", deviceType: "pos",
        platform: "android", userId: "device1", status: "active",
      })
    );
  });

  it("шаг 2: после шага 1 устройство создаёт tenantMembers тем же uid", async () => {
    const db = ctxFor("device1");
    await setDoc(doc(db, "tenants/tenantA/devices/device1"), {
      inviteCode: "DEMO1234", deviceName: "Демо", deviceType: "pos",
      platform: "android", userId: "device1", status: "active",
    });
    await assertSucceeds(
      setDoc(doc(db, "tenantMembers/tenantA_device1"), {
        tenantId: "tenantA", userId: "device1", role: "employee", status: "active",
      })
    );
  });
});

describe("Ролевая модель внутри одного заведения", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "tenantMembers/tenantA_managerA"), {
        tenantId: "tenantA", userId: "managerA", role: "manager", status: "active",
      });
      await setDoc(doc(db, "tenantMembers/tenantA_empA"), {
        tenantId: "tenantA", userId: "empA", role: "employee", status: "active",
      });
    });
  });

  it("employee читает столы, но не может менять брендинг", async () => {
    const db = ctxFor("empA");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantA/tables/table1")));
    await assertFails(setDoc(doc(db, "tenants/tenantA/branding/config"), { primaryColor: "#000000" }));
  });

  it("manager тоже не может менять брендинг (только owner/admin)", async () => {
    const db = ctxFor("managerA");
    await assertFails(setDoc(doc(db, "tenants/tenantA/branding/config"), { primaryColor: "#000000" }));
  });

  it("owner может менять брендинг своего заведения", async () => {
    const db = ctxFor("ownerA");
    await assertSucceeds(setDoc(doc(db, "tenants/tenantA/branding/config"), { primaryColor: "#000000" }));
  });

  it("employee не может переписать код приглашения устройства (settings — только owner/admin)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantA/settings/deviceInvite"), { code: "AAAAAAAA" });
    });
    const db = ctxFor("empA");
    await assertFails(setDoc(doc(db, "tenants/tenantA/settings/deviceInvite"), { code: "HACKED00" }));
  });

  it("employee может настраивать зарплату сотрудников с кассы, чужому заведению и гостю нельзя", async () => {
    // Регрессия: раньше запись требовала hasRole(['owner','admin']), а
    // устройство кассы, присоединившееся по коду приглашения, ВСЕГДА
    // получает роль employee в tenantMembers (joinAsDevice в
    // saas_device_join_service.dart owner/admin не назначает никогда) —
    // то есть сохранение зарплаты в lib/screens/admin/employees_screen.dart
    // падало permission-denied с любого планшета на любом заведении
    // платформы. См. lib/screens/admin/employees_screen.dart.
    const empDb = ctxFor("empA");
    await assertSucceeds(
      setDoc(doc(empDb, "tenants/tenantA/employees/newHire"),
        { name: "Кто-то", pinCode: "0000", role: "employee", hourlyRateEnabled: true, hourlyRate: 300 })
    );

    const guestDb = ctxFor("guestA");
    await assertFails(
      setDoc(doc(guestDb, "tenants/tenantA/employees/hack"), { name: "Гость", pinCode: "1111", role: "admin" })
    );

    const ownerBDb = ctxFor("ownerB");
    await assertFails(
      setDoc(doc(ownerBDb, "tenants/tenantA/employees/hack"), { name: "Чужой", pinCode: "2222", role: "admin" })
    );
  });

  it("склад/смены/скидочные карты доступны сотруднику, но не гостю или чужому заведению", async () => {
    const empDb = ctxFor("empA");
    await assertSucceeds(setDoc(doc(empDb, "tenants/tenantA/inventory/item1"), { name: "Табак", qty: 5 }));

    const guestDb = ctxFor("guestA");
    await assertFails(getDoc(doc(guestDb, "tenants/tenantA/inventory/item1")));

    const ownerBDb = ctxFor("ownerB");
    await assertFails(getDoc(doc(ownerBDb, "tenants/tenantA/inventory/item1")));
  });

  it("личные смены сотрудников (staffShifts) и служебные указатели открытой смены доступны персоналу, но не гостю или чужому заведению", async () => {
    // Регрессия: правил для staffShifts/meta.shiftState/meta.staffShiftState
    // не было вообще — openShiftIfNeeded/clockIn (см. firestore_service.dart)
    // падали permission-denied, а "Зарплата"/"Смены сотрудников" вечно
    // крутили спиннер.
    const empDb = ctxFor("empA");
    await assertSucceeds(setDoc(doc(empDb, "tenants/tenantA/staffShifts/shift1"),
      { employeeId: "e1", employeeName: "Иван", status: "open" }));
    await assertSucceeds(setDoc(doc(empDb, "tenants/tenantA/meta/shiftState"), { openShiftId: "s1" }));
    await assertSucceeds(setDoc(doc(empDb, "tenants/tenantA/meta/staffShiftState"), { openCount: 1 }));

    const guestDb = ctxFor("guestA");
    await assertFails(getDoc(doc(guestDb, "tenants/tenantA/staffShifts/shift1")));

    const ownerBDb = ctxFor("ownerB");
    await assertFails(getDoc(doc(ownerBDb, "tenants/tenantA/staffShifts/shift1")));
  });

  it("настройки программы лояльности (settings/loyalty) видны и персоналу, и гостю СВОЕГО заведения, пишет любой сотрудник", async () => {
    // Регрессия #1: общее правило settings/{doc} проверяет isMember() —
    // а гость (isTenantGuest) в это понятие не входит вообще (isMember
    // про tenantMembers — консоль/устройство кассы, а не профиль гостя),
    // поэтому расширение settings/{doc} до isTenantGuest было бы дырой:
    // там же лежит settings/deviceInvite (секретный код приглашения
    // устройства). Нужно отдельное, более специфичное правило именно на
    // settings/loyalty.
    //
    // Регрессия #2: запись раньше требовала hasRole(['owner','admin']),
    // но lib/screens/admin/loyalty_settings_screen.dart открывается прямо
    // с кассы, а устройство кассы всегда состоит в tenantMembers с ролью
    // employee (см. saas_device_join_service.dart) — owner/admin оттуда
    // невыполним никогда, и сохранение падало бы permission-denied.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantA/settings/loyalty"), {
        tiers: [{ name: "Бронза", from: 0, cashback: 3 }],
      });
    });
    const empDb = ctxFor("empA");
    await assertSucceeds(getDoc(doc(empDb, "tenants/tenantA/settings/loyalty")));
    await assertSucceeds(setDoc(doc(empDb, "tenants/tenantA/settings/loyalty"), {
      tiers: [{ name: "Бронза", from: 0, cashback: 5 }],
    }));

    const guestDb = ctxFor("guestA");
    await assertSucceeds(getDoc(doc(guestDb, "tenants/tenantA/settings/loyalty")));
    await assertFails(setDoc(doc(guestDb, "tenants/tenantA/settings/loyalty"), { tiers: [] }));

    const ownerBDb = ctxFor("ownerB");
    await assertFails(getDoc(doc(ownerBDb, "tenants/tenantA/settings/loyalty")));
    await assertFails(setDoc(doc(ownerBDb, "tenants/tenantA/settings/loyalty"), { tiers: [] }));

    const ownerADb = ctxFor("ownerA");
    await assertSucceeds(setDoc(doc(ownerADb, "tenants/tenantA/settings/loyalty"), {
      tiers: [{ name: "Бронза", from: 0, cashback: 4 }],
    }));
  });

  it("остальные settings/* (например settings/integrations) пишет любой сотрудник, но не гость и не чужое заведение", async () => {
    // Регрессия: lib/screens/admin/integrations_settings_screen.dart тоже
    // открывается с кассы и падал бы по той же причине, что и employees/
    // settings/loyalty выше — см. их комментарии.
    const empDb = ctxFor("empA");
    await assertSucceeds(setDoc(doc(empDb, "tenants/tenantA/settings/integrations"), { egaisEnabled: true }));

    const guestDb = ctxFor("guestA");
    await assertFails(setDoc(doc(guestDb, "tenants/tenantA/settings/integrations"), { egaisEnabled: false }));

    const ownerBDb = ctxFor("ownerB");
    await assertFails(setDoc(doc(ownerBDb, "tenants/tenantA/settings/integrations"), { egaisEnabled: false }));

    // settings/deviceInvite остаётся исключением — им по-прежнему может
    // писать только owner/admin (см. отдельное правило и тест выше).
    await assertFails(setDoc(doc(empDb, "tenants/tenantA/settings/deviceInvite"), { code: "HACKED00" }));
  });

  it("неактивное членство (status != active) не даёт доступа", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenantMembers/tenantA_firedA"), {
        tenantId: "tenantA", userId: "firedA", role: "employee", status: "removed",
      });
    });
    const db = ctxFor("firedA");
    await assertFails(getDoc(doc(db, "tenants/tenantA/tables/table1")));
  });
});

describe("Список сборок APK и подписки видны только своему заведению", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "buildJobs/job1"), { tenantId: "tenantA", status: "success" });
      await setDoc(doc(db, "subscriptions/tenantA"), { tenantId: "tenantA", status: "active" });
    });
  });

  it("owner A видит свою сборку и подписку", async () => {
    const db = ctxFor("ownerA");
    await assertSucceeds(getDoc(doc(db, "buildJobs/job1")));
    await assertSucceeds(getDoc(doc(db, "subscriptions/tenantA")));
  });

  it("owner B не видит чужую сборку и подписку", async () => {
    const db = ctxFor("ownerB");
    await assertFails(getDoc(doc(db, "buildJobs/job1")));
    await assertFails(getDoc(doc(db, "subscriptions/tenantA")));
  });

  it("employee своего заведения тоже видит подписку (нужно SubscriptionGate на каждом устройстве)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenantMembers/tenantA_empA"), {
        tenantId: "tenantA", userId: "empA", role: "employee", status: "active",
      });
    });
    await assertSucceeds(getDoc(doc(ctxFor("empA"), "subscriptions/tenantA")));
  });

  it("employee чужого заведения не видит подписку tenantA", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenantMembers/tenantB_empB"), {
        tenantId: "tenantB", userId: "empB", role: "employee", status: "active",
      });
    });
    await assertFails(getDoc(doc(ctxFor("empB"), "subscriptions/tenantA")));
  });

  it("клиент не может создать себе buildJob напрямую в обход Cloud Function", async () => {
    const db = ctxFor("ownerA");
    await assertFails(setDoc(doc(db, "buildJobs/freeJob"), { tenantId: "tenantA", status: "queued" }));
  });
});

describe("branding: читает кто угодно без входа (QR-страница стола), пишет только owner/admin", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantA/branding/config"), {
        appName: "Test Lounge", primaryColor: "#123456",
      });
    });
  });

  it("гость, ещё не открывший приложение (совсем без входа), читает брендинг", async () => {
    await assertSucceeds(
      getDoc(doc(testEnv.unauthenticatedContext().firestore(), "tenants/tenantA/branding/config")),
    );
  });

  it("employee не может изменить брендинг своего заведения", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenantMembers/tenantA_empA"), {
        tenantId: "tenantA", userId: "empA", role: "employee", status: "active",
      });
    });
    await assertFails(
      setDoc(doc(ctxFor("empA"), "tenants/tenantA/branding/config"), { appName: "Hacked" }, { merge: true }),
    );
  });

  it("owner может изменить брендинг своего заведения", async () => {
    await assertSucceeds(
      setDoc(doc(ctxFor("ownerA"), "tenants/tenantA/branding/config"), { appName: "New Name" }, { merge: true }),
    );
  });
});

describe("Usage-счётчики: видны владельцу/админу своего заведения и супер-админу", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "tenants/tenantA/usage/current"), { employees: 3, devices: 2, tables: 10 });
      await setDoc(doc(db, "tenantMembers/tenantA_empA"), {
        tenantId: "tenantA", userId: "empA", role: "employee", status: "active",
      });
    });
  });

  it("owner A читает usage своего заведения", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("ownerA"), "tenants/tenantA/usage/current")));
  });

  it("супер-админ читает usage любого заведения", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("root"), "tenants/tenantA/usage/current")));
  });

  it("employee (не owner/admin) не видит usage заведения", async () => {
    await assertFails(getDoc(doc(ctxFor("empA"), "tenants/tenantA/usage/current")));
  });

  it("owner чужого заведения не видит usage tenantA", async () => {
    await assertFails(getDoc(doc(ctxFor("ownerB"), "tenants/tenantA/usage/current")));
  });

  it("клиент не может писать usage напрямую (только Cloud Function)", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "tenants/tenantA/usage/current"), { employees: 999 }));
  });
});

describe("billingEvents: история платежей — владелец видит только своё, супер-админ — всё", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "billingEvents/payment_1"), {
        tenantId: "tenantA", planId: "start", status: "succeeded",
      });
    });
  });

  it("супер-админ читает billingEvents", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("root"), "billingEvents/payment_1")));
  });

  // Правило это разрешает НАМЕРЕННО (см. её же комментарий в
  // firestore.rules — вкладка "Оплата" в консоли строит историю платежей
  // владельца из этой же коллекции) — раньше тест ожидал обратное и просто
  // не запускался достаточно давно, чтобы это разойтись незамеченным.
  it("owner своего же заведения читает billingEvents своего заведения (история платежей)", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("ownerA"), "billingEvents/payment_1")));
  });

  it("owner ЧУЖОГО заведения не читает billingEvents tenantA", async () => {
    await assertFails(getDoc(doc(ctxFor("ownerB"), "billingEvents/payment_1")));
  });

  it("клиент не может писать billingEvents (только Cloud Function)", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "billingEvents/payment_2"), { tenantId: "tenantA" }));
  });
});

describe("Тарифы (plans): управляет только супер-админ, читает кто угодно", () => {
  beforeEach(seedTwoTenants);

  it("любой авторизованный пользователь читает тарифы (нужно до создания заведения)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("plans/start"), { name: "Start", priceRub: 2990 });
    });
    await assertSucceeds(getDoc(doc(ctxFor("ownerA"), "plans/start")));
  });

  it("неавторизованный посетитель лендинга тоже читает тарифы (публичная цена)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("plans/start"), { name: "Start", priceRub: 2990 });
    });
    await assertSucceeds(getDoc(doc(testEnv.unauthenticatedContext().firestore(), "plans/start")));
  });

  it("супер-админ может создать и изменить тариф — панель платформы работает через прямую запись, без Cloud Function", async () => {
    const db = ctxFor("root");
    await assertSucceeds(setDoc(doc(db, "plans/custom-vip"), { name: "VIP", priceRub: 19990 }));
    await assertSucceeds(setDoc(doc(db, "plans/custom-vip"), { priceRub: 24990 }, { merge: true }));
  });

  it("владелец заведения не может менять тарифы платформы", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "plans/start"), { priceRub: 1 }, { merge: true }));
  });
});

describe("supportTickets: обращения в поддержку — видит своё заведение и супер-админ", () => {
  beforeEach(seedTwoTenants);

  it("владелец может создать тикет по своему заведению от своего имени", async () => {
    await assertSucceeds(setDoc(doc(ctxFor("ownerA"), "supportTickets/t1"), {
      tenantId: "tenantA", subject: "Не открывается смена", status: "open", createdBy: "ownerA",
    }));
  });

  it("владелец не может создать тикет от имени другого пользователя", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "supportTickets/t1"), {
      tenantId: "tenantA", subject: "x", status: "open", createdBy: "ownerB",
    }));
  });

  it("владелец не может создать тикет сразу закрытым", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "supportTickets/t1"), {
      tenantId: "tenantA", subject: "x", status: "closed", createdBy: "ownerA",
    }));
  });

  it("владелец чужого заведения не видит тикет tenantA", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("supportTickets/t1"), { tenantId: "tenantA", subject: "x", status: "open", createdBy: "ownerA" });
    });
    await assertFails(getDoc(doc(ctxFor("ownerB"), "supportTickets/t1")));
  });

  it("супер-админ видит и может закрыть любой тикет", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("supportTickets/t1"), { tenantId: "tenantA", subject: "x", status: "open", createdBy: "ownerA" });
    });
    await assertSucceeds(getDoc(doc(ctxFor("root"), "supportTickets/t1")));
    await assertSucceeds(setDoc(doc(ctxFor("root"), "supportTickets/t1"), { status: "closed" }, { merge: true }));
  });

  it("владелец может писать сообщения в свой тикет от своего имени", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("supportTickets/t1"), { tenantId: "tenantA", subject: "x", status: "open", createdBy: "ownerA" });
    });
    await assertSucceeds(setDoc(doc(ctxFor("ownerA"), "supportTickets/t1/messages/m1"), {
      text: "Помогите", authorUid: "ownerA",
    }));
  });

  it("владелец чужого заведения не может писать сообщения в тикет tenantA", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("supportTickets/t1"), { tenantId: "tenantA", subject: "x", status: "open", createdBy: "ownerA" });
    });
    await assertFails(setDoc(doc(ctxFor("ownerB"), "supportTickets/t1/messages/m1"), {
      text: "Помогите", authorUid: "ownerB",
    }));
  });

  it("супер-админ может отвечать в любом тикете", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("supportTickets/t1"), { tenantId: "tenantA", subject: "x", status: "open", createdBy: "ownerA" });
    });
    await assertSucceeds(setDoc(doc(ctxFor("root"), "supportTickets/t1/messages/m2"), {
      text: "Смотрим", authorUid: "root",
    }));
  });
});

describe("platformMetrics: дневные снимки — читает только супер-админ, пишет только Admin SDK", () => {
  beforeEach(seedTwoTenants);

  it("супер-админ читает снимок метрик", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("platformMetrics/2026-09-21"), { mrr: 1000, activeCount: 1 });
    });
    await assertSucceeds(getDoc(doc(ctxFor("root"), "platformMetrics/2026-09-21")));
  });

  it("владелец заведения не читает снимок метрик платформы", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("platformMetrics/2026-09-21"), { mrr: 1000, activeCount: 1 });
    });
    await assertFails(getDoc(doc(ctxFor("ownerA"), "platformMetrics/2026-09-21")));
  });

  it("даже супер-админ не может писать снимок метрик с клиента (только Admin SDK)", async () => {
    await assertFails(setDoc(doc(ctxFor("root"), "platformMetrics/2026-09-21"), { mrr: 1000 }));
  });
});

describe("broadcasts: объявления платформы — пишет только супер-админ, читает кто угодно вошедший", () => {
  beforeEach(seedTwoTenants);

  it("супер-админ может опубликовать объявление", async () => {
    await assertSucceeds(setDoc(doc(ctxFor("root"), "broadcasts/b1"), { title: "Обновление", body: "Текст", active: true }));
  });

  it("владелец заведения читает опубликованные объявления", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("broadcasts/b1"), { title: "Обновление", body: "Текст", active: true });
    });
    await assertSucceeds(getDoc(doc(ctxFor("ownerA"), "broadcasts/b1")));
  });

  it("неавторизованный посетитель не может читать объявления", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("broadcasts/b1"), { title: "Обновление", body: "Текст", active: true });
    });
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), "broadcasts/b1")));
  });

  it("владелец заведения не может опубликовать объявление сам", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "broadcasts/fake"), { title: "Скидка", body: "...", active: true }));
  });

  it("владелец заведения не может деактивировать чужое объявление", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("broadcasts/b1"), { title: "Обновление", body: "Текст", active: true });
    });
    await assertFails(setDoc(doc(ctxFor("ownerA"), "broadcasts/b1"), { active: false }, { merge: true }));
  });
});

describe("superAdmins: только существующий супер-админ может назначать/снимать других", () => {
  beforeEach(seedTwoTenants);

  it("супер-админ может назначить нового супер-админа", async () => {
    await assertSucceeds(setDoc(doc(ctxFor("root"), "superAdmins/ownerA"), { email: "a@x.com" }));
  });

  it("супер-админ может снять доступ у другого супер-админа", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("superAdmins/ownerA"), { email: "a@x.com" });
    });
    await assertSucceeds(deleteDoc(doc(ctxFor("root"), "superAdmins/ownerA")));
  });

  it("обычный владелец не может назначить супер-админом даже самого себя", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "superAdmins/ownerA"), { email: "a@x.com" }));
  });

  it("обычный владелец не может назначить супер-админом кого-то другого", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "superAdmins/ownerB"), { email: "b@x.com" }));
  });

  it("анонимный/сторонний пользователь не может писать в superAdmins", async () => {
    await assertFails(setDoc(doc(ctxFor("stranger"), "superAdmins/stranger"), { email: "s@x.com" }));
  });
});

describe("users: поиск по email для назначения супер-админа (панель платформы)", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("users/ownerA"), { email: "ownera@x.com" });
    });
  });

  it("супер-админ может найти пользователя коллекционным запросом по email", async () => {
    const q = query(collection(ctxFor("root"), "users"), where("email", "==", "ownera@x.com"));
    const snap = await assertSucceeds(getDocs(q));
    assert.strictEqual(snap.size, 1);
  });

  it("обычный владелец не может прочитать чужой профиль users", async () => {
    await assertFails(getDoc(doc(ctxFor("ownerB"), "users/ownerA")));
  });

  it("владелец читает свой собственный профиль users", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("ownerA"), "users/ownerA")));
  });
});

describe("Поддержка клиента из панели платформы: код приглашения и внутренние заметки", () => {
  beforeEach(async () => {
    await seedTwoTenants();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantA/settings/deviceInvite"), { code: "ABC123" });
    });
  });

  it("супер-админ читает код приглашения устройства чужого заведения", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("root"), "tenants/tenantA/settings/deviceInvite")));
  });

  it("владелец чужого заведения не читает код приглашения tenantA", async () => {
    await assertFails(getDoc(doc(ctxFor("ownerB"), "tenants/tenantA/settings/deviceInvite")));
  });

  it("супер-админ пишет и читает внутренние заметки о заведении", async () => {
    await assertSucceeds(setDoc(doc(ctxFor("root"), "tenants/tenantA/internal/adminNotes"), { text: "Платит переводом" }));
    await assertSucceeds(getDoc(doc(ctxFor("root"), "tenants/tenantA/internal/adminNotes")));
  });

  it("владелец заведения не видит и не может создать внутренние заметки платформы", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantA/internal/adminNotes"), { text: "секрет" });
    });
    await assertFails(getDoc(doc(ctxFor("ownerA"), "tenants/tenantA/internal/adminNotes")));
    await assertFails(setDoc(doc(ctxFor("ownerA"), "tenants/tenantA/internal/adminNotes"), { text: "x" }));
  });
});

/**
 * Сеть заведений (chains) — общий биллинг и общая лояльность на несколько
 * точек одного владельца, каждая точка сохраняет свою кассу как прежде.
 * См. docstring "Сети заведений (chains)" в saas/firestore.rules.
 */
async function seedChain() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // Сеть "chainX" из двух точек (tenantX1, tenantX2) владельца chainOwner,
    // плюс контрольное одиночное заведение tenantSolo (без chainId вообще) —
    // чтобы доказать, что для него поведение не изменилось ни на йоту.
    await setDoc(doc(db, "chains/chainX"), { name: "Сеть X", status: "active" });
    await setDoc(doc(db, "tenants/tenantX1"), { name: "Точка 1", slug: "x1", status: "active", chainId: "chainX" });
    await setDoc(doc(db, "tenants/tenantX2"), { name: "Точка 2", slug: "x2", status: "active", chainId: "chainX" });
    await setDoc(doc(db, "tenants/tenantSolo"), { name: "Одиночное", slug: "solo", status: "active" });

    await setDoc(doc(db, "chainMembers/chainX_chainOwner"), {
      chainId: "chainX", userId: "chainOwner", role: "owner", status: "active",
    });
    await setDoc(doc(db, "tenantMembers/tenantX1_chainOwner"), {
      tenantId: "tenantX1", userId: "chainOwner", role: "owner", status: "active",
    });
    await setDoc(doc(db, "tenantMembers/tenantX2_chainOwner"), {
      tenantId: "tenantX2", userId: "chainOwner", role: "owner", status: "active",
    });
    // empX1 — сотрудник ТОЛЬКО точки 1, но с зеркальным chainMembers (как
    // должно быть после joinAsDevice на точке сети, см. saas_device_join_
    // service.dart/console.js syncChainMembership) — обязан видеть общую
    // лояльность сети, а не только свою точку.
    await setDoc(doc(db, "tenantMembers/tenantX1_empX1"), {
      tenantId: "tenantX1", userId: "empX1", role: "employee", status: "active",
    });
    await setDoc(doc(db, "chainMembers/chainX_empX1"), {
      chainId: "chainX", userId: "empX1", role: "employee", status: "active",
    });
    // staleEmp — уволенный когда-то сотрудник другого одиночного заведения:
    // состоит в tenantMembers чужого tenantSolo, но НИКОГДА не состоял ни в
    // одной точке сети chainX — контрольная группа "просто авторизован,
    // но чужой сети".
    await setDoc(doc(db, "tenantMembers/tenantSolo_staleEmp"), {
      tenantId: "tenantSolo", userId: "staleEmp", role: "employee", status: "active",
    });

    await setDoc(doc(db, "tenants/tenantX1/tables/t1"), { name: "Стол 1" });
    await setDoc(doc(db, "tenants/tenantX2/tables/t1"), { name: "Стол 1" });
    await setDoc(doc(db, "tenants/tenantSolo/tables/t1"), { name: "Стол 1" });

    // Гость сети: профиль лежит в chains/chainX/clients, а НЕ в
    // tenants/tenantX1/clients или tenants/tenantX2/clients — в этом и
    // состоит вся разница с одиночным заведением.
    await setDoc(doc(db, "chains/chainX/clients/chainGuest"), {
      name: "Гость сети", activeSessionId: "", bonusBalance: 100,
    });
    // Гость одиночного заведения — профиль на старом месте, как и всегда.
    await setDoc(doc(db, "tenants/tenantSolo/clients/soloGuest"), {
      name: "Гость соло", activeSessionId: "",
    });

    await setDoc(doc(db, "subscriptions/chainX"), { chainId: "chainX", planId: "chain", status: "active" });
    await setDoc(doc(db, "subscriptions/tenantSolo"), { tenantId: "tenantSolo", planId: "start", status: "active" });
  });
}

describe("Сеть заведений (chains) — общая лояльность", () => {
  beforeEach(seedChain);

  it("одиночное заведение продолжает работать по-старому (chainId отсутствует)", async () => {
    const db = ctxFor("staleEmp");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantSolo/tables/t1")));
    await assertSucceeds(getDoc(doc(db, "tenants/tenantSolo/clients/soloGuest")));
  });

  it("гость сети (профиль в chains/chainX/clients) видит зал ОБЕИХ точек своей сети", async () => {
    const db = ctxFor("chainGuest");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantX1/tables/t1")));
    await assertSucceeds(getDoc(doc(db, "tenants/tenantX2/tables/t1")));
  });

  it("гость сети НЕ видит зал чужого одиночного заведения вне его сети", async () => {
    const db = ctxFor("chainGuest");
    await assertFails(getDoc(doc(db, "tenants/tenantSolo/tables/t1")));
  });

  it("сотрудник ТОЛЬКО точки 1 (с зеркальным chainMembers) читает общий профиль гостя сети", async () => {
    const db = ctxFor("empX1");
    await assertSucceeds(getDoc(doc(db, "chains/chainX/clients/chainGuest")));
  });

  it("сотрудник чужого одиночного заведения НЕ читает лояльность сети chainX", async () => {
    const db = ctxFor("staleEmp");
    await assertFails(getDoc(doc(db, "chains/chainX/clients/chainGuest")));
  });

  it("сам гость сети читает свой профиль, но не может сам себе начислить бонусы", async () => {
    const db = ctxFor("chainGuest");
    await assertSucceeds(getDoc(doc(db, "chains/chainX/clients/chainGuest")));
    await assertFails(updateDoc(doc(db, "chains/chainX/clients/chainGuest"), { bonusBalance: 999999 }));
  });

  it("владелец сети читает общую подписку сети (subscriptions/chainX)", async () => {
    await assertSucceeds(getDoc(doc(ctxFor("chainOwner"), "subscriptions/chainX")));
  });

  it("чужой владелец (staleEmp) не читает подписку сети chainX", async () => {
    await assertFails(getDoc(doc(ctxFor("staleEmp"), "subscriptions/chainX")));
  });

  it("гость сети без sessionClaims не может подставить себе чужой activeSessionId", async () => {
    const db = ctxFor("chainGuest");
    await assertFails(
      updateDoc(doc(db, "chains/chainX/clients/chainGuest"), {
        activeSessionId: "someoneElsesSession",
        activeTenantId: "tenantX1",
      })
    );
  });

  it("гость сети, реально занявший чек через sessionClaims точки 1, может проставить activeSessionId", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(ctx.firestore().doc("tenants/tenantX1/sessionClaims/sessReal"), { uid: "chainGuest" });
    });
    const db = ctxFor("chainGuest");
    await assertSucceeds(
      updateDoc(doc(db, "chains/chainX/clients/chainGuest"), {
        activeSessionId: "sessReal",
        activeTenantId: "tenantX1",
      })
    );
  });

  it("после привязки к чеку точки 1 гость сети читает именно этот чек через sessions/{doc}", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const adminDb = ctx.firestore();
      await setDoc(doc(adminDb, "tenants/tenantX1/sessionClaims/sessReal"), { uid: "chainGuest" });
      await setDoc(doc(adminDb, "tenants/tenantX1/sessions/sessReal"), { status: "active" });
      await setDoc(doc(adminDb, "chains/chainX/clients/chainGuest"), {
        name: "Гость сети", activeSessionId: "sessReal", activeTenantId: "tenantX1", bonusBalance: 100,
      });
    });
    const db = ctxFor("chainGuest");
    await assertSucceeds(getDoc(doc(db, "tenants/tenantX1/sessions/sessReal")));
    // Тот же sessionId физически не существует в tenants/tenantX2/sessions —
    // но даже если бы существовал, activeTenantId в профиле гостя привязывает
    // его именно к точке 1, поэтому точка 2 такой чек читать не даёт.
    await assertFails(getDoc(doc(db, "tenants/tenantX2/sessions/sessReal")));
  });

  it("супер-админ читает сеть, подписку сети и общую лояльность", async () => {
    const db = ctxFor("root");
    await assertSucceeds(getDoc(doc(db, "chains/chainX")));
    await assertSucceeds(getDoc(doc(db, "subscriptions/chainX")));
    await assertSucceeds(getDoc(doc(db, "chains/chainX/clients/chainGuest")));
  });
});
