import 'package:flutter/material.dart';

import '../build_info.dart';

import '../models/reservation_model.dart';
import '../models/table_model.dart';
import '../theme/app_colors.dart';
import '../utils/bill_split.dart';
import '../utils/constants.dart';
import '../utils/hall_layout.dart';
import '../utils/table_label.dart';
import 'clock_ticker.dart';
import 'table_shape.dart';
import 'timer_display.dart';

/// Цвета состояний стола — общие для схемы, списка и сводки зала.
class TableStateColors {
  // Тона — в палитре темы (AppPalette.tableFree и соседи).
  static Color get free => AppColors.palette.tableFree;
  static Color get reserved => AppColors.palette.tableReserved;
  static Color get occupied => AppColors.palette.tableOccupied;
  static Color get ending => AppColors.warning;
  static Color get overdue => AppColors.danger;

  static Color of(TableState s) {
    switch (s) {
      case TableState.free:
        return free;
      case TableState.reserved:
        return reserved;
      case TableState.occupied:
        return occupied;
      case TableState.ending:
        return ending;
      case TableState.overdue:
        return overdue;
    }
  }
}

/// Плитка стола на схеме зала. Все плитки одного тёмного тона, состояние —
/// цветом рамки, точки и подписи: внимание забирают только «время вышло» и
/// вызов гостя.
class TableTile extends StatelessWidget {
  /// Размер плитки на логическом холсте схемы (см. hall_layout.dart).
  static const double size = kHallTile;

  final TableModel table;
  final DateTime? plannedEnd; // конец ближайшего чека
  final DateTime? startTime; // начало этого чека — для стола «без ограничений»
  final VoidCallback? onTap;
  final bool isDraggablePreview;
  final int checkCount; // сколько чеков сейчас открыто на столе

  /// Подпись чека (кто сидит за столом) — видна прямо на плитке.
  final String? guestTag;

  /// Сумма счёта ближайшего чека.
  final double? billTotal;

  /// Ближайшая бронь на этот стол (для свободного стола).
  final ReservationModel? reservation;

  /// Гость за этим столом зовёт — на плитке колокольчик.
  final bool hasCall;

  /// Стол не подходит под выбранный фильтр — приглушён, но остаётся на
  /// своём месте, чтобы не терялась картина зала.
  final bool dimmed;

  /// Режим редактора: показываем только форму, имя и места.
  final bool editorMode;

  /// Редактор: кнопка «Повернуть» прямо на плитке (для форм, у которых
  /// поворот что-то меняет).
  final VoidCallback? onRotate;

  const TableTile({
    super.key,
    required this.table,
    this.plannedEnd,
    this.startTime,
    this.onTap,
    this.isDraggablePreview = false,
    this.checkCount = 1,
    this.guestTag,
    this.billTotal,
    this.reservation,
    this.hasCall = false,
    this.dimmed = false,
    this.editorMode = false,
    this.onRotate,
  });

  @override
  Widget build(BuildContext context) {
    // Цвет зависит от текущего времени (синий → оранжевый → красный), а не
    // только от данных из базы — плитка перестраивается по общему тикеру.
    final end = plannedEnd ?? table.busyUntil;
    if (!editorMode && table.activeSessionIds.isNotEmpty && end != null) {
      // SaaS: плитка перестраивается только когда меняется её состояние
      // (занят → скоро конец → время вышло), а секунды таймера тикают в
      // своём маленьком слое. Раньше вся плитка — с тенью, рамкой и
      // подписями — перерисовывалась каждую секунду, и на слабых
      // компьютерах (старый моноблок на Windows) зал подтормаживал.
      if (kSaasMode) {
        return _StateTicker(
          stateAt: (now) => tableStateOf(table, now: now, plannedEnd: plannedEnd, reservation: reservation),
          builder: (context, now) => _build(context, now),
        );
      }
      return TickerBuilder(builder: (context, now) => _build(context, now));
    }
    return _build(context, DateTime.now());
  }

