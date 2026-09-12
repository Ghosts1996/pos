import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_settings.dart';
import '../../services/ai/tooken_client.dart';
import '../../theme/app_colors.dart';

/// Админский экран подключения ИИ через Tooken Club (tooken.club):
/// ключ, модели, выключатели агентов, проверка связи и расход токенов.
///
/// Ключ хранится в Firestore (meta/aiSettings), поэтому вводится один раз
/// на любом устройстве и действует на всех планшетах и в клиентском
/// приложении «Колибри Лаундж».
class AiSettingsScreen extends StatefulWidget {
  const AiSettingsScreen({super.key});

  @override
  State<AiSettingsScreen> createState() => _AiSettingsScreenState();
}

class _AiSettingsScreenState extends State<AiSettingsScreen> {
  final _store = AiSettingsStore.instance;

  late AiSettings _settings;
  final _apiKey = TextEditingController();
  final _baseUrl = TextEditingController();
  final _model = TextEditingController();
  final _analyticsModel = TextEditingController();

  bool _loading = true;
  bool _saving = false;
  bool _obscureKey = true;
  String? _pingResult;
  List<String> _models = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final doc = await FirebaseFirestore.instance.doc('meta/aiSettings').get();
    _settings = AiSettings.fromMap(doc.data());
    _apiKey.text = _settings.apiKey;
    _baseUrl.text = _settings.baseUrl;
    _model.text = _settings.model;
    _analyticsModel.text = _settings.analyticsModel;
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    _settings = _settings.copyWith(
      apiKey: _apiKey.text.trim(),
      baseUrl: _baseUrl.text.trim(),
      model: _model.text.trim(),
      analyticsModel: _analyticsModel.text.trim(),
    );
    await _store.save(_settings);
    if (mounted) {
      setState(() => _saving = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Настройки ИИ сохранены')));
    }
  }

  Future<void> _ping() async {
    setState(() => _pingResult = null);
    await _save();
    try {
      final res = await TookenClient.instance.ping();
      setState(() => _pingResult = 'Связь есть. Ответ модели: «$res»');
    } catch (e) {
      setState(() => _pingResult = 'Ошибка: $e');
    }
  }

