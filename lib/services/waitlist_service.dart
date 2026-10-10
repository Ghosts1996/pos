import 'package:cloud_firestore/cloud_firestore.dart';
import 'app_scope.dart';
import '../models/table_model.dart';
import '../models/reservation_model.dart';
import '../models/venue_models.dart';
import 'reservation_service.dart';
import 'push_service.dart';
import '../utils/table_label.dart';
import 'pii_gateway_service.dart';
import '../utils/shared_stream.dart';
import 'people_directory.dart';

/// Лист ожидания: что делать, когда мест нет.
///
/// Гость встаёт в очередь из приложения или его записывает администратор.
/// Когда стол освобождается, первому в очереди уходит push «стол готов» —
/// вместо «перезвоните позже» заведение удерживает гостя.
class WaitlistService {
  WaitlistService._();
  static final WaitlistService instance = WaitlistService._();

  final _reservations = ReservationService();

  CollectionReference<Map<String, dynamic>> get _col => AppScope.col('waitlist');

  Stream<List<WaitlistEntry>> openStream() => _col
      .where('status', whereIn: ['waiting', 'invited'])
      .snapshots()
      .map((s) => s.docs.map(WaitlistEntry.fromDoc).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt)));

  static final _clientS = SharedStreams<List<WaitlistEntry>>();

  Stream<List<WaitlistEntry>> clientStream(String clientUid) => _clientS.get(
      '${AppScope.tenantId ?? '-'}|$clientUid',
      () => _col
          .where('clientUid', isEqualTo: clientUid)
          .orderBy('createdAt', descending: true)
          .limit(10)
          .snapshots()
          .map((s) => s.docs.map(WaitlistEntry.fromDoc).toList()));

  /// Встать в очередь. Возвращает обещанное время и позицию в очереди —
  /// 0, если посчитать её не удалось (см. ниже).
  Future<({String id, int position, int minutes})> join({
    required String guestName,
    required int guestsCount,
    String phone = '',
    String clientUid = '',
    String comment = '',
    String source = 'kolibri',
  }) async {
    // Сколько человек уже ждёт. Гостю видны только свои записи, так что
    // позицию считаем только на кассе. Ноль — «позиция неизвестна»: гостю
    // показываем одно время ожидания, не обещая «вы первый».
    var position = 0;
    try {
      final open = await _col.where('status', isEqualTo: 'waiting').get();
      position = open.docs.length + 1;
    } catch (_) {
      // Прав на чтение чужих записей нет — это гость.
    }
    final minutes = await estimateWait(
        guestsCount: guestsCount, position: position == 0 ? 1 : position);

    final ref = _col.doc();
    // Имя и телефон — сначала в базу в РФ, затем в Firestore (152-ФЗ).
    await PiiGatewayService().recordContact(
        kind: 'waitlist', id: ref.id, name: guestName, phone: phone);
    // Записанное на сервере — сразу и в копию на устройстве.
    People.instance.remember('waitlist', ref.id, name: guestName, phone: phone);
    await ref.set(WaitlistEntry(
      id: '',
      guestName: guestName.isEmpty ? 'Гость' : guestName,
      phone: phone,
      clientUid: clientUid,
      guestsCount: guestsCount,
      comment: comment,
      promisedMinutes: minutes,
      source: source,
      createdAt: DateTime.now(),
    ).toMap());

    await PushService.instance.enqueue(
      topic: 'staff',
      title: 'Новый гость в очереди',
      body: '$guestName, $guestsCount чел · ждёт ~$minutes мин',
    );

    return (id: ref.id, position: position, minutes: minutes);
  }

  /// Оценка ожидания: сколько минут до ближайшего освобождения стола
  /// нужного размера, плюс запас на очередь впереди.
  ///
  /// Считается по таймерам открытых чеков — это честнее, чем «минут 20».
  Future<int> estimateWait({required int guestsCount, int position = 1}) async {
    final tables = await AppScope.col('tables').get();
    final suitable = tables.docs
        .where((d) => d.id != TableModel.takeawayId && ((d.data()['seats'] as num?)?.toInt() ?? 4) >= guestsCount)
        .toList();
    if (suitable.isEmpty) return 60;

    // Занятость — из tables.busyUntil: чужие чеки приложению гостя читать
    // нельзя.
    final endByTable = <String, DateTime>{};
    for (final d in tables.docs) {
      final ts = d.data()['busyUntil'];
      if (ts is Timestamp) endByTable[d.id] = ts.toDate();
    }

    final waits = <int>[];
    for (final t in suitable) {
      final end = endByTable[t.id];
      // Свободный стол — гость сядет сразу, но обычно его уже придержали,
      // поэтому 5 минут на уборку всё равно закладываем.
      waits.add(end == null ? 5 : end.difference(DateTime.now()).inMinutes.clamp(5, 240));
    }
    waits.sort();

    // Каждый впереди стоящий занимает один из ближайших освобождающихся столов.
    final index = (position - 1).clamp(0, waits.length - 1);
    return waits[index] + 10; // запас на уборку и посадку
  }

  /// Пригласить гостя: уходит push «стол готов», статус — invited.
  Future<void> invite(WaitlistEntry entry, {String tableName = ''}) async {
    await _col.doc(entry.id).update({
      'status': 'invited',
      'invitedAt': Timestamp.fromDate(DateTime.now()),
    });

    if (entry.clientUid.isNotEmpty) {
      final client = await AppScope.loyaltyCol('clients').doc(entry.clientUid).get();
      final token = client.data()?['pushToken'] as String?;
      if (token != null && token.isNotEmpty) {
        await PushService.instance.enqueue(
          token: token,
          clientUid: entry.clientUid,
          title: 'Стол готов',
          body: tableName.isEmpty
              ? 'Ждём вас в ближайшие 15 минут'
              : '${tableLabel(tableName)} ваш — ждём в ближайшие 15 минут',
        );
      }
    }
  }

  Future<void> markSeated(String id) => _col.doc(id).update({'status': 'seated'});

  Future<void> markLeft(String id) => _col.doc(id).update({'status': 'left'});

  /// Превратить ожидание в бронь на конкретное время — если гость
  /// не готов ждать сейчас, но придёт позже. Стол подбирается автоматически.
  ///
  /// [phone] — номер, если в очереди гость стоял без него: бронь без
  /// номера не создаётся.
  Future<void> convertToReservation(
    WaitlistEntry entry,
    DateTime startTime, {
    String employeeName = '',
    String? phone,
  }) async {
    await _reservations.create(ReservationModel(
      id: '',
      clientUid: entry.clientUid,
      guestName: entry.guestName,
      phone: phone ?? entry.phone,
      guestsCount: entry.guestsCount,
      startTime: startTime,
      comment: entry.comment,
      status: ReservationStatus.confirmed,
      source: 'pos',
      handledBy: employeeName,
      createdAt: DateTime.now(),
    ));
    await _col.doc(entry.id).update({'status': 'left', 'comment': 'Переведён в бронь'});
  }
}
