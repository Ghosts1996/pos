import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../models/client_models.dart';
import '../../models/employee.dart';
import '../../models/reservation_model.dart';
import '../../models/session_model.dart';
import '../../models/table_model.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/firestore_service.dart';
import '../../services/guest_link_service.dart';
import '../../services/reservation_service.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/hall_layout.dart';
import '../../widgets/ai_assistant_sheet.dart';
import '../../widgets/employee_drawer.dart';
import '../../widgets/guest_requests_banner.dart';
import '../../widgets/hall_plan_view.dart';
import '../../widgets/table_tile.dart';
import 'table_detail_screen.dart';

/// Какие столы показывать.
enum _HallFilter { all, free, busy, ending, reserved }

/// Зал для сотрудника: сводка по столам, фильтры, зоны и два вида —
/// «Список» (удобно на телефоне) и «Схема» (как расставил администратор).
///
/// Сверху — полоса обращений гостей (вызовы и заказы из приложения гостя).
class FloorPlanScreen extends StatefulWidget {
  final Employee employee;
  const FloorPlanScreen({super.key, required this.employee});

  @override
  State<FloorPlanScreen> createState() => _FloorPlanScreenState();
}

class _FloorPlanScreenState extends State<FloorPlanScreen> {
  static const _viewKey = 'hall_view_mode_v1';
  final _fs = FirestoreService();

  // Стримы создаются один раз: StreamBuilder сравнивает стримы по ссылке, и
  // стрим, созданный прямо в build, переподписывался бы на каждый кадр.
  late final Stream<List<TableModel>> _tables = _fs.tablesStream();
  late final Stream<List<WaiterCall>> _calls = GuestLinkService().openCallsStream();
  late final Stream<List<ReservationModel>> _reservations = ReservationService().upcomingStream(hours: 3);

  bool? _planMode; // null — ещё не прочитали настройку
  _HallFilter _filter = _HallFilter.all;
  String? _zone; // null — все зоны
  DateTime _now = DateTime.now();
  Timer? _minute;

  @override
  void initState() {
    super.initState();
    _loadViewMode();
    // Сводка («скоро освободятся», брони) зависит от времени — пересчёт раз
    // в полминуты; секундные таймеры на плитках идут сами.
    _minute = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _minute?.cancel();
    super.dispose();
  }

