import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/venue_models.dart';
import 'package:hookah_pos/services/tips_service.dart';

TipModel _tip({
  double amount = 300,
  String target = 'employee',
  String employeeId = 'e1',
  String employeeName = 'Анна',
  List<TipTeamMember> team = const [],
}) =>
    TipModel(
      id: 't',
      amount: amount,
      target: target,
      employeeId: employeeId,
      employeeName: employeeName,
      teamMembers: team,
      createdAt: DateTime(2026, 9, 1),
      status: 'paid',
    );

void main() {
  group('Сумма чаевых от процента', () {
    test('округляется до 10 ₽', () {
      expect(tipFromPercent(3470, 10), 350);
      expect(tipFromPercent(3440, 10), 340);
      expect(tipFromPercent(1999, 15), 300);
    });
    test('не меньше 10 ₽ и ноль для пустого счёта', () {
      expect(tipFromPercent(50, 5), 10);
      expect(tipFromPercent(0, 10), 0);
    });
  });

  group('Кому сколько', () {
    test('конкретному сотруднику — вся сумма ему', () {
      expect(_tip().shares(), {'e1': 300});
    });
    test('всей смене — поровну между теми, кто был на смене', () {
      final t = _tip(target: 'team', amount: 900, team: const [
        TipTeamMember(id: 'a', name: 'А'),
        TipTeamMember(id: 'b', name: 'Б'),
        TipTeamMember(id: 'c', name: 'В'),
      ]);
      expect(t.shares(), {'a': 300, 'b': 300, 'c': 300});
    });
    test('всей смене без состава — без получателя', () {
      expect(_tip(target: 'team', team: const []).shares(), {'': 300});
    });
    test('старая запись без id — по имени', () {
      expect(_tip(employeeId: '', employeeName: 'Игорь').shares(), {'name:Игорь': 300});
    });
    test('итог по сотрудникам складывает личные и общие', () {
      final totals = TipsService.sharesByEmployee([
        _tip(employeeId: 'a', amount: 200),
        _tip(target: 'team', amount: 400, team: const [
          TipTeamMember(id: 'a', name: 'А'),
          TipTeamMember(id: 'b', name: 'Б'),
        ]),
      ]);
      expect(totals, {'a': 400, 'b': 200});
    });
  });

  group('Кто на смене (meta/tipsTeam)', () {
    final now = DateTime(2026, 9, 27, 20);
    test('забытые смены старше 18 часов гостю не показываются', () {
      final team = TipsService.parseTeam({
        'members': {
          'fresh': {'name': 'Анна', 'position': 'waiter', 'since': Timestamp.fromDate(now.subtract(const Duration(hours: 3)))},
          'old': {'name': 'Вчерашний', 'since': Timestamp.fromDate(now.subtract(const Duration(hours: 30)))},
          'noname': {'name': '  '},
        },
      }, now: now);
      expect(team.map((m) => m.id), ['fresh']);
      expect(team.single.position, 'waiter');
    });
    test('пустой документ — пустой список', () {
      expect(TipsService.parseTeam(null), isEmpty);
    });
  });

  group('Тип заведения', () {
    test('неизвестный или пустой — кальянная (как было раньше)', () {
      expect(VenueTerms.normalize(null), VenueTerms.hookah);
      expect(VenueTerms.normalize('pizzeria'), VenueTerms.hookah);
      expect(VenueProfile.fromMap(const {}).venueType, VenueTerms.hookah);
    });
    test('слова про персонал', () {
      expect(const VenueTerms(VenueTerms.hookah).staffAcc, 'кальянщика');
      expect(const VenueTerms(VenueTerms.restaurant).staffAcc, 'официанта');
      expect(const VenueTerms(VenueTerms.cafe).staffDat, 'официанту');
      expect(const VenueTerms(VenueTerms.bar).staff, 'бармен');
    });
    test('настройки чаевых по умолчанию включены и сохраняются', () {
      final p = VenueProfile.fromMap(const {'venueType': 'restaurant', 'tipsTeamEnabled': false});
      expect(p.tipsEnabled, isTrue);
      expect(p.tipsTeamEnabled, isFalse);
      expect(p.toMap()['venueType'], 'restaurant');
      expect(p.terms.isHookah, isFalse);
    });
  });

  group('Чаевые при оплате: из каких денег', () {
    test('всё наличными — чаевые из наличных', () {
      final r = splitTips(tips: 350, cash: 2650, card: 0, terminal: 0);
      expect([r.cash, r.card, r.terminal, r.uncovered], [350, 0, 0, 0]);
    });
    test('всё картой — чаевые картой', () {
      final r = splitTips(tips: 360, cash: 0, card: 3910, terminal: 0);
      expect([r.cash, r.card, r.terminal, r.uncovered], [0, 360, 0, 0]);
    });
    test('счёт картой, чаевые наличными', () {
      final r = splitTips(tips: 300, cash: 300, card: 2300, terminal: 0);
      expect([r.cash, r.card], [300, 0]);
    });
    test('наличных не хватает — остаток с карты, потом с терминала', () {
      final r = splitTips(tips: 500, cash: 100, card: 250, terminal: 1000);
      expect([r.cash, r.card, r.terminal, r.uncovered], [100, 250, 150, 0]);
    });
    test('«за счёт заведения» чаевые не покрывает', () {
      final r = splitTips(tips: 200, cash: 50, card: 0, terminal: 0);
      expect(r.uncovered, 150);
    });
  });
}
