import '../../models/client_models.dart';
import '../../models/session_model.dart';
import '../../services/app_scope.dart';
import '../../services/gateway_api.dart';

/// Заказы доставки и с собой, оформленные гостем в приложении. Создаёт и
/// отменяет их шлюз (проверки, цены из меню, данные гостя — сначала в базу
/// в РФ); гость видит свой заказ напрямую из базы — правила пускают только
/// к своим (clientUid) заказам из приложения.
class DeliveryOrderService {
  DeliveryOrderService._();
  static final instance = DeliveryOrderService._();

  /// Свои заказы за последние двое суток — новые сверху.
  Stream<List<SessionModel>> myOrders(String uid) => AppScope.col('sessions')
      .where('clientUid', isEqualTo: uid)
      .where('source', isEqualTo: 'app')
      .snapshots()
      .map((s) {
        final from = DateTime.now().subtract(const Duration(days: 2));
        return s.docs.map(SessionModel.fromDoc).where((o) => o.startTime.isAfter(from)).toList()
          ..sort((a, b) => b.startTime.compareTo(a.startTime));
      });

  Stream<SessionModel?> order(String sessionId) => AppScope.col('sessions')
      .doc(sessionId)
      .snapshots()
      .map((d) => d.exists ? SessionModel.fromDoc(d) : null);

  /// Позиции, ещё не подтверждённые заведением (до звонка они в заявке).
  Stream<List<GuestOrder>> pending(String uid, String sessionId) => AppScope.col('guestOrders')
      .where('clientUid', isEqualTo: uid)
      .where('sessionId', isEqualTo: sessionId)
      .snapshots()
      .map((s) => s.docs.map(GuestOrder.fromDoc).toList());

  /// → {sessionId, orderNo, total, skipped}.
  Future<Map<String, dynamic>> place(Map<String, dynamic> body) => GatewayApi.post('guestDeliveryOrder', body);

  Future<void> cancel(String sessionId) => GatewayApi.post('guestDeliveryCancel', {'sessionId': sessionId});
}

