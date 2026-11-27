import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../../build_info.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_context_service.dart';
import '../../services/ai/ai_settings.dart';
import '../../services/app_scope.dart';
import '../../services/gateway_api.dart';
import '../../theme/app_colors.dart';
import '../../utils/adaptive.dart';
import '../../utils/human_error.dart';
import '../../widgets/ai_assistant_sheet.dart';
import '../../widgets/ai_rich_text.dart';

/// Вид разбора: что считает ИИ, подпись, значок.
class _Kind {
  final String id;
  final String title;
  final String hint;
  final IconData icon;
  final Color Function() color;
  final bool usesPeriod;
  const _Kind(this.id, this.title, this.hint, this.icon, this.color, {this.usesPeriod = false});
}

final _kinds = <_Kind>[
  _Kind('sales', 'Разбор выручки', 'Что выросло и что просело, план на неделю', Icons.trending_up_rounded,
      () => AppColors.primary, usesPeriod: true),
  _Kind('restock', 'Заявка на закупку', 'Что заказать на 7 дней по расходу', Icons.local_shipping_outlined,
      () => AppColors.warning),
  _Kind('reviews', 'Отзывы гостей', 'Что хвалят и что чинить первым', Icons.reviews_outlined, () => AppColors.success),
  _Kind('marketing', 'Идеи акций', 'Акции под тихие часы и залежавшееся', Icons.campaign_outlined,
      () => AppColors.selection),
  _Kind('hostess', 'Брони на смену', 'Кого ждать и как рассадить', Icons.event_seat_outlined, () => AppColors.primary),
];

/// «ИИ-разборы» для администратора. В SaaS разбор считает сервер
/// (saas-gateway/ai-reports.js): касса собирает данные и отдаёт задание —
/// экран можно закрыть, готовый разбор будет ждать здесь. Хранятся в
/// tenants/{t}/aiReports, свежий разбор каждого вида — сверху.
class AiInsightsScreen extends StatefulWidget {
  const AiInsightsScreen({super.key});

  @override
  State<AiInsightsScreen> createState() => _AiInsightsScreenState();
}

class _AiInsightsScreenState extends State<AiInsightsScreen> {
  final _ai = AiService.instance;
  String _selected = 'sales';
  String? _preparing; // вид, для которого касса сейчас собирает данные
  String? _error;
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? _sub;
  List<Map<String, dynamic>> _reports = const [];
  bool _loaded = false;

  // Без SaaS (или без сервера) — как раньше, прямо с кассы.
  String _localText = '';
  bool _localBusy = false;

  DateTimeRange _range = DateTimeRange(
    start: DateTime.now().subtract(const Duration(days: 7)),
    end: DateTime.now(),
  );

  bool get _server => kSaasMode && kSaasGatewayUrl.isNotEmpty;