  Future<void> _loadViewMode() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString(_viewKey);
      if (v != null && mounted) setState(() => _planMode = v == 'plan');
    } catch (_) {}
  }

  Future<void> _setPlanMode(bool plan) async {
    setState(() => _planMode = plan);
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_viewKey, plan ? 'plan' : 'grid');
    } catch (_) {}
  }

  void _openTable(TableModel t) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TableDetailScreen(
        table: t,
        employee: widget.employee,
        // Если на столе уже есть открытые чеки — сразу открываем первый;
        // переключиться можно внутри самого экрана стола.
        sessionId: t.activeSessionIds.isNotEmpty ? t.activeSessionIds.first : null,
      ),
    ));
  }

  bool _matches(TableState s) {
    switch (_filter) {
      case _HallFilter.all:
        return true;
      case _HallFilter.free:
        return s == TableState.free || s == TableState.reserved;
      case _HallFilter.busy:
        return s.isBusy;
      case _HallFilter.ending:
        return s == TableState.ending || s == TableState.overdue;
      case _HallFilter.reserved:
        return s == TableState.reserved;
    }
  }

  // Зал — корневой экран кассы: под ним только заставка запуска, и
  // системная «Назад» уводила на пустой экран с логотипом.
  @override
  Widget build(BuildContext context) => PopScope(canPop: false, child: _page(context));

  Widget _page(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Зал'),
            Text(widget.employee.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted, fontWeight: FontWeight.w400)),
          ],
        ),
        actions: [
          LayoutBuilder(builder: (context, _) {
            final plan = _planMode ?? MediaQuery.sizeOf(context).width >= 600;
            return IconButton(
              tooltip: plan ? 'Показать списком' : 'Показать схемой',
              icon: Icon(plan ? Icons.grid_view_rounded : Icons.map_outlined),
              onPressed: () => _setPlanMode(!plan),
            );
          }),
          IconButton(
            tooltip: 'Ассистент зала',
            icon: const Icon(Icons.auto_awesome),
            onPressed: () => AiAssistantSheet.show(
              context,
              agent: AiAgents.hall,
              // Данные зала кладём в промпт заранее: иначе ассистент
              // отвечает «данных нет», если шлюз не умеет инструменты.
              asyncContextBuilder: AiService.instance.hallContext,
              quickPrompts: const [
                'Какие столы освободятся через час?',
                'Куда посадить компанию из шести человек?',
                'Что заканчивается на складе?',
              ],
            ),
          ),
        ],
      ),
      drawer: EmployeeDrawer(employee: widget.employee),
      body: Column(
        children: [
          GuestRequestsBanner(
            employee: widget.employee,
            onOpenTable: (tableId, sessionId) async {
              final table = await _fs.tableStream(tableId).first;
              if (table == null || !context.mounted) return;
              Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => TableDetailScreen(
                  table: table,
                  employee: widget.employee,
                  sessionId: sessionId.isEmpty ? null : sessionId,
                ),
              ));
            },
          ),
          Expanded(
            child: StreamBuilder<List<TableModel>>(
              stream: _tables,
              builder: (context, snap) {
                if (snap.hasError) {
                  return _message(Icons.cloud_off_outlined, 'Не удалось загрузить зал',
                      'Проверьте интернет — столы появятся, как только связь вернётся.');
                }
                if (!snap.hasData) return const Center(child: CircularProgressIndicator());
                final tables = snap.data!;
                if (tables.isEmpty) {
                  return _message(Icons.table_restaurant_outlined, 'Столов пока нет',
                      'Администратор добавляет их в «Карта зала» — там же расставляет по схеме.');
                }
                return StreamBuilder<List<WaiterCall>>(
                  stream: _calls,
                  builder: (context, callsSnap) => StreamBuilder<List<ReservationModel>>(
                    stream: _reservations,
                    builder: (context, resSnap) => _hall(
                      tables,
                      callTables: {for (final c in callsSnap.data ?? const <WaiterCall>[]) c.tableId},
                      reservations: nextReservationsByTable(resSnap.data ?? const [], now: _now),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _hall(List<TableModel> all, {required Set<String> callTables, required Map<String, ReservationModel> reservations}) {
    final plan = _planMode ?? MediaQuery.sizeOf(context).width >= 600;
    final zones = hallZones(all);
    final hasNoZone = zones.isNotEmpty && all.any((t) => t.zone.isEmpty);
    final zoneKeys = [...zones, if (hasNoZone) ''];
    // Выбранная зона пропала (переименовали) — показываем все.
    var zone = _zone != null && zoneKeys.contains(_zone) ? _zone : null;
    // На схеме у каждой зоны своя раскладка — «все сразу» наложились бы.
    if (plan && zone == null && zoneKeys.isNotEmpty) zone = zoneKeys.first;
    final inZone = zone == null ? all : all.where((t) => t.zone == zone).toList();

    TableState stateOf(TableModel t) => tableStateOf(t, now: _now, reservation: reservations[t.id]);
    final states = {for (final t in inZone) t.id: stateOf(t)};
    int count(bool Function(TableState) f) => states.values.where(f).length;

    final chips = <Widget>[
      _filterChip(_HallFilter.all, 'Все', inZone.length, AppColors.textMuted),
      _filterChip(_HallFilter.free, 'Свободны', count((s) => s == TableState.free || s == TableState.reserved),
          TableStateColors.free),
      _filterChip(_HallFilter.busy, 'Заняты', count((s) => s.isBusy), TableStateColors.occupied),
      if (count((s) => s == TableState.ending || s == TableState.overdue) > 0 || _filter == _HallFilter.ending)
        _filterChip(_HallFilter.ending, 'Скоро освободятся',
            count((s) => s == TableState.ending || s == TableState.overdue), TableStateColors.ending),
      if (count((s) => s == TableState.reserved) > 0 || _filter == _HallFilter.reserved)
        _filterChip(_HallFilter.reserved, 'Бронь', count((s) => s == TableState.reserved), TableStateColors.reserved),
    ];

    final free = count((s) => s == TableState.free || s == TableState.reserved);

    return Column(
      children: [
        if (zoneKeys.isNotEmpty)
          SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              children: [
                if (!plan) _zoneChip(null, 'Все зоны', zone),
                for (final z in zoneKeys) _zoneChip(z, z.isEmpty ? kNoZoneLabel : z, zone),
              ],
            ),
          ),
        SizedBox(
          height: 52,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            children: chips,
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              free == 0 ? 'Свободных столов нет' : 'Свободно $free из ${inZone.length}',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5),
            ),
          ),
        ),
        Expanded(child: plan ? _plan(inZone, states, callTables, reservations) : _grid(inZone, states, callTables, reservations, showZone: zone == null && zones.isNotEmpty)),
      ],
    );
  }

  /// Плитка стола на схеме.
  Widget _tile(TableModel t, Map<String, TableState> states, Set<String> calls,
          Map<String, ReservationModel> reservations) =>
      _SessionBuilder(
        table: t,
        builder: (s) => TableTile(
          table: t,
          plannedEnd: s?.plannedEnd,
          startTime: s?.startTime,
          guestTag: s?.guestTag,
          billTotal: s?.totalWithDiscount,
          checkCount: t.activeSessionIds.length,
          reservation: reservations[t.id],
          hasCall: calls.contains(t.id),
          dimmed: !_matches(states[t.id]!),
          onTap: () => _openTable(t),
        ),
      );

  /// Карточка стола в списке (как в виде «Список»).
  Widget _card(TableModel t, Set<String> calls, Map<String, ReservationModel> reservations) => _SessionBuilder(
        key: ValueKey(t.id),
        table: t,
        builder: (s) => TableCard(
          table: t,
          plannedEnd: s?.plannedEnd,
          startTime: s?.startTime,
          guestTag: s?.guestTag,
          billTotal: s?.totalWithDiscount,
          checkCount: t.activeSessionIds.length,
          reservation: reservations[t.id],
          hasCall: calls.contains(t.id),
          onTap: () => _openTable(t),
        ),
      );

  /// Сетка карточек столов: высота карточки растёт вместе с системным
  /// шрифтом (три строки текста), иначе при «крупном шрифте» низ обрезался.
  SliverGridDelegate _cardGridOf(BuildContext context) => SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 240,
        mainAxisExtent: context.scaledExtent(116, textPart: 56),
        crossAxisSpacing: 10,
        mainAxisSpacing: 10,
      );

  /// Схема в рамке: скруглённая «площадка» зала.
  Widget _mapFrame(Widget map) => DecoratedBox(
        decoration: BoxDecoration(
          color: AppColors.surface.withValues(alpha: 0.55),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: AppColors.border),
        ),
        child: ClipRRect(borderRadius: BorderRadius.circular(21), child: map),
      );

  /// Вид «Схема»: часть зала со столами, её можно двигать и приближать. На
  /// телефоне схема берёт высоту по столам, ниже — «Сейчас в зале»: занятые
  /// столы по срочности, с таймером и суммой.
  Widget _plan(List<TableModel> tables, Map<String, TableState> states, Set<String> calls,
      Map<String, ReservationModel> reservations) {
    final map = HallPlanView(
      tables: tables,
      fitToTables: true,
      showHint: false,
      tileBuilder: (t) => _tile(t, states, calls, reservations),
    );
    return LayoutBuilder(builder: (context, box) {
      if (box.maxWidth >= 600) {
        return Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 12), child: _mapFrame(map));
      }
      final all = _filter == _HallFilter.all;
      bool busyOrCall(TableModel t) => states[t.id]!.isBusy || calls.contains(t.id);
      // «Все»: сначала те, кто в зале (по срочности), ниже — свободные (с
      // бронью выше), чтобы и посадить гостей можно было прямо из списка.
      // Другой фильтр — один раздел с его столами.
      final sections = <(String, List<TableModel>)>[
        if (all) ...[
          ('Сейчас в зале', tablesByUrgency(tables.where(busyOrCall).toList(), states, calls: calls, reservations: reservations)),
          ('Свободны', tablesByUrgency(tables.where((t) => !busyOrCall(t)).toList(), states, reservations: reservations)),
        ] else
          (_filterTitle(_filter), tablesByUrgency(tables.where((t) => _matches(states[t.id]!)).toList(), states,
              calls: calls, reservations: reservations)),
      ];
      // Пустой раздел оставляем только первым — с подсказкой, что делать.
      sections.removeWhere((e) => e.$2.isEmpty && !identical(e, sections.first));
      final listedCount = sections.fold<int>(0, (n, e) => n + e.$2.length);
      // Высота схемы — по столам: вписываем их область в ширину экрана.
      const side = 12.0;
      final content = hallContentRect(tables);
      final scale = HallPlanView.fitScale(content, Size(box.maxWidth - side * 2, double.infinity));
      final want = content.height * scale + 24 + 4;
      final cap = box.maxHeight * (listedCount == 0 ? 0.75 : 0.56);
      final mapHeight = want.clamp(200.0, math.max(200.0, cap)).toDouble();

      Widget header(String title, int n, {bool hint = false}) => Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 8),
            child: Row(children: [
              Text(n == 0 ? title : '$title · $n', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15.5)),
              const Spacer(),
              if (hint) ...[
                const Icon(Icons.pinch_outlined, size: 15, color: AppColors.textMuted),
                const SizedBox(width: 4),
                const Text('схему можно двигать', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ]),
          );

      return Column(
        children: [
          SizedBox(
            height: mapHeight,
            child: Padding(padding: const EdgeInsets.fromLTRB(side, 4, side, 0), child: _mapFrame(map)),
          ),
          Expanded(
            child: CustomScrollView(
              slivers: [
                for (var i = 0; i < sections.length; i++) ...[
                  SliverPadding(
                    padding: const EdgeInsets.symmetric(horizontal: side),
                    sliver: SliverToBoxAdapter(child: header(sections[i].$1, sections[i].$2.length, hint: i == 0)),
                  ),
                  if (sections[i].$2.isEmpty)
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                      sliver: SliverToBoxAdapter(
                        child: Text(
                            all
                                ? 'Гостей пока нет — нажмите на свободный стол, чтобы посадить гостей.'
                                : 'Таких столов сейчас нет.',
                            style: const TextStyle(color: AppColors.textMuted)),
                      ),
                    )
                  else
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(side, 0, side, 8),
                      sliver: SliverGrid(
                        gridDelegate: _cardGridOf(context),
                        delegate: SliverChildBuilderDelegate(
                          (context, j) => _card(sections[i].$2[j], calls, reservations),
                          childCount: sections[i].$2.length,
                        ),
                      ),
                    ),
                ],
                const SliverToBoxAdapter(child: SizedBox(height: 16)),
              ],
            ),
          ),
        ],
      );
    });
  }

  static String _filterTitle(_HallFilter f) {
    switch (f) {
      case _HallFilter.all:
        return 'Сейчас в зале';
      case _HallFilter.free:
        return 'Свободны';
      case _HallFilter.busy:
        return 'Заняты';
      case _HallFilter.ending:
        return 'Скоро освободятся';
      case _HallFilter.reserved:
        return 'Бронь';
    }
  }

  Widget _grid(List<TableModel> tables, Map<String, TableState> states, Set<String> calls,
      Map<String, ReservationModel> reservations,
      {required bool showZone}) {
    final shown = tables.where((t) => _matches(states[t.id]!)).toList()
      ..sort((a, b) {
        // Сначала столы, где гость зовёт, дальше — по номеру.
        final c = (calls.contains(b.id) ? 1 : 0) - (calls.contains(a.id) ? 1 : 0);
        return c != 0 ? c : compareTables(a, b);
      });
    if (shown.isEmpty) {
      return _message(Icons.filter_alt_off_outlined, 'Таких столов сейчас нет', 'Выберите другой фильтр сверху.');
    }
    Widget card(TableModel t) => _card(t, calls, reservations);
    final grid = _cardGridOf(context);
    // «Все зоны» — столы по зонам с заголовками, а не подписью на каждой
    // карточке (на телефоне она всё равно обрезалась).
    final sections = <String, List<TableModel>>{};
    if (showZone) {
      final order = hallZones(tables);
      for (final z in [...order, '']) {
        final list = shown.where((t) => t.zone == z).toList();
        if (list.isNotEmpty) sections[z] = list;
      }
    } else {
      sections[''] = shown;
    }
    return CustomScrollView(
      slivers: [
        for (final e in sections.entries) ...[
          if (showZone)
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              sliver: SliverToBoxAdapter(
                child: Text(
                  '${e.key.isEmpty ? kNoZoneLabel : e.key} · ${e.value.length}',
                  style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.textMuted, letterSpacing: 0.2),
                ),
              ),
            ),
          SliverPadding(
            padding: EdgeInsets.fromLTRB(12, showZone ? 0 : 6, 12, 8),
            sliver: SliverGrid(
              gridDelegate: grid,
              delegate: SliverChildBuilderDelegate((context, i) => card(e.value[i]), childCount: e.value.length),
            ),
          ),
        ],
        const SliverToBoxAdapter(child: SizedBox(height: 16)),
      ],
    );
  }

  Widget _filterChip(_HallFilter f, String label, int n, Color color) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          showCheckmark: false,
          avatar: f == _HallFilter.all
              ? null
              : Container(width: 9, height: 9, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          label: Text('$label  $n'),
          selected: _filter == f,
          onSelected: (_) => setState(() => _filter = _filter == f ? _HallFilter.all : f),
        ),
      );

  Widget _zoneChip(String? z, String label, String? selected) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          label: Text(label),
          selected: selected == z,
          onSelected: (_) => setState(() => _zone = z),
        ),
      );

  Widget _message(IconData icon, String title, String text) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(icon, size: 44, color: AppColors.textMuted),
            const SizedBox(height: 12),
            Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(text, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
          ]),
        ),
      );
}

