import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'ai_agents.dart';
import 'ai_settings.dart';

/// Фоновые задания ИИ на POS-планшете.
///
/// Работает на «дежурном» устройстве: то, которое первым захватило замок
/// в meta/aiSchedulerLock. Так три планшета в зале не сделают одну и ту же
/// работу трижды и не потратят токены втрое.
///
/// Задания:
///  • утренний разбор броней → staffNotes;
///  • вечерние итоги смены → shiftSummaries;
///  • проверка склада и рисков стоп-листа раз в 3 часа;
///  • разбор новых отзывов раз в сутки.
class AiScheduler {
  AiScheduler._();
  static final AiScheduler instance = AiScheduler._();

  final _db = FirebaseFirestore.instance;
  Timer? _timer;
  String _deviceId = '';
  bool _running = false;

  /// Запускается на POS после входа сотрудника.
  void start({required String deviceId}) {
    _deviceId = deviceId;
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(minutes: 15), (_) => _tick());
    unawaited(_tick());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _tick() async {
    if (_running) return;
    if (!AiSettingsStore.instance.current.isReady) return;
    _running = true;
    try {
      if (!await _acquireLock()) return;
      final now = DateTime.now();

      await _runIfDue('hostess_briefing', const Duration(hours: 12), () async {
        if (now.hour < 12 || now.hour > 20) return null;
        return AiService.instance.hostessBriefing();
      });

      await _runIfDue('stock_watch', const Duration(hours: 3), () async {
        return AiService.instance.restockPlan(days: 7);
      });

      await _runIfDue('review_digest', const Duration(hours: 24), () async {
        final fresh = await _db
            .collection('reviews')
            .where('createdAt',
                isGreaterThan: Timestamp.fromDate(now.subtract(const Duration(hours: 24))))
            .limit(1)
            .get();
        if (fresh.docs.isEmpty) return null; // новых отзывов нет — не тратим токены
        return AiService.instance.reviewDigest();
      });

      await _runIfDue('shift_summary', const Duration(hours: 20), () async {
        if (now.hour < 2 || now.hour > 6) return null; // под закрытие заведения
        return AiService.instance.shiftSummary();
      });
    } catch (_) {
      // Фоновые задания не должны ломать работу кассы.
    } finally {
      _running = false;
    }
  }

  /// Мягкий замок: держится 20 минут, продлевается «дежурным» устройством.
  Future<bool> _acquireLock() async {
    final ref = _db.doc('meta/aiSchedulerLock');
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
  /// Результат кладётся в staffNotes — лента подсказок на POS.
  Future<void> _runIfDue(
    String jobId,
    Duration interval,
    Future<String?> Function() job,
  ) async {
    final ref = _db.collection('aiJobs').doc(jobId);
    final snap = await ref.get();
    final ts = snap.data()?['lastRunAt'];
    final last = ts is Timestamp ? ts.toDate() : DateTime(2000);
    if (DateTime.now().difference(last) < interval) return;

    // Отметку ставим до запуска — если модель ответит с ошибкой, задание
    // не будет биться в неё каждые 15 минут.
    await ref.set({'lastRunAt': Timestamp.fromDate(DateTime.now())}, SetOptions(merge: true));

    final text = await job();
    if (text == null || text.trim().isEmpty) return;

    await _db.collection('staffNotes').add({
      'text': text,
      'title': _titles[jobId] ?? 'ИИ-сводка',
      'priority': jobId == 'stock_watch' ? 'warning' : 'info',
      'source': 'ai:$jobId',
      'createdAt': Timestamp.fromDate(DateTime.now()),
      'read': false,
    });
  }

  static const _titles = {
    'hostess_briefing': 'Брони на смену',
    'stock_watch': 'Склад и закупки',
    'review_digest': 'Отзывы за сутки',
    'shift_summary': 'Итоги смены',
  };

  /// Лента ИИ-сводок и уведомлений для экранов POS.
  Stream<QuerySnapshot<Map<String, dynamic>>> notesStream({int limit = 30}) => _db
      .collection('staffNotes')
      .orderBy('createdAt', descending: true)
      .limit(limit)
      .snapshots();

  Future<void> markNoteRead(String id) =>
      _db.collection('staffNotes').doc(id).update({'read': true});
}
