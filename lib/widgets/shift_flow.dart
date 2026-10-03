import 'package:flutter/material.dart';

import '../models/employee.dart';
import '../models/shift_model.dart';
import '../models/staff_shift_model.dart';
import '../services/firestore_service.dart';
import '../services/staff_session_store.dart';
import '../theme/app_colors.dart';
import '../utils/constants.dart';
import '../utils/human_error.dart';
import '../utils/shift_crew.dart';
import 'close_shift_dialog.dart';

/// Смены в заведении, где работают несколько человек.
///
/// «Смена заведения» — касса и X-отчёт, одна на всех. «Моя смена» — учёт
/// времени каждого сотрудника. Кальянщик закончил и ушёл домой — он
/// заканчивает СВОЮ смену; касса, X-отчёт официанта и бармена и вызовы
/// гостей у них продолжают работать. Смену заведения закрывает тот, кто
/// уходит последним (программа сама это подскажет), — с пересчётом кассы.
/// Закрыть её, пока в зале кто-то работает, можно только осознанно: с
/// предупреждением и списком тех, кто ещё на смене.

final _fs = FirestoreService();

String _hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

/// «в 18:02» сегодня, «26.09 в 18:02» — в другой день.
String shiftTimeLabel(DateTime d, {DateTime? now}) {
  final n = now ?? DateTime.now();
  final sameDay = d.year == n.year && d.month == n.month && d.day == n.day;
  if (sameDay) return 'в ${_hhmm(d)}';
  return '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')} в ${_hhmm(d)}';
}

/// Кто сейчас на смене — разово, перед решением.
Future<ShiftCrew> loadShiftCrew() async {
  final results = await Future.wait([_fs.openStaffShiftsOnce(), _fs.employeesOnce()]);
  return ShiftCrew(results[0] as List<StaffShiftModel>,
      employees: {for (final e in results[1] as List<Employee>) e.id: e});
}

/// Живой состав смены для экранов (меню, X-отчёт). null — ещё грузится.
class ShiftCrewBuilder extends StatelessWidget {
  final Widget Function(BuildContext context, ShiftCrew? crew) builder;
  const ShiftCrewBuilder({super.key, required this.builder});

  @override
  Widget build(BuildContext context) => StreamBuilder<List<StaffShiftModel>>(
        stream: _fs.openStaffShiftsStream(),
        builder: (context, shifts) => StreamBuilder<List<Employee>>(
          stream: _fs.employeesStream(),
          builder: (context, emps) {
            if (!shifts.hasData) return builder(context, null);
            return builder(
              context,
              ShiftCrew(shifts.data!, employees: {for (final e in emps.data ?? const <Employee>[]) e.id: e}),
            );
          },
        ),
      );
}

void _snack(BuildContext context, String text) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
}

/// Список «Аня · официант с 18:00» для диалогов.
Widget crewList(ShiftCrew crew, List<StaffShiftModel> shifts) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final s in shifts)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(children: [
              const Icon(Icons.person_outline, size: 18, color: AppColors.textMuted),
              const SizedBox(width: 8),
              Expanded(child: Text(crew.labelOf(s), style: const TextStyle(fontWeight: FontWeight.w600))),
              Text('с ${_hhmm(s.startedAt)}', style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
            ]),
          ),
      ],
    );

// ---------------------------------------------------------------- МОЯ СМЕНА

/// «Начать мою смену». Если смена заведения ещё закрыта — пришедший первым
/// открывает и её: без открытой смены нет ни X-отчёта, ни уведомлений.
/// Вчерашнюю незакрытую смену заведения предлагает сначала закрыть.
Future<void> startMyShift(BuildContext context, Employee me) async {
  try {
    var venue = await _fs.currentOpenShift();
    if (venue != null && isStaleShift(venue.openedAt)) {
      final crew = await loadShiftCrew();
      if (crew.isEmpty && context.mounted) {
        final closed = await _offerCloseStaleVenueShift(context, venue, me);
        if (closed == null) return; // передумал
        if (closed) venue = null;
      }
    }
    if (venue == null) {
      await _fs.openShiftIfNeeded(me.name, employeeId: me.id);
      await StaffSessionStore.instance.rememberShiftOwner(me.id);
    }
    await _fs.clockIn(me);
    if (context.mounted) _snack(context, venue == null ? 'Смена заведения открыта, ваша смена началась' : 'Ваша смена началась');
  } catch (e) {
    if (context.mounted) _snack(context, 'Не удалось начать смену: ${humanError(e, lower: true)}');
  }
}

