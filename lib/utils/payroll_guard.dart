import '../models/employee.dart';
import 'constants.dart';

/// Защита зарплаты от правок «самому себе». Свои смены и свою оплату
/// администратор не меняет, если в заведении есть другой администратор:
/// пусть это сделает он — или владелец. Единственный администратор (как
/// правило, сам владелец) может, но каждая правка подписана и видна в
/// расчёте зарплаты.
class PayrollGuard {
  PayrollGuard._();

  /// Текст запрета или null, если можно. [what] — «свои смены», «свою
  /// оплату».
  static String? ownRecordBlock(Employee me, String targetEmployeeId, List<Employee> all,
      {required String what}) {
    if (me.id != targetEmployeeId) return null;
    final otherAdmins = all.any((e) => e.id != me.id && e.role == AppConstants.roleAdmin);
    if (!otherAdmins) return null;
    return 'Менять $what нельзя — попросите другого администратора';
  }
}