/// Подписывается на первый открытый чек стола — для таймера, подписи и
/// суммы на плитке.
///
/// Стрим чека кэшируется и пересоздаётся ТОЛЬКО при смене id чека:
/// StreamBuilder сравнивает стримы по ссылке, и стрим, созданный прямо в
/// build, на каждое изменение любого стола отписывался и подписывался
/// заново — лишний трафик к Firestore и мигание таймеров.
class _SessionBuilder extends StatefulWidget {
  final TableModel table;
  final Widget Function(SessionModel? session) builder;
  const _SessionBuilder({super.key, required this.table, required this.builder});

  @override
  State<_SessionBuilder> createState() => _SessionBuilderState();
}

class _SessionBuilderState extends State<_SessionBuilder> {
  static final _fs = FirestoreService();
  String? _sessionId;
  Stream<SessionModel?>? _stream;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant _SessionBuilder oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  void _sync() {
    final id = widget.table.activeSessionIds.isEmpty ? null : widget.table.activeSessionIds.first;
    if (id == _sessionId) return;
    _sessionId = id;
    _stream = id == null ? null : _fs.sessionStream(id);
  }

  @override
  Widget build(BuildContext context) {
    final stream = _stream;
    if (stream == null) return widget.builder(null);
    return StreamBuilder<SessionModel?>(
      stream: stream,
      builder: (context, snap) => widget.builder(snap.data),
    );
  }
}
