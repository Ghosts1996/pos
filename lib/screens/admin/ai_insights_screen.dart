import 'package:flutter/material.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_settings.dart';
import '../../theme/app_colors.dart';
import '../../widgets/ai_assistant_sheet.dart';

/// «ИИ-разборы» для администратора: выручка, закупки, отзывы, маркетинг.
/// Каждая карточка — один готовый сценарий агента в один тап, без промптов.
class AiInsightsScreen extends StatefulWidget {
  const AiInsightsScreen({super.key});

  @override
  State<AiInsightsScreen> createState() => _AiInsightsScreenState();
}

class _AiInsightsScreenState extends State<AiInsightsScreen> {
  final _ai = AiService.instance;

  String? _title;
  String _result = '';
  bool _busy = false;
  String? _error;

  DateTimeRange _range = DateTimeRange(
    start: DateTime.now().subtract(const Duration(days: 7)),
    end: DateTime.now(),
  );

  Future<void> _run(String title, Future<String> Function() task) async {
    setState(() {
      _title = title;
      _busy = true;
      _error = null;
      _result = '';
    });
    try {
      final text = await task();
      if (mounted) setState(() => _result = text);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _pickRange() async {
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2023),
      lastDate: DateTime.now().add(const Duration(days: 1)),
      initialDateRange: _range,
      builder: (context, child) => Theme(
        data: Theme.of(context),
        child: child!,
      ),
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
            tooltip: 'Свободный диалог с аналитиком',
            icon: const Icon(Icons.chat_bubble_outline),
            onPressed: () => AiAssistantSheet.show(
              context,
              agent: AiAgents.analyst,
              asyncContextBuilder: AiService.instance.analystContext,
              quickPrompts: const [
                'Почему упал средний чек?',
                'Какие позиции убрать из меню?',
                'Когда ставить вторую смену?',
              ],
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          if (!ready)
            Container(
              width: double.infinity,
              color: AppColors.warning.withValues(alpha: 0.15),
              padding: const EdgeInsets.all(12),
              child: const Text('ИИ не подключён — откройте «Настройки ИИ» и введите API-ключ.',
                  style: TextStyle(color: AppColors.warning)),
            ),
          // Ширина задаётся явно: без этого в некоторых сборках текст
          // получал нулевую ширину и рассыпался по букве в строке.
          SizedBox(
            width: double.infinity,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
              child: Row(
                mainAxisSize: MainAxisSize.max,
                children: [
                  Flexible(
                    child: Text(
                      'Период: ${_fmt(_range.start)} — ${_fmt(_range.end)}',
                      softWrap: false,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: AppColors.textMuted),
                    ),
                  ),
                  const SizedBox(width: 8),
                  TextButton.icon(
                    // Без явного minimumSize кнопка требует бесконечную
                    // ширину (в теме Size.fromHeight) и схлопывает текст слева.
                    style: TextButton.styleFrom(minimumSize: const Size(0, 40)),
                    onPressed: _pickRange,
                    icon: const Icon(Icons.date_range, size: 18),
                    label: const Text('Выбрать'),
                  ),
                ],
              ),
            ),
          ),
          SizedBox(
            height: 108,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: [
                _card('Разбор выручки', Icons.trending_up, AppColors.primary, () {
                  _run('Разбор выручки',
                      () => _ai.analyzeSales(from: _range.start, to: _range.end));
                }),
                _card('Заявка на закупку', Icons.local_shipping, AppColors.warning, () {
                  _run('Заявка на закупку', () => _ai.restockPlan());
                }),
                _card('Отзывы гостей', Icons.reviews, AppColors.success, () {
                  _run('Отзывы гостей', () => _ai.reviewDigest());
                }),
                _card('Идеи акций', Icons.campaign, AppColors.selection, () {
                  _run('Идеи акций', () => _ai.marketingIdeas());
                }),
                _card('Брони на смену', Icons.event_seat, AppColors.primary, () {
                  _run('Брони на смену', () => _ai.hostessBriefing());
                }),
              ],
            ),
          ),
          const Divider(height: 24),
          Expanded(child: _resultView()),
        ],
      ),
    );
  }

  Widget _card(String title, IconData icon, Color color, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(right: 12),
        child: InkWell(
          onTap: _busy ? null : onTap,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            width: 150,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(icon, color: color),
                Text(title,
                    style: const TextStyle(
                        color: AppColors.textPrimary, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        ),
      );

  Widget _resultView() {
    if (_busy) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 12),
            Text('Считаю и анализирую…', style: TextStyle(color: AppColors.textMuted)),
          ],
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_error!, style: const TextStyle(color: AppColors.danger)),
        ),
      );
    }
    if (_result.isEmpty) {
      return const Center(
        child: Text('Выберите разбор выше', style: TextStyle(color: AppColors.textMuted)),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(_title ?? '',
            style: const TextStyle(
                color: AppColors.textPrimary, fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(height: 12),
        SelectableText(_result,
            style: const TextStyle(color: AppColors.textPrimary, height: 1.45)),
        const SizedBox(height: 32),
      ],
    );
  }

  String _fmt(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')}.${d.month.toString().padLeft(2, '0')}';
}
