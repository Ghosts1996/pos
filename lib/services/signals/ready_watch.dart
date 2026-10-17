import '../../models/session_model.dart';
import '../../utils/constants.dart';

/// Сколько готово по строкам чека: lineId → ready.
Map<String, int> readyByLine(List<OrderItem> items) => {for (final i in items) i.lineId: i.ready};

/// Строки, где готовых стало больше, чем в [before]. Первое появление
/// чека ([before] == null) — не сигнал: это то, что уже было.
List<OrderItem> readyIncreases(Map<String, int>? before, List<OrderItem> items) {
  if (before == null) return const [];
  return [for (final i in items) if (i.ready > (before[i.lineId] ?? 0)) i];
}

/// Звенит ли «готово» у этого сотрудника.
///
/// Официант чека — всегда. Если его нет на смене (ушёл, чек открывал
/// админ) или чек без официанта, зовём тех, кто выносит блюда: официантов
/// и универсалов на смене этого устройства ([mine]).
bool readyIsMine({
  required String checkWaiterId,
  required String myId,
  required Set<String> onShift,
  required bool mine,
  required String myPosition,
}) {
  if (myId.isNotEmpty && checkWaiterId == myId) return true;
  final waiterAway = checkWaiterId.isEmpty || (onShift.isNotEmpty && !onShift.contains(checkWaiterId));
  if (!waiterAway || !mine) return false;
  return myPosition == AppConstants.positionUniversal || myPosition == AppConstants.positionWaiter;
}

/// «Цезарь ×2, Лимонад» — что вынести.
String readySummary(List<OrderItem> lines) =>
    lines.map((i) => i.ready > 1 ? '${i.displayName} ×${i.ready}' : i.displayName).join(', ');
