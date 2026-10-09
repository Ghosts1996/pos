/// Статусы заказа с собой и доставки — конечный автомат. Двигаться можно
/// только на следующий шаг, поэтому два сотрудника (касса и Telegram-бот)
/// не собьют статус: второе нажатие того же шага просто не пройдёт.
///
/// Доставка:  new → accepted → cooking → courier → done («Доставлен»)
/// С собой:   new → accepted → cooking → ready   → done («Выдан»)
///
/// Те же правила — в saas-gateway/delivery-flow.js (кнопки Telegram).
class DeliveryFlow {
  DeliveryFlow._();

  static const statuses = ['new', 'accepted', 'cooking', 'courier', 'ready', 'done'];

  static List<String> path(String orderType) => orderType == 'delivery'
      ? const ['new', 'accepted', 'cooking', 'courier', 'done']
      : const ['new', 'accepted', 'cooking', 'ready', 'done'];

  /// Текущий статус; у заказов до появления статусов — «new».
  static String normalize(String orderType, String? status) =>
      path(orderType).contains(status) ? status! : 'new';

  static String? next(String orderType, String? status) {
    final p = path(orderType);
    final i = p.indexOf(normalize(orderType, status));
    return i >= 0 && i < p.length - 1 ? p[i + 1] : null;
  }

  static bool canMove(String orderType, String? from, String to) => next(orderType, from) == to;

  static String label(String orderType, String? status) {
    switch (normalize(orderType, status)) {
      case 'new':
        return 'Новый';
      case 'accepted':
        return 'Принят';
      case 'cooking':
        return 'Готовится';
      case 'courier':
        return 'У курьера';
      case 'ready':
        return 'Готов к выдаче';
      case 'done':
        return orderType == 'delivery' ? 'Доставлен' : 'Выдан';
    }
    return '';
  }

  /// Подпись кнопки «следующий шаг».
  static String? actionLabel(String orderType, String? status) {
    switch (next(orderType, status)) {
      case 'accepted':
        return 'Принять заказ';
      case 'cooking':
        return 'Начать готовить';
      case 'courier':
        return 'Передать курьеру';
      case 'ready':
        return 'Готов к выдаче';
      case 'done':
        return orderType == 'delivery' ? 'Доставлен' : 'Выдан гостю';
    }
    return null;
  }
}