  Widget _build(BuildContext context, DateTime now) {
    final state = editorMode
        ? TableState.free
        : tableStateOf(table, now: now, plannedEnd: plannedEnd, reservation: reservation);
    final color = editorMode ? AppColors.textMuted : TableStateColors.of(state);
    final circle = table.shape == 'circle';
    final busy = state.isBusy;
    final loud = state == TableState.overdue || hasCall;

    final lines = <Widget>[
      Text(table.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.w700, fontSize: 16)),
    ];
    if (busy && guestTag != null && guestTag!.isNotEmpty) {
      lines.add(Text(guestTag!,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: AppColors.textPrimary, fontSize: 11.5, fontStyle: FontStyle.italic)));
    } else {
      lines.add(Text(seatsLabel(table.seats), style: TextStyle(color: AppColors.textMuted, fontSize: 11.5)));
    }
    if (!editorMode) {
      lines.add(const SizedBox(height: 4));
      if (busy && (plannedEnd ?? table.busyUntil) != null) {
        final timer = TimerDisplay(plannedEnd: (plannedEnd ?? table.busyUntil)!, startTime: startTime, fontSize: 13);
        lines.add(kSaasMode ? _TimerSlot(fontSize: 13, child: timer) : timer);
      } else {
        lines.add(Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 5),
          Text(
            state == TableState.reserved ? 'Бронь ${hhmm(reservation!.startTime)}' : state.label,
            style: TextStyle(color: color, fontSize: 11.5, fontWeight: FontWeight.w600),
          ),
        ]));
      }
      if (busy && billTotal != null && billTotal! > 0) {
        lines.add(Text(formatKopecks((billTotal! * 100).round()),
            style: TextStyle(color: AppColors.textPrimary, fontSize: 12, fontWeight: FontWeight.w700)));
      }
    }

    final tile = TableShapeBox(
      table: table,
      size: hallTileSize(table),
      fill: busy ? Color.alphaBlend(color.withValues(alpha: 0.16), AppColors.surface) : AppColors.surface,
      borderColor: isDraggablePreview ? Colors.white : color.withValues(alpha: busy || loud ? 0.95 : 0.6),
      borderWidth: loud ? 2.5 : 1.6,
      shadows: [
        BoxShadow(
          color: loud ? color.withValues(alpha: 0.45) : Colors.black.withValues(alpha: AppColors.isLight ? 0.08 : 0.35),
          blurRadius: loud ? 14 : 6,
          offset: const Offset(0, 2),
        ),
      ],
      // Ширина подписей — по тексту (не больше плитки): у треугольного
      // стола так они уменьшаются меньше и остаются читаемыми.
      child: FittedBox(
        fit: BoxFit.scaleDown,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: size - (circle ? 28 : 16)),
          child: Column(mainAxisSize: MainAxisSize.min, children: lines),
        ),
      ),
    );

    return Semantics(
      button: onTap != null,
      label: '${table.name}, ${editorMode ? seatsLabel(table.seats) : state.label}${hasCall ? ', гость зовёт' : ''}',
      excludeSemantics: false,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedOpacity(
          duration: const Duration(milliseconds: 200),
          opacity: dimmed ? 0.25 : 1,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              tile,
              if (hasCall)
                Positioned(right: -6, top: -6, child: _Badge(icon: Icons.notifications_active, color: AppColors.danger)),
              if (checkCount > 1 && busy)
                Positioned(
                  left: -6,
                  top: -6,
                  child: _Badge(text: '$checkCount', color: AppColors.surfaceElevated),
                ),
              if (onRotate != null && tableShapeRotates(table.shape))
                Positioned.fill(
                  child: Align(
                    alignment: tableFreeCorner(table),
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Tooltip(
                        message: 'Повернуть',
                        child: GestureDetector(
                          onTap: onRotate,
                          child: Container(
                            width: 32,
                            height: 32,
                            decoration: BoxDecoration(
                              color: AppColors.surfaceElevated,
                              shape: BoxShape.circle,
                              border: Border.all(color: AppColors.border),
                            ),
                            child: Icon(Icons.rotate_right, size: 20, color: AppColors.textPrimary),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  final IconData? icon;
  final String? text;
  final Color color;
  const _Badge({this.icon, this.text, required this.color});

  @override
  Widget build(BuildContext context) => Container(
        constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(13),
          border: Border.all(color: AppColors.background, width: 2),
        ),
        child: icon != null
            ? Icon(icon, size: 14, color: Colors.white)
            : Text(text!, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
      );
}

/// Карточка стола для режима «Список» — удобнее схемы на телефоне: крупные
/// кнопки, всё видно без масштабирования, сортировка по номеру.
class TableCard extends StatelessWidget {
  final TableModel table;
  final DateTime? plannedEnd;
  final DateTime? startTime;
  final String? guestTag;
  final double? billTotal;
  final ReservationModel? reservation;
  final bool hasCall;
  final int checkCount;
  final VoidCallback? onTap;

  const TableCard({
    super.key,
    required this.table,
    this.plannedEnd,
    this.startTime,
    this.guestTag,
    this.billTotal,
    this.reservation,
    this.hasCall = false,
    this.checkCount = 1,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final end = plannedEnd ?? table.busyUntil;
    if (table.activeSessionIds.isNotEmpty && end != null) {
      return TickerBuilder(builder: (context, now) => _build(now));
    }
    return _build(DateTime.now());
  }

  Widget _build(DateTime now) {
    if (kSaasMode) return _buildSaas(now);
    final state = tableStateOf(table, now: now, plannedEnd: plannedEnd, reservation: reservation);
    final color = TableStateColors.of(state);
    final busy = state.isBusy;
    final loud = state == TableState.overdue || hasCall;
    final end = plannedEnd ?? table.busyUntil;

    Widget statusLine;
    if (busy) {
      statusLine = Row(children: [
        Expanded(
          child: Text(
            guestTag != null && guestTag!.isNotEmpty ? guestTag! : state.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: guestTag?.isNotEmpty == true ? AppColors.textPrimary : color, fontSize: 13),
          ),
        ),
        if (end != null) TimerDisplay(plannedEnd: end, startTime: startTime, fontSize: 13),
      ]);
    } else if (state == TableState.reserved) {
      final r = reservation!;
      statusLine = Text(
        'Бронь ${hhmm(r.startTime)} · ${r.guestName.isEmpty ? 'гость' : r.guestName}, ${r.guestsCount} чел.',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: color, fontSize: 13, fontWeight: FontWeight.w600),
      );
    } else {
      statusLine = Text('Свободен', style: TextStyle(color: color, fontSize: 13, fontWeight: FontWeight.w600));
    }

    return Semantics(
      button: true,
      label: '${table.name}, ${state.label}${hasCall ? ', гость зовёт' : ''}',
      child: Material(
        color: busy ? Color.alphaBlend(color.withValues(alpha: 0.12), AppColors.surface) : AppColors.surface,
        borderRadius: BorderRadius.circular(18),
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: color.withValues(alpha: loud ? 1 : 0.55), width: loud ? 2 : 1.2),
            ),
            padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(children: [
                  Container(width: 9, height: 9, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(table.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  ),
                  if (hasCall) Icon(Icons.notifications_active, color: AppColors.danger, size: 20),
                  if (checkCount > 1 && busy)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: Text('$checkCount ${pluralRu(checkCount, 'чек', 'чека', 'чеков')}',
                          style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                    ),
                ]),
                const SizedBox(height: 4),
                Row(children: [
                  Icon(Icons.chair_outlined, size: 15, color: AppColors.textMuted),
                  const SizedBox(width: 4),
                  Text('${table.seats}', style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
                  const Spacer(),
                  if (busy && billTotal != null && billTotal! > 0)
                    Text(formatKopecks((billTotal! * 100).round()),
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                ]),
                const SizedBox(height: 8),
                statusLine,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// SaaS: карточка стола в «Списке». Спокойная для свободных столов (раньше
/// каждый свободный стол был обведён ярко-зелёным и «кричал» громче
/// занятого), заметная для занятых и брони: крупно — сумма и время, ниже —
/// кто сидит или кто придёт, внизу — полоска «сколько времени стола
/// прошло». Вызов гостя — красная рамка и колокольчик.
extension _TableCardSaas on TableCard {
  /// Главная строка карточки: слева крупно (сумма или время брони), справа
  /// мельче (таймер). При крупном шрифте телефона текст уменьшается, а не
  /// обрезается многоточием — сумму всегда видно целиком.
  Widget _pair(Widget left, Widget? right, {int leftFlex = 3, int rightFlex = 2}) => Row(children: [
        Flexible(
          flex: leftFlex,
          child: Align(
            alignment: Alignment.centerLeft,
            child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: left),
          ),
        ),
        if (right != null) ...[
          const SizedBox(width: 8),
          Flexible(
            flex: rightFlex,
            child: Align(
              alignment: Alignment.centerRight,
              child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerRight, child: right),
            ),
          ),
        ],
      ]);

  Widget _buildSaas(DateTime now) {
    final state = tableStateOf(table, now: now, plannedEnd: plannedEnd, reservation: reservation);
    final color = TableStateColors.of(state);
    final busy = state.isBusy;
    final loud = state == TableState.overdue || hasCall;
    final end = plannedEnd ?? table.busyUntil;
    final timed = busy && end != null && !AppConstants.isUnlimitedRemaining(end.difference(now));
    final num = TextStyle(fontFeatures: const [FontFeature.tabularFigures()], color: AppColors.textPrimary);

    // Доля времени стола, которая уже прошла (только у стола со временем).
    double? progress;
    if (timed && startTime != null) {
      final total = end.difference(startTime!).inSeconds;
      if (total > 0) progress = (now.difference(startTime!).inSeconds / total).clamp(0.0, 1.0);
    }

    Widget seats = Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(Icons.people_alt_outlined, size: 15, color: AppColors.textMuted),
      const SizedBox(width: 4),
      Text('${table.seats}', style: num.copyWith(color: AppColors.textMuted, fontSize: 13, fontWeight: FontWeight.w600)),
    ]);

    Widget main;
    Widget? caption;
    if (busy) {
      final bill = billTotal != null && billTotal! > 0 ? formatKopecks((billTotal! * 100).round()) : null;
      main = _pair(
        Text(bill ?? 'Счёт пуст',
            maxLines: 1,
            style: bill != null
                ? num.copyWith(fontSize: 20, fontWeight: FontWeight.w800, letterSpacing: -0.3)
                : TextStyle(color: AppColors.textMuted, fontSize: 14)),
        end == null
            ? null
            : DefaultTextStyle.merge(
                style: TextStyle(color: color),
                child: TimerDisplay(plannedEnd: end, startTime: startTime, fontSize: 14),
              ),
      );
      final who = guestTag != null && guestTag!.isNotEmpty ? guestTag! : null;
      final parts = [
        if (who != null) who,
        if (checkCount > 1) '$checkCount ${pluralRu(checkCount, 'чек', 'чека', 'чеков')}',
        if (state != TableState.occupied) state.label,
        if (who == null && checkCount <= 1 && state == TableState.occupied) timed ? 'осталось времени' : 'Гости за столом',
      ];
      caption = Text(parts.join(' · '),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
              color: state == TableState.occupied ? AppColors.textMuted : color,
              fontSize: 12.5,
              fontWeight: state == TableState.occupied ? FontWeight.w500 : FontWeight.w700));
    } else if (state == TableState.reserved) {
      final r = reservation!;
      final mins = r.startTime.difference(now).inMinutes;
      final late = mins <= 0;
      main = _pair(
        Text(hhmm(r.startTime),
            maxLines: 1,
            style: num.copyWith(color: color, fontSize: 20, fontWeight: FontWeight.w800, letterSpacing: -0.3)),
        Text(late ? 'опаздывает' : 'через ${mins >= 60 ? '${mins ~/ 60} ч ${mins % 60} м' : '$mins мин'}',
            maxLines: 1,
            style: num.copyWith(
                color: late ? AppColors.danger : AppColors.textMuted, fontSize: 12.5, fontWeight: FontWeight.w600)),
        leftFlex: 1,
        rightFlex: 1,
      );
      caption = Text('Бронь · ${r.guestName.isEmpty ? 'гость' : r.guestName} · ${r.guestsCount} чел.',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: AppColors.textMuted, fontSize: 12.5));
    } else {
      main = Row(children: [
        Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 8),
        Text('Свободен', style: TextStyle(color: AppColors.textPrimary.withValues(alpha: 0.85), fontSize: 15, fontWeight: FontWeight.w600)),
      ]);
      caption = table.zone.isEmpty
          ? null
          : Text(table.zone, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: AppColors.textMuted, fontSize: 12.5));
    }

    final borderColor = hasCall
        ? AppColors.danger
        : busy || state == TableState.reserved
            ? color.withValues(alpha: loud ? 1 : 0.5)
            : AppColors.border;
    final fill = busy
        ? Color.alphaBlend(color.withValues(alpha: AppColors.isLight ? 0.07 : 0.10), AppColors.surface)
        : AppColors.surface;

    return Semantics(
      button: true,
      label: '${table.name}, ${state.label}${hasCall ? ', гость зовёт' : ''}',
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(20),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: borderColor, width: loud ? 2 : 1),
            ),
            child: Stack(children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(children: [
                      Expanded(
                        child: Text(table.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: AppColors.textPrimary, letterSpacing: -0.2)),
                      ),
                      if (hasCall)
                        Container(
                          margin: const EdgeInsets.only(right: 8),
                          padding: const EdgeInsets.all(4),
                          decoration: BoxDecoration(color: AppColors.danger, shape: BoxShape.circle),
                          child: const Icon(Icons.notifications_active, size: 14, color: Colors.white),
                        ),
                      seats,
                    ]),
                    main,
                    caption ?? const SizedBox(height: 16),
                  ],
                ),
              ),
              if (progress != null)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 3,
                  child: FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: progress,
                    child: ColoredBox(color: color.withValues(alpha: 0.9)),
                  ),
                ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Перестраивает плитку только когда меняется состояние стола: общий
