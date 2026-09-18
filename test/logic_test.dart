// Тесты чистой логики — той части приложения, что считает деньги, остатки
// и время и не требует ни Firebase, ни виджетов.
//
// Раньше в test/ лежал пустой файл без main(), из-за чего `flutter test`
// падал на загрузке и проверять было нечего.

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/client_models.dart';
import 'package:hookah_pos/models/inventory_models.dart';
import 'package:hookah_pos/models/marking_code.dart';
import 'package:hookah_pos/services/ai/ai_agents.dart' show cleanAiText;
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/models/table_model.dart';
import 'package:hookah_pos/models/venue_models.dart';
import 'package:hookah_pos/models/fiscal_receipt.dart';
import 'package:hookah_pos/models/tenant_models.dart';
import 'package:hookah_pos/services/app_scope.dart';
import 'package:hookah_pos/services/kassa_service.dart';
import 'package:hookah_pos/services/tenant_config_service.dart';
import 'package:hookah_pos/theme/app_theme.dart';
import 'package:hookah_pos/theme/app_colors.dart';
import 'package:hookah_pos/utils/linkify_utils.dart';
import 'package:hookah_pos/utils/phone_utils.dart';
import 'package:hookah_pos/widgets/timer_display.dart';

/// Разделитель групп (GS, 0x1D) внутри кода маркировки.
const gs = '\u001D';

