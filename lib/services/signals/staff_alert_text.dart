import '../../models/client_models.dart';

/// Текст уведомления персоналу. Заголовок — что случилось и где: его
/// одного видно на часах и в свёрнутой шторке. Значок в начале — чтобы
/// тип читался с одного взгляда, слово после него — если часы значки не
/// рисуют.
class StaffAlert {
  final String title;
  final String body;
  const StaffAlert(this.title, this.body);
}

String _table(String t) => t.trim().isEmpty ? 'стол' : t.trim();

StaffAlert callAlert(GuestCallType type, String table, {String comment = ''}) {
  final what = switch (type) {
    GuestCallType.waiter => '🔥 Зовут кальянщика',
    GuestCallType.coal => '🔥 Поменять угли',
    GuestCallType.refill => '🔥 Перезабивка',
    GuestCallType.callWaiter => '🙋 Зовут официанта',
    GuestCallType.bill => '🧾 Просят счёт',
    GuestCallType.paid => '💳 Оплачено онлайн',
  };
  final body = switch (type) {
    GuestCallType.bill => 'Гость ждёт счёт',
    GuestCallType.paid => 'Гость оплатил счёт в приложении — можно закрывать стол',
    GuestCallType.coal => 'Гость просит поменять угли',
    GuestCallType.refill => 'Гость просит перезабить кальян',
    _ => 'Гость ждёт за столом',
  };
  return StaffAlert('$what · ${_table(table)}', comment.isEmpty ? body : '$body · «$comment»');
}

StaffAlert readyAlert(String table, String summary) =>
    StaffAlert('✅ Готово · ${_table(table)}', summary.isEmpty ? 'Можно выносить' : 'Можно выносить: $summary');

/// Готово стоит на раздаче и не отмечено поданным — напоминание официанту.
StaffAlert coldAlert(String table, String dish, {required int minutes}) =>
    StaffAlert('⏳ Остывает · ${_table(table)}', '$dish ждёт на раздаче $minutes мин — заберите или отметьте «Подано»');

StaffAlert guestOrderAlert(String table, String items) =>
    StaffAlert('📱 Заказ из приложения · ${_table(table)}', items);

StaffAlert takeawayAlert({required bool delivery, required String guest, required String items}) => StaffAlert(
    delivery ? '🛵 Доставка из приложения' : '🥡 Заказ с собой из приложения',
    'Позвоните гостю${guest.isEmpty ? '' : ' $guest'} · $items');

StaffAlert reservationAlert({required String guest, required int people, required DateTime at, String comment = ''}) {
  String two(int v) => v.toString().padLeft(2, '0');
  return StaffAlert('📅 Новая бронь · ${two(at.hour)}:${two(at.minute)}',
      '$guest, $people чел.${comment.isEmpty ? '' : ' · «$comment»'}');
}

StaffAlert coalAlert(String table, {required int minutes, required bool afterRefill}) => StaffAlert(
    '🔥 Пора менять угли · ${_table(table)}',
    afterRefill ? 'Прошло $minutes минут после перезабивки' : 'Прошло $minutes минут с начала');

StaffAlert sessionEndAlert(String table, {required int minutes}) => StaffAlert(
    '⏰ Сеанс заканчивается · ${_table(table)}', 'Через $minutes минут — предложите продление или счёт');
