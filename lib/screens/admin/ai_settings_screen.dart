import 'package:cloud_firestore/cloud_firestore.dart';
import '../../services/app_scope.dart';
import 'package:flutter/material.dart';
import '../../services/ai/ai_agents.dart';
import '../../services/ai/ai_settings.dart';
import '../../services/ai/tooken_client.dart';
import '../../theme/app_colors.dart';

/// Админский экран подключения ИИ: провайдер (Tooken Club, DarkAPI,
/// Google Gemini или свой шлюз), ключи, модели, резервный провайдер,
/// выключатели агентов, проверка связи и расход токенов.
///
/// Ключи хранятся в Firestore (в SaaS — в meta/aiSecrets, доступном только
/// персоналу), поэтому вводятся один раз на любом устройстве и действуют
/// на всех планшетах; гостевое приложение ходит к ИИ через сервер
/// платформы и ключей не видит.
class AiSettingsScreen extends StatefulWidget {
  const AiSettingsScreen({super.key});

  @override
  State<AiSettingsScreen> createState() => _AiSettingsScreenState();
}

class _AiSettingsScreenState extends State<AiSettingsScreen> {
  final _store = AiSettingsStore.instance;

  late AiSettings _settings;

  /// Провайдер, чьё подключение сейчас открыто в полях ниже (не обязательно
  /// основной — можно заранее ввести ключ резервного).
  String _editing = AiVendors.tooken.id;
  final _apiKey = TextEditingController();
  final _baseUrl = TextEditingController();
  final _model = TextEditingController();
  final _analyticsModel = TextEditingController();

  bool _loading = true;
  bool _saving = false;
  bool _obscureKey = true;
  String? _pingResult;
  bool _pingOk = false;
  List<String> _models = const [];