void main() {
  group('Нормализация телефона', () {
    test('все привычные форматы дают один и тот же номер', () {
      const expected = '79995061580';
      expect(normalizePhone('+7 999 506-15-80'), expected);
      expect(normalizePhone('7(999)506-15-80'), expected);
      expect(normalizePhone('8 999 506 15 80'), expected);
      expect(normalizePhone('9995061580'), expected);
      expect(normalizePhone('+79995061580'), expected);
    });

    test('нераспознанный номер не выдаёт себя за российский', () {
      expect(isValidRuPhone(normalizePhone('12345')), isFalse);
      expect(isValidRuPhone(normalizePhone('+44 20 7946 0958')), isFalse);
      expect(isValidRuPhone(normalizePhone('8 999 506 15 80')), isTrue);
    });

    test('пустая строка не превращается в мусорный номер', () {
      expect(normalizePhone('   '), '');
    });
  });

  group('Единицы измерения склада', () {
    test('перевод между совместимыми единицами', () {
      expect(InventoryUnit.g.convertTo(500, InventoryUnit.kg), 0.5);
      expect(InventoryUnit.kg.convertTo(1.5, InventoryUnit.g), 1500);
      expect(InventoryUnit.ml.convertTo(250, InventoryUnit.l), 0.25);
      expect(InventoryUnit.l.convertTo(2, InventoryUnit.ml), 2000);
    });

    test('несовместимые единицы не домысливаются', () {
      // «шт» и «г» физически несопоставимы: величина возвращается как есть,
      // чтобы ошибка настройки позиции не превратилась в тихое умножение
      // остатка на 1000.
      expect(InventoryUnit.pcs.convertTo(5, InventoryUnit.g), 5);
      expect(InventoryUnit.g.convertTo(5, InventoryUnit.pcs), 5);
    });

    test('перевод в ту же единицу ничего не меняет', () {
      for (final u in InventoryUnit.values) {
        expect(u.convertTo(7.25, u), 7.25);
      }
    });

    test('формат числа без лишних нулей', () {
      expect(InventoryUnit.kg.format(1.5), '1.5');
      expect(InventoryUnit.g.format(10), '10');
    });
  });

  group('Итоги чека', () {
    SessionModel session({
      List<OrderItem> items = const [],
      double discountPercent = 0,
      double cash = 0,
      double card = 0,
      double terminal = 0,
      double comp = 0,
    }) {
      final now = DateTime(2026, 1, 1, 20);
      return SessionModel(
        id: 's1',
        tableId: 't1',
        tableName: 'Стол 1',
        employeeName: 'Аня',
        startTime: now,
        plannedEnd: now.add(const Duration(minutes: 90)),
        orderItems: items,
        discountPercent: discountPercent,
        paymentCash: cash,
        paymentCard: card,
        paymentTerminal: terminal,
        paymentComp: comp,
      );
    }

    test('сумма заказа складывается по позициям с учётом количества', () {
      final s = session(items: [
        OrderItem(name: 'Кальян', price: 1200, qty: 2),
        OrderItem(name: 'Чай', price: 300, qty: 3),
      ]);
      expect(s.orderTotal, 3300);
    });

    test('скидка применяется ко всему чеку', () {
      final s = session(
        items: [OrderItem(name: 'Кальян', price: 1000, qty: 1)],
        discountPercent: 15,
      );
      expect(s.totalWithDiscount, 850);
    });

    test('итог оплаты — сумма всех способов', () {
      final s = session(cash: 500, card: 300, terminal: 200, comp: 100);
      expect(s.paymentTotal, 1100);
    });

    test('оплата сходится со счётом со скидкой', () {
      // Так закрывает чек экран оплаты: бонусы и сертификат уезжают в
      // paymentComp, поэтому сумма способов оплаты обязана совпасть с
      // суммой чека после скидки — иначе X-отчёт покажет недостачу.
      final s = session(
        items: [OrderItem(name: 'Кальян', price: 2000, qty: 1)],
        discountPercent: 10,
        cash: 1300,
        comp: 500, // 500 списано бонусами
      );
      expect(s.paymentTotal, s.totalWithDiscount);
    });

    test('пустой заказ не даёт отрицательного итога', () {
      final s = session(discountPercent: 20);
      expect(s.orderTotal, 0);
      expect(s.totalWithDiscount, 0);
    });
  });

  group('Строка заказа', () {
    test('copyWith меняет только количество', () {
      final item = OrderItem(menuItemId: 'm1', name: 'Кальян', price: 1200, qty: 1);
      final updated = item.copyWith(qty: 3);
      expect(updated.menuItemId, 'm1');
      expect(updated.price, 1200);
      expect(updated.qty, 3);
      expect(updated.total, 3600);
    });

    test('сериализация туда-обратно не теряет полей', () {
      final item = OrderItem(menuItemId: 'm1', name: 'Чай', price: 350.5, qty: 2);
      final restored = OrderItem.fromMap(item.toMap());
      expect(restored.menuItemId, item.menuItemId);
      expect(restored.name, item.name);
      expect(restored.price, item.price);
      expect(restored.qty, item.qty);
    });
  });

  group('Таймер стола', () {
    test('формат остатка', () {
      expect(TimerDisplay.formatRemaining(const Duration(minutes: 90)), '01:30:00');
      expect(TimerDisplay.formatRemaining(const Duration(minutes: 5, seconds: 7)), '05:07');
      expect(TimerDisplay.formatRemaining(const Duration(minutes: -3)), '-03:00');
    });

    test('цвет меняется по мере истечения сеанса', () {
      // Именно эта логика раньше вычислялась один раз при построении плитки,
      // и стол на карте зала не краснел по истечении времени.
      expect(TimerDisplay.colorFor(const Duration(minutes: 40)),
          isNot(TimerDisplay.colorFor(const Duration(minutes: 10))));
      expect(TimerDisplay.colorFor(const Duration(minutes: 10)),
          isNot(TimerDisplay.colorFor(const Duration(minutes: -1))));
    });
  });

  group('Уровни лояльности', () {
    ClientProfile guest(double spent) =>
        ClientProfile(uid: 'u1', totalSpent: spent, createdAt: DateTime(2026));

    test('порог каждого уровня', () {
      expect(guest(0).tier, 'Бронза');
      expect(guest(9999).tier, 'Бронза');
      expect(guest(10000).tier, 'Серебро');
      expect(guest(24999).tier, 'Серебро');
      expect(guest(25000).tier, 'Золото');
      expect(guest(49999).tier, 'Золото');
      expect(guest(50000).tier, 'Платина');
      expect(guest(99999).tier, 'Платина');
      expect(guest(100000).tier, 'Алмаз');
      expect(guest(1000000).tier, 'Алмаз');
    });

    test('кешбэк растёт вместе с уровнем', () {
      expect(guest(0).cashbackPercent, 3);
      expect(guest(10000).cashbackPercent, 5);
      expect(guest(25000).cashbackPercent, 7);
      expect(guest(50000).cashbackPercent, 10);
      expect(guest(100000).cashbackPercent, 15);
    });

    test('сколько осталось до следующего уровня', () {
      expect(guest(0).nextTier?.name, 'Серебро');
      expect(guest(0).toNextTier, 10000);
      expect(guest(24000).nextTier?.name, 'Золото');
      expect(guest(24000).toNextTier, 1000);
    });

    test('на максимальном уровне следующего нет', () {
      final top = guest(150000);
      expect(top.nextTier, isNull);
      expect(top.toNextTier, 0);
      expect(top.tierProgress, 1);
    });

    test('прогресс считается внутри текущего уровня', () {
      // Серебро 10 000 → Золото 25 000: на 17 500 пройдена половина.
      expect(guest(17500).tierProgress, closeTo(0.5, 0.001));
      expect(guest(10000).tierProgress, 0);
    });
  });

  group('Очистка текста от ИИ', () {
    test('снимает markdown и служебные подписи', () {
      // Ровно то, что приезжало в ленту гостя вместо сторис.
      expect(cleanAiText('**Сторис 3 — Ночной формат**'), 'Ночной формат');
      expect(cleanAiText('Заголовок: Хит недели'), 'Хит недели');
      expect(cleanAiText('1. Кальян Счастья'), 'Кальян Счастья');
      expect(cleanAiText('### Премиум'), 'Премиум');
    });

    test('склеивает переносы и лишние пробелы', () {
      expect(cleanAiText('Мягкий дым,\n  приятная   цена'), 'Мягкий дым, приятная цена');
    });

    test('обрезает по границе слова, а не по букве', () {
      final v = cleanAiText('Самые яркие вечера начинаются поздно', maxLength: 20);
      expect(v.endsWith('…'), isTrue);
      expect(v.length <= 21, isTrue);
      // Последнее слово не должно оказаться разрезанным пополам.
      expect(v, 'Самые яркие вечера…');
    });

    test('пустое остаётся пустым', () {
      expect(cleanAiText(null), '');
      expect(cleanAiText('   '), '');
      expect(cleanAiText('**  **'), '');
    });
  });

  group('Код маркировки «Честный знак»', () {
    test('разбор кода с разделителем GS', () {
      const raw = '010460406000005621abcd1234${gs}93XYZW';
      final code = MarkingCode.tryParse(raw);
      expect(code, isNotNull);
      expect(code!.gtin, '04604060000056');
      expect(code.serial, 'abcd1234');
      expect(code.cryptoTail, 'XYZW');
    });

    test('обычный штрихкод меню кодом маркировки не считается', () {
      expect(MarkingCode.tryParse('4604060000056'), isNull);
      expect(MarkingCode.tryParse('https://example.com/menu'), isNull);
      expect(MarkingCode.tryParse(''), isNull);
    });

    test('код без серийного номера отбрасывается', () {
      expect(MarkingCode.tryParse('010460406000005621'), isNull);
    });
  });

  group('Подарочный сертификат', () {
    GiftCard card({double bonusAmount = 500, int maxUses = 0, int usedCount = 0,
        bool active = true, DateTime? expiresAt}) {
      return GiftCard(
        code: 'KLB-TEST-0001',
        bonusAmount: bonusAmount,
        maxUses: maxUses,
        usedCount: usedCount,
        active: active,
        createdAt: DateTime(2026, 1, 1),
        expiresAt: expiresAt ?? DateTime(2030, 1, 1),
      );
    }

    test('без лимита активаций код работает, пока не остановят', () {
      expect(card().isUsable, isTrue);
      expect(card().usesLeft, isNull);
      expect(card().problem, isNull);
    });

    test('сумма достаётся каждому, а не делится между всеми', () {
      // Это и отличает сертификат от кошелька: три активации по 500 —
      // это 1500 начислений, а не 500 на троих.
      final c = card(bonusAmount: 500, maxUses: 3);
      expect(c.bonusAmount, 500);
      expect(c.usesLeft, 3);
    });

    test('активации кончились — остальным отказ', () {
      final spent = card(maxUses: 3, usedCount: 3);
      expect(spent.hasUsesLeft, isFalse);
      expect(spent.isUsable, isFalse);
      expect(spent.usesLeft, 0);
      expect(spent.problem, contains('разобрали'));
    });

    test('остаток активаций считается от лимита', () {
      expect(card(maxUses: 3, usedCount: 1).usesLeft, 2);
      expect(card(maxUses: 1).usesLeft, 1);
    });

    test('истёкший срок важнее оставшихся активаций', () {
      final old = card(maxUses: 5, expiresAt: DateTime(2020, 1, 1));
      expect(old.hasUsesLeft, isTrue);
      expect(old.isExpired, isTrue);
      expect(old.isUsable, isFalse);
      expect(old.problem, contains('истёк'));
    });

    test('остановленный код не активируется', () {
      expect(card(active: false).isUsable, isFalse);
      expect(card(active: false).problem, contains('не действует'));
    });

    test('заявка гостя по умолчанию ждёт начисления и ничего не начисляет', () {
      final claim = GiftCardClaim(
        id: 'x',
        code: 'KLB-TEST-0001',
        clientUid: 'uid',
        createdAt: DateTime(2026, 1, 1),
      );
      expect(claim.isPending, isTrue);
      expect(claim.isGranted, isFalse);
      expect(claim.amount, 0);
    });
  });

  group('Привязка к столу', () {
    test('нет номера в профиле — привязка не происходит ни к чему', () {
      const r = TableBindResult.needsPhone();
      expect(r.phoneRequired, isTrue);
      expect(r.isEmpty, isFalse);
      expect(r.needsChoice, isFalse);
      expect(r.sessionId, isNull);
    });

    test('стол без открытых чеков', () {
      const r = TableBindResult.empty();
      expect(r.isEmpty, isTrue);
      expect(r.phoneRequired, isFalse);
      expect(r.needsChoice, isFalse);
    });

    test('один открытый чек — привязка сразу', () {
      const r = TableBindResult.bound('session-1');
      expect(r.sessionId, 'session-1');
      expect(r.isEmpty, isFalse);
      expect(r.needsChoice, isFalse);
    });

    test('несколько чеков — гость выбирает свой', () {
      const r = TableBindResult.choose(
        [TableCheck(id: 'a'), TableCheck(id: 'b')],
        'Стол 3',
      );
      expect(r.needsChoice, isTrue);
      expect(r.isEmpty, isFalse);
      expect(r.tableName, 'Стол 3');
    });
  });

  group('Ссылки в тексте (афиша)', () {
    test('текст без ссылок остаётся одним span без recognizer', () {
      final spans = linkifySpans('Просто текст без ссылок.');
      expect(spans, hasLength(1));
      expect((spans.first as TextSpan).text, 'Просто текст без ссылок.');
      expect((spans.first as TextSpan).recognizer, isNull);
    });

    test('ссылка становится кликабельным span, хвостовая точка — нет', () {
      final spans = linkifySpans(
        'Подписывайтесь: https://t.me/colibrilounge. Ждём вас!',
      );
      final linkSpan = spans.firstWhere(
        (s) => (s as TextSpan).recognizer != null,
      ) as TextSpan;
      expect(linkSpan.text, 'https://t.me/colibrilounge');

      final full = spans.map((s) => (s as TextSpan).text).join();
      expect(full, 'Подписывайтесь: https://t.me/colibrilounge. Ждём вас!');
    });

    test('www-ссылка без протокола тоже находится', () {
      final spans = linkifySpans('Сайт: www.example.com');
      final linkSpan = spans.firstWhere(
        (s) => (s as TextSpan).recognizer != null,
      ) as TextSpan;
      expect(linkSpan.text, 'www.example.com');
    });
  });

  group('Онлайн-касса — коды протоколов', () {
    test('система налогообложения переводится в коды АТОЛ и OrangeData', () {
      expect(FiscalTaxSystem.osn.atolCode, 'osn');
      expect(FiscalTaxSystem.usnIncome.atolCode, 'usn_income');
      expect(FiscalTaxSystem.patent.atolCode, 'patent');
      expect(FiscalTaxSystem.osn.orangeDataCode, 0);
      expect(FiscalTaxSystem.usnIncomeOutcome.orangeDataCode, 2);
      expect(FiscalTaxSystem.patent.orangeDataCode, 5);
    });

    test('неизвестный/пустой код системы налогообложения — по умолчанию ОСН', () {
      expect(FiscalTaxSystemX.fromId(null), FiscalTaxSystem.osn);
      expect(FiscalTaxSystemX.fromId('что-то не то'), FiscalTaxSystem.osn);
      expect(FiscalTaxSystemX.fromId('envd'), FiscalTaxSystem.envd);
    });

    test('способ оплаты АТОЛ: наличные/карта/аванс различаются, неизвестное — «иная форма»', () {
      expect(atolPaymentTypeCode('cash'), 1);
      expect(atolPaymentTypeCode('card'), 2);
      expect(atolPaymentTypeCode('prepayment'), 3);
      expect(atolPaymentTypeCode('other'), 5);
      expect(atolPaymentTypeCode('чепуха'), 5);
    });

    test('способ оплаты OrangeData: свои коды, не совпадающие с АТОЛ', () {
      expect(orangeDataPaymentTypeCode('cash'), 1);
      expect(orangeDataPaymentTypeCode('card'), 2);
      expect(orangeDataPaymentTypeCode('prepayment'), 14);
      expect(orangeDataPaymentTypeCode('other'), 16);
    });

    test('маркированный товар в АТОЛ передаётся как обычный "commodity"', () {
      expect(atolPaymentObjectCode(FiscalPaymentObject.commodity), 'commodity');
      expect(atolPaymentObjectCode(FiscalPaymentObject.markedGood), 'commodity');
      expect(atolPaymentObjectCode(FiscalPaymentObject.service), 'service');
      expect(atolPaymentObjectCode(FiscalPaymentObject.excise), 'excise');
    });

    test('ставки НДС OrangeData: 20%/10%/0%/без НДС — разные коды', () {
      expect(orangeDataVatCode(FiscalVatRate.vat20), 1);
      expect(orangeDataVatCode(FiscalVatRate.vat10), 2);
      expect(orangeDataVatCode(FiscalVatRate.vat0), 5);
      expect(orangeDataVatCode(FiscalVatRate.none), 6);
    });

    test('контакт покупателя определяется по формату: с "@" — email, иначе телефон', () {
      final email = splitReceiptContact('guest@example.com');
      expect(email.email, 'guest@example.com');
      expect(email.phone, isNull);

      final phone = splitReceiptContact('+79995061580');
      expect(phone.phone, '+79995061580');
      expect(phone.email, isNull);

      final empty = splitReceiptContact('  ');
      expect(empty.email, isNull);
      expect(empty.phone, isNull);
    });

    test('OrangeData отказывает в маркированных товарах явным сообщением', () async {
      final service = OrangeDataKassaService(
        inn: '7700000000',
        clientCertPem: 'x',
        clientKeyPem: 'x',
      );
      final result = await service.sendReceipt(const FiscalReceipt(
        receiptId: 'r1',
        items: [
          FiscalReceiptItem(
            name: 'Кальян',
            price: 1000,
            quantity: 1,
            paymentObject: FiscalPaymentObject.markedGood,
            markingCode: '0104600439526936213abc',
          ),
        ],
        payments: [FiscalPayment('cash', 1000)],
      ));
      expect(result.success, isFalse);
      expect(result.errorMessage, contains('АТОЛ'));
    });

    test('CloudKassir — честная заготовка: недоступна, объясняет почему', () async {
      final service = CloudKassirKassaService(apiKey: '');
      expect(service.isAvailable, isFalse);
      final result = await service.sendReceipt(const FiscalReceipt(
        receiptId: 'r2',
        items: [FiscalReceiptItem(name: 'Кальян', price: 1000, quantity: 1)],
        payments: [FiscalPayment('cash', 1000)],
      ));
      expect(result.success, isFalse);
      expect(result.errorMessage, contains('CloudKassir'));
    });

    test('buildKassaService выбирает провайдера по kassaType', () {
      expect(buildKassaService({'kassaType': 'mock'}), isA<MockKassaService>());
      expect(
        buildKassaService({'kassaType': 'atol_cloud', 'kassaInn': '123'}),
        isA<AtolCloudKassaService>(),
      );
      expect(
        buildKassaService({
          'kassaType': 'orange_data',
          'kassaInn': '123',
          'kassaOrangeCertPem': 'x',
          'kassaOrangeKeyPem': 'x',
        }),
        isA<OrangeDataKassaService>(),
      );
      expect(buildKassaService({'kassaType': 'cloud_kassir'}), isA<CloudKassirKassaService>());
      expect(buildKassaService({}), isA<MockKassaService>());
    });
  });

  group('SaaS: статус заведения (tenant status)', () {
    test('trial/active/past_due разрешают операционную работу', () {
      expect(TenantStatus.trial.allowsOperations, isTrue);
      expect(TenantStatus.active.allowsOperations, isTrue);
      expect(TenantStatus.pastDue.allowsOperations, isTrue);
    });

    test('suspended/cancelled/deleted блокируют операционную работу', () {
      expect(TenantStatus.suspended.allowsOperations, isFalse);
      expect(TenantStatus.cancelled.allowsOperations, isFalse);
      expect(TenantStatus.deleted.allowsOperations, isFalse);
    });

    test('владельцу закрыт доступ только у удалённого заведения', () {
      expect(TenantStatus.suspended.allowsOwnerAccess, isTrue);
      expect(TenantStatus.cancelled.allowsOwnerAccess, isTrue);
      expect(TenantStatus.deleted.allowsOwnerAccess, isFalse);
    });

    test('неизвестный/пустой статус по умолчанию — trial', () {
      expect(TenantStatusX.fromId(null), TenantStatus.trial);
      expect(TenantStatusX.fromId('что-то не то'), TenantStatus.trial);
      expect(TenantStatusX.fromId('past_due'), TenantStatus.pastDue);
    });
  });

  group('SaaS: роли (tenant role hierarchy)', () {
    test('owner выше admin выше manager выше employee', () {
      expect(TenantRole.owner.atLeast(TenantRole.admin), isTrue);
      expect(TenantRole.admin.atLeast(TenantRole.owner), isFalse);
      expect(TenantRole.manager.atLeast(TenantRole.employee), isTrue);
      expect(TenantRole.employee.atLeast(TenantRole.manager), isFalse);
    });

    test('роль сравнима сама с собой', () {
      expect(TenantRole.admin.atLeast(TenantRole.admin), isTrue);
    });

    test('неизвестный id роли не сопоставляется ни с чем', () {
      expect(TenantRoleX.fromId('super-hacker'), isNull);
      expect(TenantRoleX.fromId(null), isNull);
      expect(TenantRoleX.fromId('owner'), TenantRole.owner);
    });
  });

  group('SaaS: длительность кальяна заведения (session settings)', () {
    test('длительность внутри границ не меняется', () {
      const s = SessionSettings(minimumHookahDurationMinutes: 30, maximumHookahDurationMinutes: 360);
      expect(s.clampMinutes(90), 90);
    });

    test('слишком короткая/длинная зажимается по границам заведения', () {
      const s = SessionSettings(minimumHookahDurationMinutes: 30, maximumHookahDurationMinutes: 360);
      expect(s.clampMinutes(5), 30);
      expect(s.clampMinutes(500), 360);
    });

    test('у разных заведений разные стандартные длительности не пересекаются', () {
      final a = SessionSettings.fromMap({'defaultHookahDurationMinutes': 90});
      final b = SessionSettings.fromMap({'defaultHookahDurationMinutes': 120});
      expect(a.defaultHookahDurationMinutes, 90);
      expect(b.defaultHookahDurationMinutes, 120);
    });
  });

  group('SaaS: приоритет feature-флагов platform → plan → tenant', () {
    test('tenant перекрывает plan и platform', () {
      const flags = FeatureFlags(
        platform: {'ai': false},
        plan: {'ai': true},
        tenant: {'ai': false},
      );
      expect(flags.isEnabled('ai'), isFalse);
    });

    test('при отсутствии значения на уровне tenant используется plan', () {
      const flags = FeatureFlags(plan: {'reservations': true});
      expect(flags.isEnabled('reservations'), isTrue);
    });

    test('при отсутствии всюду используется значение по умолчанию', () {
      const flags = FeatureFlags();
      expect(flags.isEnabled('advancedReports', defaultValue: false), isFalse);
      expect(flags.isEnabled('advancedReports', defaultValue: true), isTrue);
    });
  });

  group('SaaS: подписка и лимиты тарифа', () {
    test('пробный период, заканчивающийся через день, считается "скоро истекает" при окне 3 дня', () {
      final sub = SubscriptionInfo(
        tenantId: 't1',
        planId: 'start',
        status: 'trial',
        trialEndsAt: DateTime(2026, 1, 4),
      );
      final now = DateTime(2026, 1, 3);
      expect(sub.isTrialExpiringWithin(const Duration(days: 3), now: now), isTrue);
      expect(sub.isTrialExpiringWithin(const Duration(hours: 1), now: now), isFalse);
    });

    test('лимит тарифа: 0 или отрицательное значение — без ограничений', () {
      const plan = PlanLimits(
        planId: 'enterprise',
        maxEmployees: 0,
        maxDevices: 0,
        maxTables: 0,
        maxStorageMb: 0,
        aiEnabled: true,
        customBranding: true,
        customDomain: true,
      );
      expect(plan.isWithinLimit(9999, plan.maxEmployees), isTrue);
    });

    test('лимит тарифа: обычное положительное ограничение реально ограничивает', () {
      const plan = PlanLimits(
        planId: 'start',
        maxEmployees: 3,
        maxDevices: 1,
        maxTables: 10,
        maxStorageMb: 500,
        aiEnabled: false,
        customBranding: false,
        customDomain: false,
      );
      expect(plan.isWithinLimit(2, plan.maxEmployees), isTrue);
      expect(plan.isWithinLimit(3, plan.maxEmployees), isFalse);
    });
  });

  group('SaaS: SubscriptionInfo.daysUntilDataPurge — льготный период перед удалением данных', () {
    test('не в просрочке — до удаления считать нечего', () {
      const sub = SubscriptionInfo(tenantId: 't1', planId: 'start', status: 'active');
      expect(sub.daysUntilDataPurge(), isNull);
    });

    test('просрочка началась только что — впереди весь льготный период', () {
      final now = DateTime(2026, 1, 20);
      final sub = SubscriptionInfo(
        tenantId: 't1', planId: 'start', status: 'past_due', pastDueSince: now,
      );
      expect(sub.daysUntilDataPurge(now: now), gracePeriodDays);
    });

    test('половина льготного периода прошла', () {
      final since = DateTime(2026, 1, 10);
      final now = DateTime(2026, 1, 15); // +5 дней из 10
      final sub = SubscriptionInfo(
        tenantId: 't1', planId: 'start', status: 'past_due', pastDueSince: since,
      );
      expect(sub.daysUntilDataPurge(now: now), 5);
    });

    test('льготный период уже истёк — не уходит в минус', () {
      final since = DateTime(2026, 1, 1);
      final now = DateTime(2026, 2, 1); // сильно больше 10 дней
      final sub = SubscriptionInfo(
        tenantId: 't1', planId: 'start', status: 'past_due', pastDueSince: since,
      );
      expect(sub.daysUntilDataPurge(now: now), 0);
    });

    test('pastDueSince читается из Firestore-документа', () {
      final sub = SubscriptionInfo.fromMap({
        'planId': 'start',
        'status': 'past_due',
        'pastDueSince': Timestamp.fromDate(DateTime(2026, 1, 1)),
      }, 't1');
      expect(sub.pastDueSince, DateTime(2026, 1, 1));
    });
  });

  group('SaaS: TenantConfig.operationsAllowed', () {
    TenantConfig buildConfig({required TenantStatus status, required String subStatus}) {
      return TenantConfig(
        tenant: Tenant(
          id: 't1', name: 'Test', slug: 'test', status: status, planId: 'start', ownerUserId: 'u1',
        ),
        member: const TenantMember(tenantId: 't1', userId: 'u1', role: TenantRole.owner, status: 'active'),
        branding: const BrandingConfig(),
        session: const SessionSettings(),
        features: const FeatureFlags(),
        subscription: SubscriptionInfo(tenantId: 't1', planId: 'start', status: subStatus),
      );
    }

    test('активное заведение с активной подпиской — работа разрешена', () {
      expect(buildConfig(status: TenantStatus.active, subStatus: 'active').operationsAllowed, isTrue);
    });

    test('заблокированное заведение — работа запрещена, даже если подписка формально active', () {
      expect(buildConfig(status: TenantStatus.suspended, subStatus: 'active').operationsAllowed, isFalse);
    });

    test('отменённая подписка блокирует работу, даже если сам tenant ещё не помечен', () {
      expect(buildConfig(status: TenantStatus.active, subStatus: 'cancelled').operationsAllowed, isFalse);
    });

    test('round-trip сериализации конфигурации в локальный кэш не теряет данные', () {
      final original = buildConfig(status: TenantStatus.trial, subStatus: 'trial');
      final restored = tenantConfigFromCacheMap(tenantConfigToCacheMap(original));
      expect(restored.tenant.id, original.tenant.id);
      expect(restored.tenant.status, original.tenant.status);
      expect(restored.member.role, original.member.role);
      expect(restored.session.defaultHookahDurationMinutes, original.session.defaultHookahDurationMinutes);
      expect(restored.subscription.status, original.subscription.status);
    });
  });

  group('SaaS: AppScope — переключатель одно-арендного/SaaS режима', () {
    // AppScope — глобальный синглтон-переключатель, поэтому явно сбрасываем
    // его до и после каждого теста, иначе тесты влияют друг на друга.
    setUp(AppScope.reset);
    tearDown(AppScope.reset);

    test('по умолчанию — одно-арендный режим', () {
      expect(AppScope.isSaasMode, isFalse);
      expect(AppScope.tenantId, isNull);
    });

    test('enterTenant включает SaaS-режим', () {
      AppScope.enterTenant('tenantA');
      expect(AppScope.isSaasMode, isTrue);
      expect(AppScope.tenantId, 'tenantA');
    });

    test('reset() возвращает в одно-арендный режим', () {
      AppScope.enterTenant('tenantA');
      AppScope.reset();
      expect(AppScope.isSaasMode, isFalse);
      expect(AppScope.tenantId, isNull);
    });

    test('пустой tenantId в enterTenant отклоняется явной ошибкой', () {
      expect(() => AppScope.enterTenant(''), throwsArgumentError);
      expect(() => AppScope.enterTenant('   '), throwsArgumentError);
    });

    test('branding отсутствует, пока не передан явно', () {
      AppScope.enterTenant('tenantA');
      expect(AppScope.branding, isNull);
    });

    test('branding сохраняется вместе с enterTenant и снова null после reset()', () {
      const branding = BrandingConfig(appName: 'Тестовое заведение');
      AppScope.enterTenant('tenantA', branding: branding);
      expect(AppScope.branding?.appName, 'Тестовое заведение');
      AppScope.reset();
      expect(AppScope.branding, isNull);
    });
  });

  group('SaaS: scopedPath — построение пути к данным (без реального Firebase)', () {
    test('без арендатора путь не меняется — гарантия для текущего живого заведения', () {
      expect(scopedPath(null, 'sessions'), 'sessions');
      expect(scopedPath(null, 'meta/aiSettings'), 'meta/aiSettings');
    });

    test('с арендатором путь вкладывается под tenants/{id}/', () {
      expect(scopedPath('tenantA', 'sessions'), 'tenants/tenantA/sessions');
      expect(scopedPath('tenantA', 'meta/aiSettings'), 'tenants/tenantA/meta/aiSettings');
    });

    test('разные арендаторы получают непересекающиеся пути к одной и той же коллекции', () {
      final pathA = scopedPath('tenantA', 'tables');
      final pathB = scopedPath('tenantB', 'tables');
      expect(pathA, isNot(equals(pathB)));
      expect(pathA, 'tenants/tenantA/tables');
      expect(pathB, 'tenants/tenantB/tables');
    });
  });

  group('SaaS: AppTheme.branded — фирменный цвет заведения', () {
    test('корректный HEX-цвет применяется как primary', () {
      const branding = BrandingConfig(primaryColor: '#C7A45D');
      final theme = AppTheme.branded(branding);
      expect(theme.colorScheme.primary, const Color(0xFFC7A45D));
    });

    test('цвет без # тоже разбирается', () {
      const branding = BrandingConfig(primaryColor: '112233');
      final theme = AppTheme.branded(branding);
      expect(theme.colorScheme.primary, const Color(0xFF112233));
    });

    test('битый HEX откатывается на цвет темы по умолчанию, а не падает', () {
      const branding = BrandingConfig(primaryColor: 'не-цвет');
      final theme = AppTheme.branded(branding);
      expect(theme.colorScheme.primary, AppTheme.dark.colorScheme.primary);
    });

    test('база темы (тёмная, без брендинга) не меняется веткой branded', () {
      expect(AppTheme.dark.brightness, Brightness.dark);
    });

    test('вторичный цвет и цвет кнопки применяются отдельно от primary', () {
      const branding = BrandingConfig(
        primaryColor: '#111111',
        secondaryColor: '#222222',
        buttonColor: '#333333',
      );
      final theme = AppTheme.branded(branding);
      expect(theme.colorScheme.primary, const Color(0xFF111111));
      expect(theme.colorScheme.secondary, const Color(0xFF222222));
      expect(
        theme.elevatedButtonTheme.style?.backgroundColor?.resolve({}),
        const Color(0xFF333333),
      );
    });

    test('фон и цвет текста с достаточным контрастом применяются как есть', () {
      const branding = BrandingConfig(backgroundColor: '#000000', textColor: '#FFFFFF');
      final theme = AppTheme.branded(branding);
      expect(theme.scaffoldBackgroundColor, const Color(0xFF000000));
      expect(theme.textTheme.bodyMedium?.color, const Color(0xFFFFFFFF));
    });

    test('фон и текст слишком похожи — откатывается на цвета темы по умолчанию', () {
      // Тёмно-синий на чёрном — валидный HEX, но нечитаемая пара на планшете.
      const branding = BrandingConfig(backgroundColor: '#000000', textColor: '#0A0A12');
      final theme = AppTheme.branded(branding);
      expect(theme.scaffoldBackgroundColor, AppColors.background);
      expect(theme.textTheme.bodyMedium?.color, AppColors.textPrimary);
    });
  });
}
