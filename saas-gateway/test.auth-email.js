"use strict";

// Письма платформы: все типы собираются, в оформлении сайта, ссылки — на
// страницы кабинета, без адресов Google; текст и HTML экранированы.

const assert = require("assert");
const A = require("./auth-email");

const site = "https://zalpos.ru/";
let n = 0;
const t = (name, fn) => { fn(); n++; };

t("ссылки Firebase → страницы кабинета", () => {
  const fb = "https://saas-3bdc8.firebaseapp.com/__/auth/action";
  assert.strictEqual(A.brandAuthLink(`${fb}?mode=resetPassword&oobCode=A_b-1&apiKey=K&continueUrl=https%3A%2F%2Fzalpos.ru%2F%23%2Fpartner&lang=ru`, site),
    "https://zalpos.ru/#/auth?mode=resetPassword&code=A_b-1&continueUrl=https%3A%2F%2Fzalpos.ru%2F%23%2Fpartner");
  assert.strictEqual(A.brandAuthLink(`${fb}?mode=verifyEmail&oobCode=V1&apiKey=K`, site), "https://zalpos.ru/#/auth?mode=verifyEmail&code=V1");
  assert.strictEqual(A.brandAuthLink(`${fb}?apiKey=K&mode=signIn&oobCode=S1&continueUrl=https%3A%2F%2Fzalpos.ru%2F%23%2F&lang=ru`, site),
    "https://zalpos.ru/?apiKey=K&oobCode=S1&mode=signIn&lang=ru#/");
  const own = "https://zalpos.ru/#/auth?mode=signIn&code=x";
  assert.strictEqual(A.brandAuthLink(own, site), own, "свои ссылки не меняются");
  assert.strictEqual(A.brandAuthLink("не ссылка", site), "не ссылка");
});

t("все письма собираются в оформлении сайта", () => {
  const all = [
    ...A.AUTH_EMAIL_TYPES.map((k) => A.authEmailLetter(k, "https://zalpos.ru/#/auth?mode=x&code=y", { siteUrl: site })),
    A.passwordLetter("zal-AAAA-BBBB-CCCC", { siteUrl: site }),
    A.partnerInviteLetter({ managerName: "Анна", venueName: "Кафе", link: "https://zalpos.ru/#/signup", optOutLink: "https://zalpos.ru/x", siteUrl: site }),
    A.partnerWelcomeLetter({ name: "Анна", link: "https://zalpos.ru/#/auth?mode=resetPassword&code=y", siteUrl: site }),
    A.superAdminGrantedLetter({ byEmail: "a@b.ru", siteUrl: site }),
    A.superAdminRevokedLetter({ siteUrl: site }),
    A.partnerTelegramLetter({ username: "anna", siteUrl: site }),
    A.passwordChangedLetter({ siteUrl: site }),
  ];
  for (const l of all) {
    assert.ok(l.subject && l.text && l.html, "тема, текст и HTML");
    assert.ok(l.html.includes("#F3EEE6") && l.html.includes("#A4502A"), `${l.subject}: цвета сайта`);
    assert.ok(!/google|gstatic|firebase/i.test(l.html + l.text), `${l.subject}: без адресов Google`);
    assert.ok(l.text.includes("zalpos.ru"), `${l.subject}: адрес сайта в тексте`);
  }
});

t("экранирование", () => {
  const l = A.partnerWelcomeLetter({ name: "<b>Иван</b>", link: "https://zalpos.ru/?a=1&b=2", siteUrl: site });
  assert.ok(!l.html.includes("<b>Иван</b>") && l.html.includes("&lt;b&gt;Иван"));
  assert.ok(l.html.includes("a=1&amp;b=2"));
});

t("без кнопки — без строки «Кнопка не открывается»", () => {
  const l = A.superAdminRevokedLetter({ siteUrl: site });
  assert.ok(!l.html.includes("Кнопка не открывается"));
});

console.log(`auth-email: ${n} проверок`);
