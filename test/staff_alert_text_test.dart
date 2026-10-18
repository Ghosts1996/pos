import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/client_models.dart';
import 'package:hookah_pos/services/signals/staff_alert_text.dart';

void main() {
  test('по заголовку видно, кого зовут и куда', () {
    expect(callAlert(GuestCallType.waiter, 'Стол 3').title, '🔥 Зовут кальянщика · Стол 3');
    expect(callAlert(GuestCallType.callWaiter, 'Стол 3').title, '🙋 Зовут официанта · Стол 3');
    expect(callAlert(GuestCallType.bill, 'Диван 8').title, '🧾 Просят счёт · Диван 8');
    expect(callAlert(GuestCallType.coal, '').title, '🔥 Поменять угли · стол');
    expect(callAlert(GuestCallType.callWaiter, 'Стол 1', comment: 'воды').body, 'Гость ждёт за столом · «воды»');
    expect(readyAlert('Стол 5', 'Цезарь ×2').title, '✅ Готово · Стол 5');
    expect(readyAlert('Стол 5', 'Цезарь ×2').body, 'Можно выносить: Цезарь ×2');
    expect(coldAlert('Стол 5', 'Цезарь', minutes: 5).title, '⏳ Остывает · Стол 5');
    expect(coldAlert('Стол 5', 'Цезарь', minutes: 5).body, 'Цезарь ждёт на раздаче 5 мин — заберите или отметьте «Подано»');
    expect(guestOrderAlert('Стол 2', 'Чай ×1').title, '📱 Заказ из приложения · Стол 2');
    expect(takeawayAlert(delivery: true, guest: 'Анна', items: 'Пицца ×1').title, '🛵 Доставка из приложения');
    expect(reservationAlert(guest: 'Анна', people: 4, at: DateTime(2026, 10, 17, 19, 5)).title, '📅 Новая бронь · 19:05');
    expect(coalAlert('Стол 1', minutes: 35, afterRefill: false).title, '🔥 Пора менять угли · Стол 1');
    expect(sessionEndAlert('Стол 1', minutes: 10).title, '⏰ Сеанс заканчивается · Стол 1');
  });
}
