import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// Название устройства с кассой — по нему владелец в кабинете
/// («Устройства») и на экране лимита понимает, какой планшет какой и что
/// можно удалить. Поле и быстрые варианты: нажали «Экран кухни» —
/// подставилось, можно дописать («Экран кухни 2»).
class DeviceNameField extends StatelessWidget {
  const DeviceNameField({super.key, required this.controller, this.errorText, this.onSubmitted, this.autofocus = false});

  final TextEditingController controller;
  final String? errorText;
  final ValueChanged<String>? onSubmitted;
  final bool autofocus;

  /// Как называют в кабинете — столько же символов.
  static const maxLength = 40;

  static const suggestions = [
    'Касса',
    'Планшет у бара',
    'Экран кухни',
    'Телефон официанта',
    'Компьютер на кассе',
    'Планшет администратора',
  ];

  /// Пусто — подсказка, что написать; иначе null.
  static String? validate(String name) =>
      name.trim().isEmpty ? 'Назовите устройство — так в кабинете будет понятно, какое из них какое' : null;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      TextField(
        controller: controller,
        autofocus: autofocus,
        maxLength: maxLength,
        textCapitalization: TextCapitalization.sentences,
        style: TextStyle(color: AppColors.textPrimary),
        decoration: InputDecoration(
          labelText: 'Название устройства',
          hintText: 'Например, планшет у бара',
          helperText: 'По названию владелец отличит устройства в кабинете',
          helperMaxLines: 2,
          errorText: errorText,
          errorMaxLines: 3,
          counterText: '',
        ),
        onSubmitted: onSubmitted,
      ),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final s in suggestions)
          ActionChip(
            label: Text(s),
            onPressed: () {
              controller.text = s;
              controller.selection = TextSelection.collapsed(offset: s.length);
            },
          ),
      ]),
    ]);
  }
}

/// Окно «Как назвать это устройство?» — для касс, подключённых раньше без
/// названия. Закрыть без названия нельзя: иначе владелец так и не отличит
/// устройства в кабинете. [save] бросил — окно остаётся и просит повторить.
Future<void> askDeviceName(BuildContext context, Future<void> Function(String name) save) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _DeviceNameDialog(save: save),
  );
}

class _DeviceNameDialog extends StatefulWidget {
  const _DeviceNameDialog({required this.save});
  final Future<void> Function(String name) save;

  @override
  State<_DeviceNameDialog> createState() => _DeviceNameDialogState();
}

class _DeviceNameDialogState extends State<_DeviceNameDialog> {
  final _name = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    final err = DeviceNameField.validate(name);
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.save(name);
      if (mounted) Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Не удалось сохранить — проверьте интернет и попробуйте ещё раз';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: AlertDialog(
        title: const Text('Как назвать это устройство?'),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text(
                'Каждое устройство с кассой считается отдельно. По названию владелец в кабинете поймёт, '
                'какое из них какое и что можно удалить.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 14, height: 1.4),
              ),
              const SizedBox(height: 14),
              DeviceNameField(controller: _name, errorText: _error, autofocus: true, onSubmitted: (_) => _busy ? null : _submit()),
            ]),
          ),
        ),
        actions: [
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Сохранить'),
          ),
        ],
      ),
    );
  }
}