  AiVendor get _vendor => AiVendors.byId(_editing);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    _settings = await _store.load();
    _editing = _settings.vendor;
    _fillFields();
    if (mounted) setState(() => _loading = false);
  }

  /// Поля — из сохранённого подключения открытого провайдера.
  void _fillFields() {
    final c = _settings.configFor(_editing);
    _apiKey.text = c.apiKey;
    _baseUrl.text = c.baseUrl.isNotEmpty ? c.baseUrl : _vendor.baseUrl;
    _model.text = c.model.isNotEmpty ? c.model : _vendor.defaultModel;
    _analyticsModel.text = c.analyticsModel.isNotEmpty ? c.analyticsModel : _vendor.defaultAnalyticsModel;
    _models = const [];
    _pingResult = null;
  }

  /// Поля открытого провайдера — обратно в настройки (перед сохранением,
  /// проверкой связи и переключением на другого провайдера).
  void _commitFields() {
    final c = _settings.configFor(_editing);
    final base = _baseUrl.text.trim();
    _settings = _settings.withVendorConfig(
      _editing,
      c.copyWith(
        apiKey: _apiKey.text.trim(),
        // Адрес по умолчанию не записываем: если провайдер его сменит,
        // обновление приложения подхватит новый сам.
        baseUrl: base == _vendor.baseUrl ? '' : base,
        model: _model.text.trim(),
        analyticsModel: _analyticsModel.text.trim(),
      ),
    );
  }

  void _switchEditing(String vendorId) {
    _commitFields();
    setState(() {
      _editing = vendorId;
      _fillFields();
    });
  }

  Future<void> _save({bool silent = false}) async {
    _commitFields();
    if (_settings.fallbackVendor == _settings.vendor) {
      _settings = _settings.copyWith(fallbackVendor: '');
    }
    setState(() => _saving = true);
    try {
      await _store.save(_settings);
      if (mounted && !silent) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Настройки ИИ сохранены')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Не удалось сохранить: $e')));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _ping() async {
    _commitFields();
    setState(() {
      _pingResult = 'Проверяю…';
      _pingOk = false;
    });
    try {
      final res = await TookenClient.instance.ping(endpoint: _settings.endpointFor(_editing));
      setState(() {
        _pingOk = true;
        _pingResult = '${_vendor.title}: связь есть. Ответ модели: «$res»';
      });
    } catch (e) {
      setState(() {
        _pingOk = false;
        _pingResult = 'Ошибка: $e';
      });
    }
  }

  Future<void> _loadModels() async {
    _commitFields();
    try {
      final list = await TookenClient.instance.listModels(endpoint: _settings.endpointFor(_editing));
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

  bool _hasKey(String vendorId) =>
      vendorId == _editing ? _apiKey.text.trim().isNotEmpty : _settings.configFor(vendorId).apiKey.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final vendor = _vendor;
    final suggested = {...vendor.suggestedModels, ..._models}.toList();

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
          _section('Провайдер'),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: AiVendors.all.map((v) {
              final selected = v.id == _editing;
              final mark = v.id == _settings.vendor
                  ? ' · основной'
                  : v.id == _settings.fallbackVendor
                      ? ' · резервный'
                      : '';
              return ChoiceChip(
                selected: selected,
                label: Text('${v.title}${_hasKey(v.id) ? ' ✓' : ''}$mark'),
                onSelected: (_) => _switchEditing(v.id),
              );
            }).toList(),
          ),
          const SizedBox(height: 6),
          const Text('✓ — ключ сохранён. Ключ каждого провайдера хранится отдельно.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
          const SizedBox(height: 14),
          TextField(
            controller: _apiKey,
            obscureText: _obscureKey,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(
              labelText: 'API-ключ ${vendor.title}',
              helperText: vendor.keyHint,
              suffixIcon: IconButton(
                icon: Icon(_obscureKey ? Icons.visibility : Icons.visibility_off),
                onPressed: () => setState(() => _obscureKey = !_obscureKey),
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _baseUrl,
            decoration: InputDecoration(
              labelText: 'Адрес API',
              helperText: vendor.id == AiVendors.custom.id
                  ? 'Адрес шлюза из личного кабинета (без /chat/completions)'
                  : 'Менять не нужно, если провайдер не дал другой адрес или вы не ходите через прокси',
            ),
          ),
          if (vendor.id == AiVendors.custom.id) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: ['auto', 'openai', 'anthropic'].contains(_settings.configFor(_editing).format)
                  ? _settings.configFor(_editing).format
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
              onChanged: (v) => setState(() => _settings = _settings.withVendorConfig(
                  _editing, _settings.configFor(_editing).copyWith(format: v ?? 'auto'))),
            ),
          ],
          if (vendor.note.isNotEmpty) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.warning.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.warning.withValues(alpha: 0.4)),
              ),
              child: Text(vendor.note, style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
            ),
          ],
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
          if (suggested.isNotEmpty) ...[
            const SizedBox(height: 12),
            const Text('Нажмите — подставится в «Основная модель», долгое нажатие — в «Модель для аналитики»:',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: suggested
                  .map((m) => GestureDetector(
                        onLongPress: () => setState(() => _analyticsModel.text = m),
                        child: ActionChip(
                          label: Text(m, style: const TextStyle(fontSize: 12)),
                          onPressed: () => setState(() => _model.text = m),
                        ),
                      ))
                  .toList(),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 8,
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
                  color: _pingResult!.startsWith('Ошибка')
                      ? AppColors.danger
                      : _pingOk
                          ? AppColors.success
                          : AppColors.textMuted,
                ),
              ),
            ),
          const Divider(height: 32),
          _section('Какой провайдер использовать'),
          DropdownButtonFormField<String>(
            initialValue: _settings.vendor,
            decoration: const InputDecoration(labelText: 'Основной провайдер'),
            items: AiVendors.all
                .map((v) => DropdownMenuItem(value: v.id, child: Text('${v.title}${_hasKey(v.id) ? '' : ' (нет ключа)'}')))
                .toList(),
            onChanged: (v) => setState(() {
              _settings = _settings.copyWith(
                vendor: v ?? _settings.vendor,
                fallbackVendor: _settings.fallbackVendor == v ? '' : _settings.fallbackVendor,
              );
            }),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _settings.fallbackVendor,
            decoration: const InputDecoration(
              labelText: 'Резервный провайдер',
              helperText: 'Если основной не ответит (нет связи, ключ, баланс, регион) — ИИ переключится сам',
            ),
            items: [
              const DropdownMenuItem(value: '', child: Text('Не использовать')),
              ...AiVendors.all.where((v) => v.id != _settings.vendor).map((v) =>
                  DropdownMenuItem(value: v.id, child: Text('${v.title}${_hasKey(v.id) ? '' : ' (нет ключа)'}'))),
            ],
            onChanged: (v) => setState(() => _settings = _settings.copyWith(fallbackVendor: v ?? '')),
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
            4000,
            (v) => setState(() => _settings = _settings.copyWith(maxTokens: v.round())),
            divisions: 38,
            labelFormat: (v) => v.round().toString(),
          ),
          const Text('«Думающим» моделям (Gemini, DeepSeek-reasoner) нужен запас: они тратят лимит и на размышления.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
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
      stream: AppScope.col('aiLogs')
          .where('createdAt', isGreaterThan: Timestamp.fromDate(from))
          .snapshots(),
      builder: (context, snap) {
        if (!snap.hasData) return const LinearProgressIndicator();
        final byAgent = <String, int>{};
        final byVendor = <String, int>{};
        var total = 0;
        for (final d in snap.data!.docs) {
          final data = d.data() as Map<String, dynamic>;
          final t = (data['totalTokens'] as num?)?.toInt() ?? 0;
          final id = data['agentId']?.toString() ?? 'generic';
          byAgent[id] = (byAgent[id] ?? 0) + t;
          final v = data['vendor']?.toString() ?? '';
          if (v.isNotEmpty) byVendor[v] = (byVendor[v] ?? 0) + t;
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
            if (byVendor.length > 1)
              Text(
                byVendor.entries.map((e) => '${AiVendors.byId(e.key).title}: ${e.value}').join(' · '),
                style: const TextStyle(color: AppColors.textMuted, fontSize: 12),
              ),
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
