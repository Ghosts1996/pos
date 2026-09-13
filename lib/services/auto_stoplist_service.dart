import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/inventory_models.dart';
import '../models/menu_models.dart';

/// Автоматический стоп-лист.
///
/// Следит за остатками склада и снимает с продажи позиции меню, на которые
/// физически не хватает ингредиентов, а при поступлении товара возвращает их
/// обратно. Это убирает главный конфликт клиентского приложения: гость не
/// должен видеть в «Colibri Lounge» то, чего нет в зале.
///
/// Возвращает в продажу только те позиции, которые сам же и снял (флаг
/// autoStopped), чтобы не «воскресить» позицию, убранную администратором
/// вручную.
class AutoStopListService {
  AutoStopListService._();
  static final AutoStopListService instance = AutoStopListService._();

  final _db = FirebaseFirestore.instance;
  StreamSubscription? _sub;
  Timer? _pending;

  /// Не чаще одного пересчёта в минуту: склад «шумит» при инвентаризации.
  static const _cooldown = Duration(seconds: 60);

  /// Запускается один раз при входе сотрудника на POS.
  void start() {
    _sub?.cancel();
    _sub = _db.collection('inventoryItems').snapshots().listen(
      (_) => _scheduleSync(),
      // Пока планшет не зарегистрирован как рабочее устройство, прав на
      // склад нет и стрим завершается ошибкой. Это не повод сыпать
      // необработанными исключениями в консоль при каждом старте.
      onError: (_) {},
    );
  }

  /// Откладывает пересчёт на [_cooldown], сбрасывая уже запланированный.
  ///
  /// Раньше здесь стояла обратная логика: изменения, пришедшие раньше чем
  /// через минуту после прошлого пересчёта, просто ОТБРАСЫВАЛИСЬ. Если
  /// приход товара приходил в эту минуту и больше склад не трогали,
  /// стоп-лист не пересчитывался вообще — позиция так и висела снятой с
  /// продажи (или, наоборот, продавалась при нулевом остатке) до
  /// следующего изменения склада. Теперь последнее изменение всегда
  /// доезжает: таймер только сдвигается.
  void _scheduleSync() {
    _pending?.cancel();
    _pending = Timer(_cooldown, () => unawaited(sync()));
  }

  void stop() {
    _sub?.cancel();
    _sub = null;
    _pending?.cancel();
    _pending = null;
  }

  /// Полный пересчёт стоп-листа. Можно дёрнуть вручную из админки.
  /// Возвращает описание изменений для показа сотруднику.
  Future<List<String>> sync() async {
    final invSnap = await _db.collection('inventoryItems').get();
    final stock = <String, InventoryItem>{
      for (final d in invSnap.docs) d.id: InventoryItem.fromDoc(d)
    };

    final menuSnap = await _db.collection('menuItems').get();
    final changes = <String>[];
    final batch = _db.batch();

    for (final doc in menuSnap.docs) {
      final item = MenuItem.fromDoc(doc);
      if (!item.hasAnyInventoryLink) continue;

      final missing = _missingIngredients(item, stock);
      final data = doc.data();
      final autoStopped = data['autoStopped'] == true;

      if (missing.isNotEmpty && item.available) {
        batch.update(doc.reference, {
          'available': false,
          'autoStopped': true,
          'autoStopReason': 'Нет: ${missing.join(', ')}',
          'autoStoppedAt': Timestamp.fromDate(DateTime.now()),
        });
        changes.add('Стоп: ${item.name} (${missing.join(', ')})');
      } else if (missing.isEmpty && !item.available && autoStopped) {
        batch.update(doc.reference, {
          'available': true,
          'autoStopped': false,
          'autoStopReason': '',
        });
        changes.add('В продажу: ${item.name}');
      }
    }

    if (changes.isNotEmpty) {
      await batch.commit();
      await _db.collection('staffNotes').add({
        'title': 'Автостоп-лист',
        'text': changes.join('\n'),
        'priority': 'warning',
        'source': 'auto_stoplist',
        'createdAt': Timestamp.fromDate(DateTime.now()),
        'read': false,
      });
    }
    return changes;
  }

  /// Ингредиенты, которых не хватает хотя бы на одну порцию.
  List<String> _missingIngredients(MenuItem item, Map<String, InventoryItem> stock) {
    final missing = <String>[];

    void check(String itemId, double need, InventoryUnit unit) {
      final inv = stock[itemId];
      if (inv == null) return; // связь битая — не трогаем позицию
      if (!inv.active) {
        missing.add(inv.name);
        return;
      }
      final needInStockUnit = _convert(need, unit, inv.unit);
      if (needInStockUnit == null) return; // единицы несопоставимы — пропускаем
      if (inv.quantity < needInStockUnit) missing.add(inv.name);
    }

    if (item.isComposite) {
      for (final c in item.components) {
        check(c.inventoryItemId, c.weight, c.weightUnit);
      }
    } else if (item.hasInventoryLink) {
      check(item.inventoryItemId, item.weight, item.weightUnit);
    }
    return missing;
  }

  /// Перевод граммов/килограммов и миллилитров/литров. Штуки переводятся
  /// только в штуки; несовместимые пары дают null — такие позиции
  /// автоматика не трогает.
  double? _convert(double value, InventoryUnit from, InventoryUnit to) {
    if (from == to) return value;
    const toBase = {
      InventoryUnit.g: 1.0,
      InventoryUnit.kg: 1000.0,
      InventoryUnit.ml: 1.0,
      InventoryUnit.l: 1000.0,
      InventoryUnit.pcs: 1.0,
    };
    final massFrom = from == InventoryUnit.g || from == InventoryUnit.kg;
    final massTo = to == InventoryUnit.g || to == InventoryUnit.kg;
    final volFrom = from == InventoryUnit.ml || from == InventoryUnit.l;
    final volTo = to == InventoryUnit.ml || to == InventoryUnit.l;
    if (!((massFrom && massTo) || (volFrom && volTo))) return null;
    return value * toBase[from]! / toBase[to]!;
  }
}