  @override
  void initState() {
    super.initState();
    if (_server) {
      _sub = AppScope.col('aiReports').orderBy('createdAt', descending: true).limit(40).snapshots().listen((s) {
        if (!mounted) return;
        setState(() {
          _loaded = true;
          _reports = [for (final d in s.docs) {...d.data(), 'id': d.id}];
          if (!_reports.any((r) => r['kind'] == _selected) && _reports.isNotEmpty && _preparing == null) {
            _selected = '${_reports.first['kind']}';
          }
        });
      }, onError: (_) {
        if (mounted) setState(() => _loaded = true);
      });
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Map<String, dynamic>? _latest(String kind) {
    for (final r in _reports) {
      if (r['kind'] == kind) return r;
    }
    return null;
  }

  Future<void> _create(_Kind kind) async {
    setState(() {
      _selected = kind.id;
      _preparing = kind.id;
      _error = null;
    });
    try {
      // Сбор данных за период — не дольше минуты (без связи база отвечала
      // долго, и плитка «готовится» крутилась вечно).
      final p = await _ai.reportPrompt(kind.id, from: _range.start, to: _range.end).timeout(
          const Duration(seconds: 60),
          onTimeout: () => throw StateError('Данные за период собираются слишком долго — проверьте связь и попробуйте ещё раз'));
      if (!p.agentEnabled) throw StateError('Агент «${p.agentTitle}» выключен в «Настройках ИИ»');
      if (_server) {
        await GatewayApi.post('aiReport', {
          'action': 'start',
          'kind': kind.id,
          'title': kind.title,
          if (kind.usesPeriod) 'period': {'from': _range.start.toIso8601String(), 'to': _range.end.toIso8601String()},
          'system': p.system,
          'user': p.user,
          'heavy': p.heavy,
          'aliases': p.aliases,
        });
      } else {
        setState(() => _localBusy = true);
        final text = await _runLocal(kind.id);
        if (mounted) setState(() => _localText = text);
      }
    } catch (e) {
      if (mounted) setState(() => _error = e is StateError ? e.message : humanError(e));
    } finally {
      if (mounted) setState(() => _preparing = null);
      if (mounted) setState(() => _localBusy = false);
    }
  }

  Future<String> _runLocal(String kind) => switch (kind) {
        'sales' => _ai.analyzeSales(from: _range.start, to: _range.end),
        'restock' => _ai.restockPlan(),
        'reviews' => _ai.reviewDigest(),
        'marketing' => _ai.marketingIdeas(),
        _ => _ai.hostessBriefing(),
      };

  Future<void> _pickRange() async {
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2023),
      lastDate: DateTime.now().add(const Duration(days: 1)),
      initialDateRange: _range,
    );
    if (picked != null) setState(() => _range = picked);
  }

