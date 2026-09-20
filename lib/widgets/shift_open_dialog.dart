import 'package:flutter/material.dart';

import '../models/employee.dart';
import '../services/firestore_service.dart';
import '../services/staff_session_store.dart';

/// Спрашивает, кто выходит на смену, и открывает её.
///
/// Смена — это не только строка в X-отчёте. По тому, кто её открыл, оба
/// приложения решают, на чей телефон слать вызовы гостей, брони, «смени
/// угли» и «сеанс заканчивается». Раньше смена открывалась молча на того,
/// кто первым разблокировал планшет: ночная смена закрывалась, днём
/// приходил другой кальянщик, а уведомления продолжали уходить не ему.
///
/// В списке только сотрудники: администратор заводит меню и смотрит
/// отчёты, в зале он не стоит, и вызовы гостей ему не нужны. Открыть смену
/// на кальянщика админ при этом может — он просто выбирает его из списка.
///
/// Возвращает true, если смена открыта (или уже была открыта).
Future<bool> ensureShiftOpen(BuildContext context, {required Employee me}) async {
  final fs = FirestoreService();

  // Смена уже открыта — спрашивать нечего. Ошибку сети здесь глотаем
  // намеренно: не смогли проверить — не мешаем человеку работать, смену
  // всегда можно открыть из бокового меню.
  try {
    if (await fs.currentOpenShift() != null) return true;
  } catch (_) {
    return false;
  }

  List<Employee> staff;
  try {
    staff = await fs.shiftCandidates();
  } catch (_) {
    staff = const [];
  }

  // Список не загрузился или в заведении заведены одни администраторы —
  // ведём себя как раньше и открываем смену на вошедшего. Работа важнее
  // аккуратности: без открытой смены не будет ни X-отчёта, ни уведомлений.
  if (staff.isEmpty) {
    try {
      await fs.openShiftIfNeeded(me.name, employeeId: me.id);
      // Открыл смену — значит, уже на месте и работает: отдельно нажимать
      // "Начать смену" в личном учёте времени не нужно (см. clockIn —
      // если пришёл раньше открытия заведения, часы для зарплаты всё равно
      // начнутся не раньше времени открытия, а не с этого нажатия).
      // Ошибку тут глотаем: касса важнее — смена уже открыта и это главное.
      try {
        await fs.clockIn(me);
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }

  // Вошедший — первым в списке: чаще всего смену открывает он сам себе.
  staff.sort((a, b) {
    if (a.id == me.id) return -1;
    if (b.id == me.id) return 1;
    return 0;
  });

  if (!context.mounted) return false;
  final chosen = await showDialog<Employee>(
    context: context,
    // Закрыть тычком мимо нельзя: вопрос короткий, а молча пропущенный
    // ответ стоит вечера без уведомлений. Кнопка «Позже» рядом есть.
    barrierDismissible: false,
    builder: (ctx) => _WhoIsOnShiftDialog(staff: staff, meId: me.id),
  );
  if (chosen == null) return false;

  try {
    await fs.openShiftIfNeeded(chosen.name, employeeId: chosen.id);
    // Смена открыта на chosen — значит, личный учёт времени начинается у
    // НЕГО, а не у того, кто физически нажал кнопку (это мог быть админ,
    // открывающий смену на кальянщика). Ошибку глотаем: касса важнее.
    try {
      await fs.clockIn(chosen);
    } catch (_) {}
    // Этот планшет стоит в зале — с него и открыли смену. Значит вызовы
    // гостей надо показывать здесь, даже если вошёл в него админ, а смену
    // он открыл на кальянщика.
    await StaffSessionStore.instance.rememberShiftOwner(chosen.id);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Смена открыта: ${chosen.name}')),
      );
    }
    return true;
  } catch (_) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Не удалось открыть смену — попробуйте из меню')),
      );
    }
    return false;
  }
}

class _WhoIsOnShiftDialog extends StatelessWidget {
  final List<Employee> staff;
  final String meId;

  const _WhoIsOnShiftDialog({required this.staff, required this.meId});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Кто на смене?'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: Text(
                'Вызовы гостей, брони и напоминания об углях будут приходить '
                'тому, кого выберете.',
                style: TextStyle(fontSize: 13),
              ),
            ),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: staff.length,
                itemBuilder: (_, i) {
                  final e = staff[i];
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: CircleAvatar(
                      child: Text(e.name.isEmpty ? '?' : e.name.characters.first.toUpperCase()),
                    ),
                    title: Text(e.name.isEmpty ? 'Без имени' : e.name),
                    subtitle: e.id == meId ? const Text('это я') : null,
                    onTap: () => Navigator.pop(context, e),
                  );
                },
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Позже'),
        ),
      ],
    );
  }
}