/// Смена заведения открыта больше 16 часов и никто не на смене — это
/// вчерашняя смена, которую забыли закрыть. true — закрыли (можно
/// открывать новую), false — продолжаем её, null — отмена.
Future<bool?> _offerCloseStaleVenueShift(BuildContext context, ShiftModel venue, Employee me) async {
  final choice = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      scrollable: true,
      title: const Text('Прошлая смена не закрыта'),
      content: Text(
        'Смена заведения открыта ${shiftTimeLabel(venue.openedAt)}'
        '${venue.openedBy.isNotEmpty ? ' (открыл(а) ${venue.openedBy})' : ''}. '
        'Если это вчерашняя смена — закройте её с пересчётом кассы, и откроется новая: '
        'сегодняшние чеки не смешаются со вчерашними в X-отчёте.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
        TextButton(onPressed: () => Navigator.pop(ctx, 'keep'), child: const Text('Продолжить её')),
        FilledButton(onPressed: () => Navigator.pop(ctx, 'close'), child: const Text('Закрыть и начать новую')),
      ],
    ),
  );
  if (choice == null || !context.mounted) return null;
  if (choice == 'keep') return false;
  return await closeShiftWithCashCount(context, shift: venue, employee: me) ? true : null;
}

/// «Закончить мою смену».
///
/// Кто-то ещё работает — заканчивается только своя смена: касса и X-отчёт
/// остальных не меняются. Уходит последним — предлагаем закрыть и смену
/// заведения с пересчётом кассы (или оставить её сменщику).
Future<void> endMyShift(BuildContext context, Employee me, StaffShiftModel mine) async {
  ShiftCrew crew;
  ShiftModel? venue;
  try {
    crew = await loadShiftCrew();
    venue = await _fs.currentOpenShift();
  } catch (e) {
    if (context.mounted) _snack(context, 'Не удалось проверить, кто на смене: ${humanError(e, lower: true)}');
    return;
  }
  if (!context.mounted) return;

  // Забыл закончить вчера — спрашиваем, когда ушёл: иначе в зарплату
  // попадут сутки вместо восьми часов.
  if (isStaleShift(mine.startedAt)) {
    await _fixForgottenShift(context, me, mine);
    return;
  }

  final others = crew.othersThan(me.id);
  final last = venue != null && others.isEmpty;
  final worked = workedLabel(DateTime.now().difference(mine.startedAt));

  final choice = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(last ? 'Вы уходите последним' : 'Закончить вашу смену?'),
      content: SizedBox(
        width: 400,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Смена началась ${shiftTimeLabel(mine.startedAt)} · отработано $worked.'),
              const SizedBox(height: 12),
              if (others.isNotEmpty) ...[
                const Text('Смена заведения продолжается — на смене остаются:',
                    style: TextStyle(color: AppColors.textMuted)),
                const SizedBox(height: 6),
                crewList(crew, others),
                const SizedBox(height: 8),
                const Text('Их касса, X-отчёт и вызовы гостей не изменятся.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 13)),
              ] else if (last)
                const Text(
                  'Больше на смене никого нет. Закройте смену заведения — с пересчётом кассы. '
                  'Если скоро придёт сменщик, можно оставить её открытой: он продолжит ту же смену.',
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
        if (last) ...[
          TextButton(onPressed: () => Navigator.pop(ctx, 'mine'), child: const Text('Только мою смену')),
          FilledButton(onPressed: () => Navigator.pop(ctx, 'venue'), child: const Text('Закрыть смену заведения')),
        ] else
          FilledButton(onPressed: () => Navigator.pop(ctx, 'mine'), child: const Text('Закончить смену')),
      ],
    ),
  );
  if (choice == null || !context.mounted) return;

  if (choice == 'venue') {
    // Сначала касса: передумал на пересчёте — остаётся на смене.
    if (!await closeShiftWithCashCount(context, shift: venue!, employee: me)) return;
  }
  try {
    await _fs.clockOut(mine.id, me.id);
    if (choice == 'mine') {
      if (context.mounted) _snack(context, others.isEmpty ? 'Смена закончена' : 'Смена закончена. Смена заведения продолжается');
    }
  } catch (e) {
    if (context.mounted) _snack(context, 'Не удалось закончить смену: ${humanError(e, lower: true)}');
  }
}