  @override
  Widget build(BuildContext context) {
    final ready = AiSettingsStore.instance.current.isReady;
    return Scaffold(
      appBar: AppBar(
        title: const Text('ИИ-разборы'),
        actions: [
          IconButton(
            tooltip: 'Спросить аналитика',
            icon: const Icon(Icons.chat_bubble_outline),
            onPressed: () => AiAssistantSheet.show(
              context,
              agent: AiAgents.analyst,
              asyncContextBuilder: AiService.instance.analystContext,
              quickPrompts: const ['Почему упал средний чек?', 'Какие позиции убрать из меню?', 'Когда ставить вторую смену?'],
            ),
          ),
        ],
      ),
      body: CenteredBody(
        maxWidth: 760,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
          children: [
            if (!ready)
              Container(
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.warning.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text('ИИ не подключён — откройте «Настройки ИИ» и вставьте ключ.',
                    style: TextStyle(color: AppColors.warning)),
              ),
            Text(
              _server
                  ? 'Нажмите на разбор — он готовится на сервере. Экран можно закрыть: готовый разбор будет ждать здесь.'
                  : 'Нажмите на разбор — ИИ посчитает его по данным заведения.',
              style: TextStyle(color: AppColors.textMuted, height: 1.35),
            ),
            const SizedBox(height: 14),
            for (final k in _kinds) _kindTile(k),
            const SizedBox(height: 8),
            _resultCard(),
          ],
        ),
      ),
    );
  }

  Widget _kindTile(_Kind k) {
    final r = _server ? _latest(k.id) : null;
    final status = '${r?['status'] ?? ''}';
    final selected = _selected == k.id;
    final busy = _preparing == k.id || status == 'running';
    String sub;
    if (busy) {
      sub = 'Готовится…';
    } else if (status == 'done') {
      sub = 'Готов · ${_when(r!['doneAt'] ?? r['createdAt'])}';
    } else if (status == 'failed') {
      sub = 'Не удался — нажмите, чтобы повторить';
    } else {
      sub = k.hint;
    }
    final color = k.color();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: selected ? color.withValues(alpha: 0.10) : AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () {
            if (_server && r != null && status != 'failed') {
              setState(() => _selected = k.id);
            } else if (!busy) {
              _create(k);
            }
          },
          child: Container(
            padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: selected ? color.withValues(alpha: 0.55) : AppColors.border),
            ),
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(12)),
                  child: Icon(k.icon, color: color, size: 22),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(k.title, style: TextStyle(fontWeight: FontWeight.w700, color: AppColors.textPrimary)),
                      const SizedBox(height: 2),
                      Text(sub,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 12.5,
                              color: status == 'failed' ? AppColors.danger : AppColors.textMuted)),
                    ],
                  ),
                ),
                if (busy)
                  const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                else
                  Icon(status == 'done' ? Icons.check_circle_rounded : Icons.chevron_right_rounded,
                      color: status == 'done' ? AppColors.success : AppColors.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _resultCard() {
    final kind = _kinds.firstWhere((k) => k.id == _selected, orElse: () => _kinds.first);
    if (_error != null) {
      return _panel(kind, Text(_error!, style: TextStyle(color: AppColors.danger)), action: 'Попробовать снова');
    }
    if (!_server) {
      if (_localBusy) return _panel(kind, _waiting('Считаю и анализирую…'));
      if (_localText.isEmpty) return const SizedBox.shrink();
      return _panel(kind, AiRichText(_localText, style: TextStyle(color: AppColors.textPrimary, height: 1.45)),
          action: 'Обновить разбор');
    }
    if (!_loaded) return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
    final r = _latest(kind.id);
    if (_preparing == kind.id) return _panel(kind, _waiting('Собираю данные заведения…'));
    if (r == null) return const SizedBox.shrink();
    final status = '${r['status']}';
    if (status == 'running') {
      return _panel(kind, _waiting('Готовлю разбор. Можно закрыть экран — он сохранится и будет ждать здесь.'));
    }
    if (status == 'failed') {
      return _panel(kind, Text('${r['error'] ?? 'Разбор не удался'}', style: TextStyle(color: AppColors.danger)),
          action: 'Создать заново');
    }
    final aliases = (r['aliases'] is Map) ? Map<String, String>.from((r['aliases'] as Map).map((k, v) => MapEntry('$k', '$v'))) : <String, String>{};
    final text = AiPseudonyms.restoreWith('${r['text'] ?? ''}', aliases);
    final period = r['period'] is Map ? r['period'] as Map : null;
    return _panel(
      kind,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            [
              if (period != null) 'Период ${_day(period['from'])} — ${_day(period['to'])}',
              'готов ${_when(r['doneAt'] ?? r['createdAt'])}',
            ].join(' · '),
            style: TextStyle(color: AppColors.textMuted, fontSize: 12.5),
          ),
          const SizedBox(height: 12),
          AiRichText(text, style: TextStyle(color: AppColors.textPrimary, height: 1.45)),
        ],
      ),
      action: 'Обновить разбор',
    );
  }

  Widget _waiting(String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 18),
        child: Row(
          children: [
            const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4)),
            const SizedBox(width: 14),
            Expanded(child: Text(text, style: TextStyle(color: AppColors.textMuted, height: 1.35))),
          ],
        ),
      );

  Widget _panel(_Kind kind, Widget child, {String? action}) => Container(
        margin: const EdgeInsets.only(top: 6),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(kind.title,
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: AppColors.textPrimary)),
                ),
                if (kind.usesPeriod)
                  TextButton.icon(
                    onPressed: _pickRange,
                    icon: const Icon(Icons.date_range, size: 18),
                    label: Text('${_fmt(_range.start)} — ${_fmt(_range.end)}'),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            child,
            if (action != null) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _preparing != null ? null : () => _create(kind),
                icon: const Icon(Icons.refresh_rounded, size: 18),
                label: Text(action),
              ),
            ],
          ],
        ),
      );

  static String _fmt(DateTime d) => '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';

  static String _day(Object? iso) {
    final d = DateTime.tryParse('${iso ?? ''}');
    return d == null ? '' : _fmt(d);
  }

  static String _when(Object? v) {
    final d = v is Timestamp ? v.toDate() : (v is DateTime ? v : null);
    if (d == null) return '';
    final now = DateTime.now();
    final hm = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    if (d.year == now.year && d.month == now.month && d.day == now.day) return 'сегодня в $hm';
    return '${_fmt(d)} в $hm';
  }
}