/// секундомер тикает, но если состояние то же — плитка не трогается.
class _StateTicker extends StatefulWidget {
  const _StateTicker({required this.stateAt, required this.builder});

  final TableState Function(DateTime now) stateAt;
  final Widget Function(BuildContext context, DateTime now) builder;

  @override
  State<_StateTicker> createState() => _StateTickerState();
}

class _StateTickerState extends State<_StateTicker> {
  // Секундомер мог стоять (не было занятых столов) — берём текущее время.
  late DateTime _now = DateTime.now();
  late TableState _state = widget.stateAt(_now);

  @override
  void initState() {
    super.initState();
    ClockTicker.instance.addListener(_tick);
  }

  @override
  void didUpdateWidget(_StateTicker old) {
    super.didUpdateWidget(old);
    // Новые данные стола (продлили, закрыли чек) — состояние пересчитать.
    _now = DateTime.now();
    _state = widget.stateAt(_now);
  }

  void _tick() {
    final now = ClockTicker.instance.value;
    final next = widget.stateAt(now);
    if (next == _state) return;
    setState(() {
      _now = now;
      _state = next;
    });
  }

  @override
  void dispose() {
    ClockTicker.instance.removeListener(_tick);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _now);
}

/// Место под таймер фиксированного размера в своём слое: секунды меняют
/// только эту строку — плитка с тенью и рамкой не перерисовывается и не
/// пересчитывает раскладку.
class _TimerSlot extends StatelessWidget {
  const _TimerSlot({required this.fontSize, required this.child});

  final double fontSize;
  final Widget child;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: fontSize * 5.6,
        height: fontSize * 1.4,
        child: RepaintBoundary(
          child: FittedBox(fit: BoxFit.scaleDown, child: child),
        ),
      );
}
