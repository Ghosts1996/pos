import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/reservation_model.dart';
import '../models/venue_models.dart';
import 'reservation_service.dart';

/// Лист ожидания: что делать, когда мест нет.
///
/// Гость встаёт в очередь из приложения или его записывает администратор.
/// Когда стол освобождается, первому в очереди уходит push «стол готов» —
/// вместо «перезвоните позже» заведение удерживает гостя.
class WaitlistService {
  WaitlistService._();
  static final WaitlistService instance = WaitlistService._();

  final _db = FirebaseFirestore.instance;
  final _reservations = ReservationService();

  CollectionReference<Map<String, dynamic>> get _col => _db.collection('waitlist');

  Stream<List<WaitlistEntry>> openStream() => _col
      .where('status', whereIn: ['waiting', 'invited'])
      .snapshots()
      .map((s) => s.docs.map(WaitlistEntry.fromDoc).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt)));

  Stream<List<WaitlistEntry>> clientStream(String clientUid) => _col
      .where('clientUid', isEqualTo: clientUid)
      .orderBy('createdAt', descending: true)
      .limit(10)
      .snapshots()
      .map((s) => s.docs.map(WaitlistEntry.fromDoc).toList());

  /// Встать в очередь. Возвращает позицию в очереди и обещанное время.
  Future<({String id, int position, int minutes})> join({
    required String guestName,
    required int guestsCount,
    String phone = '',
    String clientUid = '',
    String comment = '',
    String source = 'kolibri',
  }) async {
    final open = await _col.where('status', isEqualTo: 'waiting').get();
    final position = open.docs.length + 1;
    final minutes = await estimateWait(guestsCount: guestsCount, position: position);

    final ref = await _col.add(WaitlistEntry(
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

    await _db.collection('pushQueue').add({
      'topic': 'staff',
      'title': 'Новый гость в очереди',
      'body': '$guestName, $guestsCount чел · ждёт ~$minutes мин',
      'status': 'new',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });

    return (id: ref.id, position: position, minutes: minutes);
  }

  /// Оценка ожидания: сколько минут до ближайшего освобождения стола
  /// нужного размера, плюс запас на очередь впереди.
  ///
  /// Считается по таймерам открытых чеков — это честнее, чем «минут 20».
  Future<int> estimateWait({required int guestsCount, int position = 1}) async {
    final tables = await _db.collection('tables').get();
    final suitable = tables.docs
        .where((d) => ((d.data()['seats'] as num?)?.toInt() ?? 4) >= guestsCount)
        .toList();
    if (suitable.isEmpty) return 60;

    final sessions =
        await _db.collection('sessions').where('status', isEqualTo: 'active').get();
    final endByTable = <String, DateTime>{};
    for (final d in sessions.docs) {
      final data = d.data();
      final tableId = data['tableId']?.toString() ?? '';
      final ts = data['plannedEnd'];
      final end = ts is Timestamp ? ts.toDate() : DateTime.now();
      final prev = endByTable[tableId];
      if (prev == null || end.isAfter(prev)) endByTable[tableId] = end;
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
      final client = await _db.collection('clients').doc(entry.clientUid).get();
      final token = client.data()?['pushToken'] as String?;
      if (token != null && token.isNotEmpty) {
        await _db.collection('pushQueue').add({
          'token': token,
          'title': 'Стол готов',
          'body': tableName.isEmpty
              ? 'Ждём вас в ближайшие 15 минут'
              : 'Стол $tableName ваш — ждём в ближайшие 15 минут',
          'status': 'new',
          'createdAt': Timestamp.fromDate(DateTime.now()),
        });
      }
    }
  }

  Future<void> markSeated(String id) => _col.doc(id).update({'status': 'seated'});

  Future<void> markLeft(String id) => _col.doc(id).update({'status': 'left'});

  /// Превратить ожидание в бронь на конкретное время — если гость
  /// не готов ждать сейчас, но придёт позже. Стол подбирается автоматически.
  Future<void> convertToReservation(
    WaitlistEntry entry,
    DateTime startTime, {
    String employeeName = '',
  }) async {
    await _reservations.create(ReservationModel(
      id: '',
      clientUid: entry.clientUid,
      guestName: entry.guestName,
      phone: entry.phone,
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
