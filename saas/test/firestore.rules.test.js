/**
 * Обязательный security-тест из ТЗ (§10, §69): пользователь Tenant A не
 * должен читать/писать данные Tenant B, и наоборот — для гостя, для
 * персонала разных ролей и для попытки создать/сменить себе tenant в обход
 * бэкенда. Плюс супер-админ должен видеть оба.
 *
 * Запуск:
 *   cd saas/test && npm i
 *   npx firebase emulators:exec --project colibri-saas-rules-test \
 *     --only firestore "npm test"
 * (или см. saas/test/run.sh — обёртка с тем же вызовом)
 */
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, updateDoc } = require("firebase/firestore");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const PROJECT_ID = "colibri-saas-rules-test";

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

  it("employee не может изменить список сотрудников (только owner/admin)", async () => {
    const db = ctxFor("empA");
    await assertFails(
      setDoc(doc(db, "tenants/tenantA/employees/newHire"), { name: "Кто-то", pinCode: "0000", role: "admin" })
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

  it("клиент не может создать себе buildJob напрямую в обход Cloud Function", async () => {
    const db = ctxFor("ownerA");
    await assertFails(setDoc(doc(db, "buildJobs/freeJob"), { tenantId: "tenantA", status: "queued" }));
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

describe("billingEvents: идемпотентность webhook'а видна только супер-админу", () => {
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

  it("owner своего же заведения не может читать billingEvents напрямую", async () => {
    await assertFails(getDoc(doc(ctxFor("ownerA"), "billingEvents/payment_1")));
  });

  it("клиент не может писать billingEvents (только Cloud Function)", async () => {
    await assertFails(setDoc(doc(ctxFor("ownerA"), "billingEvents/payment_2"), { tenantId: "tenantA" }));
  });
});
