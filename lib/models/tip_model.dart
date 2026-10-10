import 'package:cloud_firestore/cloud_firestore.dart';
import '../services/people_directory.dart';

/// Сотрудник, который сейчас на смене, — как его видит гость в выборе,
/// кому оставить чаевые. Лежит в meta/tipsTeam (см. TipsService): гостю
/// нельзя читать ни сотрудников, ни их смены целиком — там PIN и ставки.
class TipTeamMember {
  final String id;
  final String _name;
  String get name => Pd.staffName(id, _name);
  final String position;

  /// Личная ссылка для чаевых (Employee.tipsLink), может быть пустой.
  final String tipsLink;
  final DateTime? since;

  const TipTeamMember({
    required this.id,
    required String name,
    this.position = '',
    this.tipsLink = '',
    this.since,
  }) : _name = name;

  factory TipTeamMember.fromMap(String id, Map<String, dynamic> m) => TipTeamMember(
        id: id,
        name: (m['name'] ?? '').toString(),
        position: (m['position'] ?? '').toString(),
        tipsLink: (m['tipsLink'] ?? '').toString(),
        since: (m['since'] as Timestamp?)?.toDate(),
      );

  Map<String, dynamic> toMap() => {
        if (Pd.mirror) 'name': name,
        'position': position,
        'tipsLink': tipsLink,
        if (since != null) 'since': Timestamp.fromDate(since!),
      };

  /// Снимок для записи чаевых «всей смене» — только то, что нужно для
  /// дележа в зарплате.
  Map<String, dynamic> toShareMap() => {'id': id, if (Pd.mirror) 'name': name};
}

/// Чаевые — документ tips/{id}.
///
/// Два способа, как деньги доходят до сотрудника:
///  • method 'bill' — гость просит добавить чаевые к счёту, касса берёт их
///    вместе с оплатой (status: pending → paid) и они попадают в зарплату;
///  • method 'link' — гость переводит сам по личной ссылке сотрудника.
///    Касса этих денег не видит, запись нужна, чтобы сотрудник знал, от
///    какого стола пришло «спасибо». В зарплату не входит.
/// Старые записи с method 'app' — это тот же 'bill'.
class TipModel {
  final String id;
  final double amount;

  /// 'employee' — конкретному сотруднику; 'team' — всей смене поровну.
  final String target;
  final String employeeId;
  final String _employeeName;
  String get employeeName => employeeId.isEmpty && target == 'team'
      ? (_employeeName.isEmpty ? 'Всей смене' : _employeeName)
      : Pd.staffName(employeeId, _employeeName);
  final String position;

  /// Кто был на смене, когда оставили чаевые «всей смене»: [{id, name}].
  final List<TipTeamMember> teamMembers;

  final String sessionId;
  final String tableName;
  final String clientUid;
  final String comment;
  final String method;

  /// 'pending' | 'paid' | 'cancelled'
  final String status;

  /// Как чаевые приняты кассой: 'cash' | 'card' | 'mixed'.
  final String paidVia;

  /// 'guest' — из приложения гостя, 'pos' — кассир добавил на оплате.
  final String source;
  final DateTime createdAt;
  final DateTime? paidAt;

  const TipModel({
    required this.id,
    required this.amount,
    this.target = 'employee',
    this.employeeId = '',
    String employeeName = '',
    this.position = '',
    this.teamMembers = const [],
    this.sessionId = '',
    this.tableName = '',
    this.clientUid = '',
    this.comment = '',
    this.method = 'bill',
    this.status = 'pending',
    this.paidVia = '',
    this.source = 'guest',
    required this.createdAt,
    this.paidAt,
  }) : _employeeName = employeeName;

  bool get isTeam => target == 'team';
  bool get isLink => method == 'link';

  /// Чаевые, которые касса должна взять вместе со счётом.
  bool get onBill => !isLink && status == 'pending';

  String get recipientLabel => isTeam ? 'Всей смене' : (employeeName.isEmpty ? 'Смене' : employeeName);

  factory TipModel.fromDoc(DocumentSnapshot doc) {
    final m = doc.data() as Map<String, dynamic>? ?? {};
    final rawTeam = m['teamMembers'] is List ? m['teamMembers'] as List : const [];
    return TipModel(
      id: doc.id,
      amount: (m['amount'] ?? 0).toDouble(),
      target: m['target'] == 'team' ? 'team' : 'employee',
      employeeId: (m['employeeId'] ?? '').toString(),
      employeeName: (m['employeeName'] ?? '').toString(),
      position: (m['position'] ?? '').toString(),
      teamMembers: [
        for (final e in rawTeam)
          if (e is Map) TipTeamMember(id: (e['id'] ?? '').toString(), name: (e['name'] ?? '').toString()),
      ],
      sessionId: (m['sessionId'] ?? '').toString(),
      tableName: (m['tableName'] ?? '').toString(),
      clientUid: (m['clientUid'] ?? '').toString(),
      comment: (m['comment'] ?? '').toString(),
      method: m['method'] == 'link' ? 'link' : 'bill',
      status: (m['status'] ?? 'pending').toString(),
      paidVia: (m['paidVia'] ?? '').toString(),
      source: (m['source'] ?? 'guest').toString(),
      createdAt: (m['createdAt'] as Timestamp?)?.toDate() ?? DateTime.now(),
      paidAt: (m['paidAt'] as Timestamp?)?.toDate(),
    );
  }

  /// Кому сколько причитается из этих чаевых: ключ — id сотрудника.
  /// «Всей смене» делится поровну; если состав смены не известен (никто не
  /// отмечал начало смены), сумма остаётся без получателя — ключ ''.
  /// У старых записей id нет, только имя — для них ключ 'name:<имя>'.
  Map<String, double> shares() {
    if (!isTeam) {
      if (employeeId.isNotEmpty) return {employeeId: amount};
      return {employeeName.isEmpty ? '' : 'name:$employeeName': amount};
    }
    final ids = teamMembers.map((e) => e.id).where((id) => id.isNotEmpty).toSet().toList();
    if (ids.isEmpty) return {'': amount};
    final part = amount / ids.length;
    return {for (final id in ids) id: part};
  }
}

/// Сколько чаевых добавить к счёту: процент от суммы, округлённый до 10 ₽
/// (никто не оставляет 347 ₽), но не меньше 10 ₽.
double tipFromPercent(double bill, int percent) {
  if (bill <= 0 || percent <= 0) return 0;
  final raw = bill * percent / 100;
  final rounded = (raw / 10).round() * 10.0;
  return rounded < 10 ? 10 : rounded;
}

/// Из каких денег взяты чаевые, когда гость платит счёт вместе с ними:
/// сначала наличные (их обычно и отдают сотруднику из кассы), потом карта,
/// потом терминал. «За счёт заведения» чаевые не оплачивает — это не
/// деньги гостя; не хватило живых денег — остаток в [uncovered].
({double cash, double card, double terminal, double uncovered}) splitTips({
  required double tips,
  required double cash,
  required double card,
  required double terminal,
}) {
  double take(double rest, double from) => rest < from ? rest : (from < 0 ? 0 : from);
  var rest = tips < 0 ? 0.0 : tips;
  final fromCash = take(rest, cash);
  rest -= fromCash;
  final fromCard = take(rest, card);
  rest -= fromCard;
  final fromTerminal = take(rest, terminal);
  rest -= fromTerminal;
  return (cash: fromCash, card: fromCard, terminal: fromTerminal, uncovered: rest);
}