  Future<void> _loadModels() async {
    await _save();
    try {
      final list = await TookenClient.instance.listModels();
      setState(() => _models = list);
      if (list.isEmpty && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Список моделей недоступен — введите имя модели вручную')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Настройки ИИ')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SwitchListTile(
            value: _settings.enabled,
            onChanged: (v) => setState(() => _settings = _settings.copyWith(enabled: v)),
            title: const Text('Включить ИИ-агентов'),
            subtitle: const Text('Выключено — приложение работает без единого запроса к ИИ'),
          ),
          const Divider(),
          _section('Подключение'),
          TextField(
            controller: _apiKey,
            obscureText: _obscureKey,
            decoration: InputDecoration(
              labelText: 'API-ключ',
              helperText: 'Ключ из кабинета шлюза: tooken.club, ai.d1n0tf.ru и т.п.',
              suffixIcon: IconButton(
                icon: Icon(_obscureKey ? Icons.visibility : Icons.visibility_off),
                onPressed: () => setState(() => _obscureKey = !_obscureKey),
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _baseUrl,
            decoration: const InputDecoration(
              labelText: 'Base URL',
              helperText: 'Адрес шлюза из личного кабинета (без /chat/completions)',
            ),
          ),
          const SizedBox(height: 10),
          // Готовые шлюзы: подставляют адрес и формат одним нажатием,
          // чтобы не искать их в кабинете при переустановке.
          Wrap(
            spacing: 8,
            children: [
              ActionChip(
                label: const Text('tooken.club'),
                onPressed: () => setState(() {
                  _baseUrl.text = 'https://tooken.club/v1';
                  _settings = _settings.copyWith(provider: 'openai');
                }),
              ),
              ActionChip(
                label: const Text('ai.d1n0tf.ru (Claude)'),
                onPressed: () => setState(() {
                  _baseUrl.text = 'https://ai.d1n0tf.ru';
                  _settings = _settings.copyWith(provider: 'anthropic');
                  if (_model.text.isEmpty || _model.text.startsWith('gpt')) {
                    _model.text = 'claude-sonnet-4-5';
                    _analyticsModel.text = 'claude-sonnet-4-5';
                  }
                }),
              ),
            ],
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: ['auto', 'openai', 'anthropic'].contains(_settings.provider)
                ? _settings.provider
                : 'auto',
            decoration: const InputDecoration(
              labelText: 'Формат API',
              helperText: 'Не знаете — оставьте «Определить автоматически»',
            ),
            items: const [
              DropdownMenuItem(value: 'auto', child: Text('Определить автоматически')),
              DropdownMenuItem(value: 'openai', child: Text('OpenAI-совместимый')),
              DropdownMenuItem(value: 'anthropic', child: Text('Anthropic (Claude)')),
            ],
            onChanged: (v) =>
                setState(() => _settings = _settings.copyWith(provider: v ?? 'auto')),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _model,
                  decoration: const InputDecoration(
                    labelText: 'Основная модель',
                    helperText: 'Быстрые агенты: подсказки, чат',
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: _analyticsModel,
                  decoration: const InputDecoration(
                    labelText: 'Модель для аналитики',
                    helperText: 'Отчёты, закупки, отзывы',
                  ),
                ),
              ),
            ],
          ),
          if (_models.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _models
                  .map((m) => ActionChip(
                        label: Text(m, style: const TextStyle(fontSize: 12)),
                        onPressed: () => setState(() => _model.text = m),
                      ))
                  .toList(),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            children: [
              OutlinedButton.icon(
                onPressed: _saving ? null : _ping,
                icon: const Icon(Icons.wifi_tethering),
                label: const Text('Проверить связь'),
              ),
              OutlinedButton.icon(
                onPressed: _saving ? null : _loadModels,
                icon: const Icon(Icons.list),
                label: const Text('Загрузить модели'),
              ),
            ],
          ),
          if (_pingResult != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _pingResult!,
                style: TextStyle(
                  color: _pingResult!.startsWith('Ошибка') ? AppColors.danger : AppColors.success,
                ),
              ),
            ),
          const Divider(height: 32),
          _section('Параметры генерации'),
          _slider(
            'Температура (креативность)',
            _settings.temperature,
            0,
            1,
            (v) => setState(() => _settings = _settings.copyWith(temperature: v)),
          ),
          _slider(
            'Лимит ответа (токенов)',
            _settings.maxTokens.toDouble(),
            200,
            2000,
            (v) => setState(() => _settings = _settings.copyWith(maxTokens: v.round())),
            divisions: 18,
            labelFormat: (v) => v.round().toString(),
          ),
          const Divider(height: 32),
          _section('Агенты'),
          ...AiAgents.all.map(
            (a) => SwitchListTile(
              value: _settings.agents[a.id] ?? true,
              onChanged: (v) {
                final map = Map<String, bool>.from(_settings.agents)..[a.id] = v;
                setState(() => _settings = _settings.copyWith(agents: map));
              },
              title: Text(a.title),
              subtitle: Text(a.description, style: const TextStyle(fontSize: 12)),
              secondary: Icon(a.heavy ? Icons.query_stats : Icons.bolt,
                  color: a.heavy ? AppColors.warning : AppColors.primary),
            ),
          ),
          const Divider(height: 32),
          _section('Расход токенов'),
          _usage(),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Сохранить'),
          ),
          const SizedBox(height: 32),
        ],
      ),
    );
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.only(bottom: 12, top: 4),
        child: Text(title,
            style: const TextStyle(
                color: AppColors.textPrimary, fontSize: 16, fontWeight: FontWeight.w600)),
      );

  Widget _slider(
    String label,
    double value,
    double min,
    double max,
    ValueChanged<double> onChanged, {
    int divisions = 10,
    String Function(double)? labelFormat,
  }) =>
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$label: ${labelFormat?.call(value) ?? value.toStringAsFixed(2)}',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
          Slider(
            value: value.clamp(min, max),
            min: min,
            max: max,
            divisions: divisions,
            onChanged: onChanged,
          ),
        ],
      );

  /// Сколько токенов израсходовано за последние 30 дней и на каких агентов.
  Widget _usage() {
    final from = DateTime.now().subtract(const Duration(days: 30));
    return StreamBuilder<QuerySnapshot>(
      stream: FirebaseFirestore.instance
          .collection('aiLogs')
          .where('createdAt', isGreaterThan: Timestamp.fromDate(from))
          .snapshots(),
      builder: (context, snap) {
        if (!snap.hasData) return const LinearProgressIndicator();
        final byAgent = <String, int>{};
        var total = 0;
        for (final d in snap.data!.docs) {
          final data = d.data() as Map<String, dynamic>;
          final t = (data['totalTokens'] as num?)?.toInt() ?? 0;
          final id = data['agentId']?.toString() ?? 'generic';
          byAgent[id] = (byAgent[id] ?? 0) + t;
          total += t;
        }
        if (total == 0) {
          return const Text('За 30 дней запросов не было.',
              style: TextStyle(color: AppColors.textMuted));
        }
        final sorted = byAgent.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Всего за 30 дней: $total токенов',
                style: const TextStyle(color: AppColors.textPrimary)),
            const SizedBox(height: 8),
            ...sorted.map((e) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(AiAgents.byId(e.key).title,
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
                      Text('${e.value}',
                          style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
                    ],
                  ),
                )),
          ],
        );
      },
    );
  }
}
