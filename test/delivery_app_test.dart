import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/delivery_status.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/models/session_model.dart';
import 'package:hookah_pos/utils/remote_sale.dart';

MenuItem item(String name, {bool tobacco = false, String subject = 'commodity'}) =>
    MenuItem(id: name, categoryId: 'c', name: name, price: 100, tobacco: tobacco, fiscalSubject: subject);

void main() {
  group('Навынос и доставка: что нельзя (как на сервере)', () {
    test('табак, кальяны, чаша — нельзя', () {
      expect(RemoteSale.banned(item('Классика'), categoryName: 'Кальяны'), isTrue);
      expect(RemoteSale.banned(item('Табак Darkside')), isTrue);
      expect(RemoteSale.banned(item('Чаша на грейпфруте')), isTrue);
      expect(RemoteSale.banned(item('Микс', tobacco: true)), isTrue);
    });

    test('алкоголь по названию и подакцизное — нельзя; безалкогольное и блюда с вином — можно', () {
      expect(RemoteSale.banned(item('Пиво светлое')), isTrue);
      expect(RemoteSale.banned(item('Вино красное, бокал')), isTrue);
      expect(RemoteSale.banned(item('Коктейль дня', subject: 'excise')), isTrue);
      expect(RemoteSale.banned(item('Пиво безалкогольное')), isFalse);
      expect(RemoteSale.banned(item('Говядина с вином')), isFalse);
      expect(RemoteSale.banned(item('Винегрет')), isFalse);
      expect(RemoteSale.banned(item('Ромашковый чай')), isFalse);
      expect(RemoteSale.banned(item('Том ям'), categoryName: 'Горячее'), isFalse);
    });
  });

  group('Статусы: отмена', () {
    test('отменить можно до выдачи, после — нет; дальше отмены шагов нет', () {
      expect(DeliveryFlow.canCancel('delivery', 'new'), isTrue);
      expect(DeliveryFlow.canCancel('delivery', 'courier'), isTrue);
      expect(DeliveryFlow.canCancel('delivery', 'done'), isFalse);
      expect(DeliveryFlow.canCancel('takeaway', 'cancelled'), isFalse);
      expect(DeliveryFlow.next('delivery', 'cancelled'), isNull);
      expect(DeliveryFlow.label('takeaway', 'cancelled'), 'Отменён');
      expect(DeliveryFlow.isFinal('delivery', 'cancelled'), isTrue);
    });
  });

  group('Заказ в работе (deliveryOpen)', () {
    SessionModel order(String status) => SessionModel(
          id: 's1',
          tableId: 'takeaway',
          tableName: 'Доставка',
          employeeName: '',
          startTime: DateTime(2026, 10, 9, 15),
          plannedEnd: DateTime(2026, 10, 9, 18),
          orderType: 'delivery',
          deliveryStatus: status,
          customerName: 'Аня',
        );

    test('новый заказ кассы — в работе до выдачи', () {
      expect(order('new').toMap()['deliveryOpen'], isTrue);
      expect(order('done').toMap()['deliveryOpen'], isFalse);
      expect(order('new').toMap()['customerName'], 'Аня');
    });

    test('чек за столом не трогает поля доставки', () {
      final table = SessionModel(
        id: 's2',
        tableId: 't1',
        tableName: 'Стол 1',
        employeeName: '',
        startTime: DateTime(2026),
        plannedEnd: DateTime(2026),
      );
      expect(table.toMap().containsKey('deliveryOpen'), isFalse);
      expect(table.fromApp, isFalse);
    });
  });
}
