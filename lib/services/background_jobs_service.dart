import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/reservation_model.dart';
import 'birthday_service.dart';
import 'venue_service.dart';

/// Фоновые задания заведения, которые раньше жили в Cloud Functions.
///
/// Зачем это здесь. Cloud Functions разворачиваются только на платном
/// тарифе Firebase (Blaze) — на бесплатном Spark их нет вообще. Без них
/// переставали работать две вещи, важные каждый день:
///
///  • авто-неявка: бронь, к которой гость не пришёл, навсегда оставалась
///    в статусе «новая»/«подтверждена» и продолжала держать стол занятым
///    в сетке доступности — зал терял столы на пустом месте;
///  • поздравления с днём рождения: код начисления подарка в
///    [BirthdayService] был написан, но его никто не вызывал.
///
/// Теперь то же самое делает POS-планшет — он и так включён всю смену.
/// Чтобы три планшета в зале не выполнили работу трижды (и не начислили
/// тройной подарок), «дежурное» устройство выбирается мягким замком в
/// meta/jobsLock — тот же приём, что у планировщика ИИ.
///
/// Если заведение всё-таки перешло на Blaze и развернуло функции, в
/// профиле заведения включается флаг `cloudFunctionsEnabled`, и планировщик
/// сам замолкает, чтобы не дублировать серверную работу.
class BackgroundJobsService {
  BackgroundJobsService._();
  static final BackgroundJobsService instance = BackgroundJobsService._();

  final _db = FirebaseFirestore.instance;

  /// Как часто просыпаться. Десять минут — как у серверного сторожа броней:
  /// чаще незачем, реже — неявка висит слишком долго.
  static const _tick = Duration(minutes: 10);

  /// Сколько держать бронь после начала, прежде чем считать неявкой.
  static const _noShowAfter = Duration(minutes: 25);

  /// Насколько глубоко в прошлое разбирать просроченные брони: за сутки
  /// неявка либо уже проставлена, либо бронь не имеет смысла.
  static const _lookBack = Duration(hours: 6);

  Timer? _timer;
  String _deviceId = '';
  bool _running = false;

  /// Запускается на POS после входа сотрудника.
  void start({required String deviceId}) {
    _deviceId = deviceId;
    _timer?.cancel();
    _timer = Timer.periodic(_tick, (_) => unawaited(_run()));
    unawaited(_run());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _run() async {
    if (_running) return;
    _running = true;
    try {
      // Функции развёрнуты — вся эта работа делается на сервере.
      if (VenueService.instance.cached.cloudFunctionsEnabled) return;
      if (!await _acquireLock()) return;

      await _markNoShows();
      await _runIfDue('birthday_greetings', const Duration(hours: 20), () async {
        // Поздравляем днём, а не в четыре утра под закрытие.
        final hour = DateTime.now().hour;
        if (hour < 11 || hour > 21) return false;
        await BirthdayService.instance.runDailyGreetings();
        return true;
      });
    } catch (_) {
      // Фоновые задания не должны ломать работу кассы.
    } finally {
      _running = false;
    }
  }

  // ---------- АВТО-НЕЯВКА ----------

  /// Брони, у которых время начала прошло больше [_noShowAfter] назад, а
  /// гостя так и не посадили, переводятся в «не пришёл» и освобождают стол.
  Future<void> _markNoShows() async {
    final now = DateTime.now();
    final from = now.subtract(_lookBack);
    final to = now.subtract(_noShowAfter);

    final snap = await _db
        .collection('reservations')
        .where('startTime', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('startTime', isLessThan: Timestamp.fromDate(to))
        .get();

    final names = <String>[];
    for (final doc in snap.docs) {
      final r = ReservationModel.fromDoc(doc);
      // Отменённые, уже помеченные и те, за кем пришли, не трогаем.
      if (!r.status.blocksTable) continue;

      await doc.reference.update({
        'status': ReservationStatus.noShow.code,
        'handledBy': 'auto',
      });
      // Освобождаем стол и в обезличенном зеркале занятости — иначе бронь
      // продолжит держать слот в гостевом приложении до конца интервала.
      await _db
          .collection('reservationSlots')
          .doc(doc.id)
          .set({'active': false}, SetOptions(merge: true));

      names.add('${r.guestName.isEmpty ? 'Гость' : r.guestName} '
          '(${r.guestsCount} чел, стол ${r.tableName.isEmpty ? '—' : r.tableName})');
    }

    if (names.isEmpty) return;
    await _db.collection('staffNotes').add({
      'title': 'Брони без гостя',
      'text': 'Столы освобождены автоматически: ${names.join('; ')}.',
      'priority': 'warning',
      'source': 'watchdog',
      'read': false,
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });
  }

  // ---------- ЗАМОК ДЕЖУРНОГО УСТРОЙСТВА ----------

  /// Мягкий замок: держится 20 минут, продлевается тем же устройством.
  /// Если «дежурный» планшет выключили, через 20 минут работу подхватит
  /// любой другой.
  Future<bool> _acquireLock() async {
    final ref = _db.doc('meta/jobsLock');
    try {
      return await _db.runTransaction<bool>((tx) async {
        final snap = await tx.get(ref);
        final data = snap.data();
        final owner = data?['deviceId'] as String?;
        final ts = data?['until'];
        final until = ts is Timestamp ? ts.toDate() : DateTime(2000);

        if (owner != null && owner != _deviceId && until.isAfter(DateTime.now())) {
          return false;
        }
        tx.set(ref, {
          'deviceId': _deviceId,
          'until': Timestamp.fromDate(DateTime.now().add(const Duration(minutes: 20))),
        });
        return true;
      });
    } catch (_) {
      return false;
    }
  }

  /// Выполнить задание, если с прошлого раза прошло достаточно времени.
  /// Отметку ставим ТОЛЬКО когда задание реально отработало, иначе
  /// «поздравления в 11 утра» отметились бы в 4 ночи и пропустили день.
  Future<void> _runIfDue(
    String jobId,
    Duration interval,
    Future<bool> Function() job,
  ) async {
    final ref = _db.collection('jobRuns').doc(jobId);
    final snap = await ref.get();
    final ts = snap.data()?['lastRunAt'];
    final last = ts is Timestamp ? ts.toDate() : DateTime(2000);
    if (DateTime.now().difference(last) < interval) return;

    final done = await job();
    if (!done) return;
    await ref.set(
      {'lastRunAt': Timestamp.fromDate(DateTime.now())},
      SetOptions(merge: true),
    );
  }
}
