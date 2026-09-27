import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/employee.dart';
import '../models/tip_model.dart';
import 'app_scope.dart';
import 'push_service.dart';
import '../utils/money.dart';

export '../models/tip_model.dart';

/// Чаевые: кому из смены, сколько и как они дошли до сотрудника.
///
/// Гость выбирает получателя из тех, кто сейчас на смене (meta/tipsTeam),
/// или оставляет «всей смене». Касса берёт чаевые вместе со счётом и
/// отмечает их оплаченными; в выручку и фискальный чек они не входят, а в
/// «Зарплате» попадают тому, кому их оставили.
class TipsService {
  TipsService._();
  static final TipsService instance = TipsService._();

  /// Кто сейчас на смене — единственный документ, который гостю можно
  /// читать про персонал: имена, должности и ссылки для чаевых. Его ведёт
  /// касса в тех же транзакциях, что открывают и закрывают личную смену.
  static DocumentReference<Map<String, dynamic>> get teamRef =>
      AppScope.col('meta').doc('tipsTeam');

  /// Смена, которую отметили больше 18 часов назад и не закрыли, скорее
  /// всего забыта: вчерашний кальянщик не должен висеть в списке у гостя.
  static const staleAfter = Duration(hours: 18);

  static List<TipTeamMember> parseTeam(Map<String, dynamic>? data, {DateTime? now}) {
    final members = (data?['members'] as Map?) ?? const {};
    final cutoff = (now ?? DateTime.now()).subtract(staleAfter);
    final list = <TipTeamMember>[];
    members.forEach((k, v) {
      if (v is! Map) return;
      final m = TipTeamMember.fromMap(k.toString(), Map<String, dynamic>.from(v));
      if (m.name.trim().isEmpty) return;
      if (m.since != null && m.since!.isBefore(cutoff)) return;
      list.add(m);
    });
    list.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return list;
  }

  static TipTeamMember memberOf(Employee e, DateTime since) => TipTeamMember(
        id: e.id,
        name: e.name,
        position: e.position,
        tipsLink: e.tipsLink,
        since: since,
      );

  Stream<List<TipTeamMember>> teamStream() =>
      teamRef.snapshots().map((d) => parseTeam(d.data()));

  Future<List<TipTeamMember>> team() async => parseTeam((await teamRef.get()).data());

  /// Карточку сотрудника поменяли (имя, должность, ссылка) — если он сейчас
  /// на смене, гость должен увидеть новое сразу, а не со следующей смены.
  Future<void> refreshMember(Employee e) async {
    final snap = await teamRef.get();
    final members = (snap.data()?['members'] as Map?) ?? const {};
    final current = members[e.id];
    if (current is! Map) return;
    await teamRef.update({
      'members.${e.id}.name': e.name,
      'members.${e.id}.position': e.position,
      'members.${e.id}.tipsLink': e.tipsLink,
    });
  }

  /// Оставить чаевые. [to] — конкретный сотрудник; null — всей смене
  /// ([team] — кто на смене сейчас, между ними сумма и поделится).
  Future<String> leaveTip({
    required double amount,
    TipTeamMember? to,
    List<TipTeamMember> team = const [],
    required String sessionId,
    String tableName = '',
    String clientUid = '',
    String method = 'bill',
    String source = 'guest',
    String comment = '',
  }) async {
    final ref = await AppScope.col('tips').add({
      'amount': amount,
      'target': to == null ? 'team' : 'employee',
      'employeeId': to?.id ?? '',
      'employeeName': to?.name ?? 'Всей смене',
      'position': to?.position ?? '',
      'teamMembers': to == null ? team.map((m) => m.toShareMap()).toList() : const [],
      'sessionId': sessionId,
      'tableName': tableName,
      'clientUid': clientUid,
      'comment': comment,
      'method': method,
      'source': source,
      // Правила базы разрешают гостю создавать чаевые только в этом
      // статусе: оплаченными их отмечает касса.
      'status': 'pending',
      'createdAt': Timestamp.fromDate(DateTime.now()),
    });

    if (source == 'guest') {
      try {
        await PushService.instance.enqueue(
          topic: 'staff',
          title: 'Чаевые',
          body: '${to?.name ?? 'Всей смене'} — ${rub(amount)}'
              '${method == 'link' ? ' (перевод по ссылке)' : ' — добавить к счёту'}',
        );
      } catch (_) {
        // Уведомление — приятное дополнение: чаевые всё равно видны кассе.
      }
    }
    return ref.id;
  }

  /// Чаевые к одному чеку. Гостю правила разрешают читать только свои
  /// записи, поэтому для него запрос обязан содержать [clientUid].
  Stream<List<TipModel>> sessionTipsStream(String sessionId, {String? clientUid}) {
    Query<Map<String, dynamic>> q = AppScope.col('tips').where('sessionId', isEqualTo: sessionId);
    if (clientUid != null) q = q.where('clientUid', isEqualTo: clientUid);
    return q.snapshots().map((s) {
      final list = s.docs.map(TipModel.fromDoc).toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      return list;
    });
  }

  /// Отменить ещё не оплаченные чаевые (гость передумал или кассир убрал
  /// их со счёта по просьбе гостя).
  Future<void> cancel(String tipId) => AppScope.col('tips').doc(tipId).update({
        'status': 'cancelled',
        'cancelledAt': Timestamp.fromDate(DateTime.now()),
      });

  /// Оплаченные чаевые за период — по времени оплаты (одиночный диапазон
  /// по одному полю, составной индекс не нужен).
  Future<List<TipModel>> paidInRange(DateTime from, DateTime to) async {
    final snap = await AppScope.col('tips')
        .where('paidAt', isGreaterThanOrEqualTo: Timestamp.fromDate(from))
        .where('paidAt', isLessThan: Timestamp.fromDate(to))
        .get();
    return snap.docs.map(TipModel.fromDoc).where((t) => t.status == 'paid').toList();
  }

  /// Итог по сотрудникам: id → сумма. Ключ '' — чаевые «всей смене», когда
  /// никто не отмечал начало смены и делить было не на кого.
  static Map<String, double> sharesByEmployee(Iterable<TipModel> tips) {
    final out = <String, double>{};
    for (final t in tips) {
      t.shares().forEach((id, v) => out[id] = (out[id] ?? 0) + v);
    }
    return out;
  }
}