/// Личная смена идёт 16+ часов — сотрудник забыл закончить её вчера.
/// Спрашиваем, когда он ушёл, и закрываем с этим временем.
Future<void> _fixForgottenShift(BuildContext context, Employee me, StaffShiftModel mine) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      scrollable: true,
      title: const Text('Прошлая смена не закончена'),
      content: Text(
        'Ваша смена идёт с ${shiftTimeLabel(mine.startedAt)} — похоже, вчера вы забыли её закончить. '
        'Укажите, во сколько ушли, — так зарплата посчитается правильно.',
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Указать время ухода')),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  final suggested = mine.startedAt.add(const Duration(hours: 8));
  final time = await showTimePicker(
    context: context,
    initialTime: TimeOfDay.fromDateTime(suggested),
    helpText: 'Во сколько вы ушли?',
  );
  if (time == null || !context.mounted) return;
  final end = leftAtFromTime(mine.startedAt, time.hour, time.minute);
  if (end.isAfter(DateTime.now())) {
    _snack(context, 'Это время ещё не наступило — выберите время ухода');
    return;
  }
  try {
    await _fs.clockOut(mine.id, me.id, endedAt: end, editor: me);
    if (context.mounted) _snack(context, 'Прошлая смена закрыта: ${shiftTimeLabel(mine.startedAt)} — ${shiftTimeLabel(end)}');
  } catch (e) {
    if (context.mounted) _snack(context, 'Не удалось закрыть смену: ${humanError(e, lower: true)}');
  }
}

/// Время ухода по часам и минутам: первое такое время после начала смены
/// (ушёл в 02:00 после смены с 18:00 — это уже следующие сутки).
DateTime leftAtFromTime(DateTime startedAt, int hour, int minute) {
  var end = DateTime(startedAt.year, startedAt.month, startedAt.day, hour, minute);
  if (!end.isAfter(startedAt)) end = end.add(const Duration(days: 1));
  return end;
}

// ---------------------------------------------------------- СМЕНА ЗАВЕДЕНИЯ

/// «Закрыть смену заведения» — из меню и из X-отчёта.
///
/// Если в зале ещё кто-то работает — предупреждаем и показываем, кто:
/// закрытие закроет кассу и X-отчёт для всех. Уходит только сам —
/// предлагаем вместо этого закончить свою смену. После пересчёта кассы
/// отмечаем уход закрывающего и (по галочке) всех, кто был на смене.
Future<bool> closeVenueShift(BuildContext context, {required ShiftModel shift, required Employee me}) async {
  ShiftCrew crew;
  try {
    crew = await loadShiftCrew();
  } catch (_) {
    crew = ShiftCrew(const []);
  }
  if (!context.mounted) return false;
  final mine = crew.shifts.where((s) => s.employeeId == me.id).firstOrNull;
  final others = crew.othersThan(me.id);
  var endOthers = true;

  if (others.isNotEmpty) {
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Закрыть смену для всех?'),
          content: SizedBox(
            width: 400,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Сейчас на смене ещё ${ShiftCrew.peopleCount(others.length)}:'),
                  const SizedBox(height: 6),
                  crewList(crew, others),
                  const SizedBox(height: 10),
                  const Text(
                    'Смена заведения одна на всех: после закрытия у всех сотрудников закроются касса '
                    'и X-отчёт текущей смены.',
                    style: TextStyle(fontSize: 13),
                  ),
                  if (mine != null) ...[
                    const SizedBox(height: 8),
                    const Text(
                      'Если домой уходите только вы — закончите свою смену, а смену заведения закроет последний.',
                      style: TextStyle(fontSize: 13, color: AppColors.textMuted),
                    ),
                  ],
                  const SizedBox(height: 4),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    value: endOthers,
                    onChanged: (v) => setLocal(() => endOthers = v ?? true),
                    title: const Text('Все уходят — закончить и их смены', style: TextStyle(fontSize: 14)),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Отмена')),
            if (mine != null)
              TextButton(onPressed: () => Navigator.pop(ctx, 'mine'), child: const Text('Закончить только мою')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: AppColors.danger),
              onPressed: () => Navigator.pop(ctx, 'all'),
              child: const Text('Закрыть для всех'),
            ),
          ],
        ),
      ),
    );
    if (choice == null || !context.mounted) return false;
    if (choice == 'mine') {
      try {
        await _fs.clockOut(mine!.id, me.id);
        if (context.mounted) _snack(context, 'Ваша смена закончена. Смена заведения продолжается');
      } catch (e) {
        if (context.mounted) _snack(context, 'Не удалось закончить смену: ${humanError(e, lower: true)}');
      }
      return false;
    }
  }

  if (!await closeShiftWithCashCount(context, shift: shift, employee: me)) return false;
  // Касса закрыта — отмечаем уход. Ошибку здесь не показываем поверх
  // сообщения о закрытии: незакрытую личную смену видно в меню и табеле.
  final leaving = [if (mine != null) mine, if (endOthers) ...others];
  for (final s in leaving) {
    try {
      await _fs.clockOut(s.id, s.employeeId);
    } catch (_) {}
  }
  return true;
}

