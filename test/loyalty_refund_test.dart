import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/client_models.dart';
import 'package:hookah_pos/utils/loyalty_refund.dart';

void main() {
  group('возврат чека и лояльность гостя', () {
    test('кешбэк забирается, оплаченные бонусами возвращаются, визит снимается', () {
      final r = applyLoyaltyRefund(
        balance: 500,
        totalSpent: 12000,
        visits: 7,
        earned: 90,
        bonusSpent: 200,
        visitTotal: 3000,
      );
      expect(r.balance, 610); // 500 − 90 + 200
      expect(r.totalSpent, 9000);
      expect(r.visits, 6);
      expect(r.refund.taken, 90);
      expect(r.refund.returned, 200);
    });

    test('потраченный кешбэк не уводит баланс в минус', () {
      final r = applyLoyaltyRefund(
        balance: 30,
        totalSpent: 3000,
        visits: 1,
        earned: 90,
        bonusSpent: 0,
        visitTotal: 3000,
      );
      expect(r.balance, 0);
      expect(r.refund.taken, 30);
      expect(r.totalSpent, 0);
      expect(r.visits, 0);
    });

    test('отмена возврата возвращает ровно то, что снял возврат', () {
      final refunded = applyLoyaltyRefund(
        balance: 500,
        totalSpent: 12000,
        visits: 7,
        earned: 90,
        bonusSpent: 200,
        visitTotal: 3000,
      );
      final back = undoLoyaltyRefund(
        balance: refunded.balance,
        totalSpent: refunded.totalSpent,
        visits: refunded.visits,
        refund: LoyaltyRefund.fromMap(refunded.refund.toMap('uid')),
      );
      expect(back.balance, 500);
      expect(back.totalSpent, 12000);
      expect(back.visits, 7);
      expect(back.reclaimed, 200);
    });

    test('вернувшиеся бонусы уже потрачены — отмена не уводит баланс в минус', () {
      const refund = LoyaltyRefund(taken: 90, returned: 200, spent: 3000, visits: 1);
      final back = undoLoyaltyRefund(balance: 50, totalSpent: 0, visits: 0, refund: refund);
      expect(back.reclaimed, 140); // 50 + 90 — больше списать нечего
      expect(back.balance, 0);
      expect(back.totalSpent, 3000);
      expect(back.visits, 1);
    });
  });

  group('история бонусов гостя', () {
    test('начисление за визит показывает бонусы, а не оплаченную сумму', () {
      final op = BonusOpView.fromMap({'type': 'accrual', 'amount': 3000, 'bonus': 90});
      expect(op.plus, isTrue);
      expect(op.bonuses, 90);
      expect(op.title, 'Начисление за визит');
    });

    test('отменённая оплата бонусами — плюс на счёт', () {
      final op = BonusOpView.fromMap({'type': 'redeem_cancelled', 'amount': 200});
      expect(op.plus, isTrue);
      expect(op.title, 'Оплата бонусами отменена');
    });

    test('возврат чека подписан понятно для гостя', () {
      final taken = BonusOpView.fromMap({'type': 'refund_reversal', 'reason': 'refund', 'amount': 90});
      expect(taken.plus, isFalse);
      expect(taken.title, 'Возврат чека: бонусы за визит отменены');
      final back = BonusOpView.fromMap({'type': 'redeem_cancelled', 'reason': 'refund', 'amount': 200});
      expect(back.plus, isTrue);
      expect(back.title, 'Возврат чека: бонусы вернулись');
    });

    test('подарок ко дню рождения', () {
      final op = BonusOpView.fromMap({'type': 'accrual', 'reason': 'birthday', 'amount': 500});
      expect(op.title, 'Подарок ко дню рождения');
      expect(op.bonuses, 500);
    });
  });
}