// ------------------------------------------------------------- ПРИ ВХОДЕ

/// Своя смена со вчера не закончена — первым делом спросить время ухода,
/// до открытия новой смены: иначе новая смена продолжила бы вчерашнюю.
Future<void> fixMyForgottenShiftIfAny(BuildContext context, Employee me) async {
  StaffShiftModel? mine;
  try {
    final open = await _fs.openStaffShiftsOnce();
    mine = open.where((s) => s.employeeId == me.id && s.isOpen && isStaleShift(s.startedAt)).firstOrNull;
  } catch (_) {
    return;
  }
  if (mine == null || !context.mounted) return;
  await _fixForgottenShift(context, me, mine);
}

/// Сотрудник вошёл, а смена заведения уже идёт. Возвращает false, если
/// это была вчерашняя смена и её только что закрыли — тогда вызывающий
/// открывает новую (см. ensureShiftOpen).
///
/// Здесь же: забытая вчера своя смена — спрашиваем время ухода; сам
/// ещё не на смене — предлагаем начать (без этого программа не знает,
/// кто в зале, и вызовы гостей ему не придут).
Future<bool> joinOpenVenueShift(BuildContext context, {required Employee me, required ShiftModel venue}) async {
  ShiftCrew crew;
  try {
    crew = await loadShiftCrew();
  } catch (_) {
    return true;
  }
  if (!context.mounted) return true;

  if (isStaleShift(venue.openedAt) && crew.isEmpty) {
    final closed = await _offerCloseStaleVenueShift(context, venue, me);
    if (closed == true) return false;
    if (closed == null) return true;
  }

  // Админ заводит меню и смотрит отчёты — в зале он не работает, и
  // спрашивать его «начать смену?» при каждом входе незачем.
  if (me.role == AppConstants.roleAdmin || crew.has(me.id) || !context.mounted) return true;

  final start = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      scrollable: true,
      title: const Text('Начать вашу смену?'),
      content: SizedBox(
        width: 400,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Смена заведения открыта ${shiftTimeLabel(venue.openedAt)}.'),
            const SizedBox(height: 10),
            if (crew.isEmpty)
              const Text('Пока никто не отметил начало смены.', style: TextStyle(color: AppColors.textMuted))
            else ...[
              const Text('Сейчас на смене:', style: TextStyle(color: AppColors.textMuted)),
              const SizedBox(height: 4),
              crewList(crew, crew.shifts),
            ],
            const SizedBox(height: 10),
            const Text(
              'Начните смену, если вы сейчас работаете: вызовы гостей будут приходить и вам, '
              'а время посчитается в зарплату.',
              style: TextStyle(fontSize: 13),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Не сейчас')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Начать смену')),
      ],
    ),
  );
  if (start == true) {
    try {
      await _fs.clockIn(me);
      if (context.mounted) _snack(context, 'Ваша смена началась');
    } catch (e) {
      if (context.mounted) _snack(context, 'Не удалось начать смену: ${humanError(e, lower: true)}');
    }
  }
  return true;
}
