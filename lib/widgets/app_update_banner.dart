import 'package:flutter/material.dart';

import '../services/app_update_service.dart';

/// Плашка «Вышла новая версия» поверх любого экрана приложения — ставится
/// в MaterialApp.builder (касса и приложение гостя).
///
/// Сдвигает экран вниз, а не перекрывает его: кнопки в шапке остаются
/// доступны. Структура дерева одинаковая с плашкой и без неё — иначе при
/// её появлении Flutter пересоздал бы навигатор и сбросил открытые экраны.
class AppUpdateBanner extends StatelessWidget {
  final Widget child;
  const AppUpdateBanner({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final svc = AppUpdateService.instance;
    if (svc == null) return child;
    return ValueListenableBuilder<DateTime?>(
      valueListenable: svc.hiddenUntil,
      builder: (context, _, __) => ValueListenableBuilder<AppUpdateState>(
        valueListenable: svc.state,
        builder: (context, st, _) {
          final visible = svc.visibleFor(st);
          final mq = MediaQuery.of(context);
          return Column(
            children: [
              AnimatedSize(
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeOut,
                alignment: Alignment.topCenter,
                child: visible
                    ? AppUpdateStrip(service: svc, state: st)
                    : const SizedBox(width: double.infinity),
              ),
              Expanded(
                child: MediaQuery(
                  // Верхний отступ (строка состояния) уже занят плашкой.
                  data: visible ? mq.removePadding(removeTop: true).removeViewPadding(removeTop: true) : mq,
                  child: child,
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Сама плашка — отдельно, чтобы её можно было проверить тестом и
/// показать в любом состоянии.
class AppUpdateStrip extends StatelessWidget {
  final AppUpdateService service;
  final AppUpdateState state;
  const AppUpdateStrip({super.key, required this.service, required this.state});

  bool get _windows => service.platform == 'windows';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final accent = state.phase == AppUpdatePhase.failed ? scheme.error : scheme.primary;
    final bg = Color.alphaBlend(accent.withValues(alpha: 0.16), scheme.surface);
    final muted = scheme.onSurface.withValues(alpha: 0.72);
    final info = state.info;
    final size = info == null ? '' : formatUpdateSize(info.sizeBytes);

    String title;
    String subtitle;
    IconData icon;
    final actions = <Widget>[];
    Widget? bar;

    switch (state.phase) {
      case AppUpdatePhase.none:
      case AppUpdatePhase.available:
        icon = Icons.system_update_rounded;
        title = 'Вышла новая версия приложения';
        subtitle = _windows
            ? 'Касса закроется на несколько секунд и откроется уже обновлённой — все данные сохранятся'
            : 'Обновление ставится поверх — все данные и настройки сохранятся';
        if (size.isNotEmpty) subtitle = '$subtitle · $size';
        actions
          ..add(_later())
          ..add(_primary('Обновить', Icons.download_rounded, service.download));
        break;
      case AppUpdatePhase.downloading:
        icon = Icons.downloading_rounded;
        final p = state.progress;
        title = p == null ? 'Загружаем обновление…' : 'Загружаем обновление · ${(p * 100).floor()}%';
        subtitle = state.total > 0
            ? '${formatUpdateSize(state.received)} из ${formatUpdateSize(state.total)} — можно продолжать работу'
            : 'Можно продолжать работу';
        actions.add(_text('Отмена', service.cancel));
        bar = _progress(p, accent, scheme);
        break;
      case AppUpdatePhase.ready:
        icon = Icons.download_done_rounded;
        title = 'Обновление загружено';
        subtitle = state.message ??
            (_windows
                ? 'Нажмите «Установить» — касса перезапустится, данные сохранятся'
                : 'Нажмите «Установить» и подтвердите в окне Android — данные сохранятся');
        actions.add(_primary('Установить', Icons.install_mobile_rounded, service.install));
        break;
      case AppUpdatePhase.installing:
        icon = Icons.published_with_changes_rounded;
        title = 'Устанавливаем обновление';
        subtitle = _windows ? 'Касса закроется и через несколько секунд откроется снова' : 'Сохраняем данные и открываем установку…';
        bar = _progress(null, accent, scheme);
        break;
      case AppUpdatePhase.failed:
        icon = Icons.error_outline_rounded;
        title = 'Не удалось загрузить обновление';
        subtitle = state.message ?? 'Проверьте интернет и попробуйте ещё раз';
        actions
          ..add(_later())
          ..add(_primary('Повторить', Icons.refresh_rounded, service.download));
        break;
    }

    final text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: scheme.onSurface)),
        const SizedBox(height: 2),
        Text(subtitle, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: muted, height: 1.25)),
      ],
    );
    final badge = Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(color: accent.withValues(alpha: 0.22), shape: BoxShape.circle),
      child: Icon(icon, color: accent, size: 22),
    );

    return Material(
      color: bg,
      child: DecoratedBox(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: accent.withValues(alpha: 0.45)))),
        child: SafeArea(
          bottom: false,
          child: Semantics(
            container: true,
            liveRegion: state.phase != AppUpdatePhase.downloading,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
              child: LayoutBuilder(builder: (context, box) {
                // Одна текстовая «Отмена» во время загрузки влезает в строку
                // заголовка и на телефоне — отдельная строка под неё не нужна.
                final wide = box.maxWidth >= 600 || state.phase == AppUpdatePhase.downloading;
                final buttons = Row(mainAxisSize: MainAxisSize.min, children: [
                  for (var i = 0; i < actions.length; i++) ...[
                    if (i > 0) const SizedBox(width: 8),
                    actions[i],
                  ],
                ]);
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        badge,
                        const SizedBox(width: 12),
                        Expanded(child: text),
                        if (wide && actions.isNotEmpty) ...[const SizedBox(width: 12), buttons],
                      ],
                    ),
                    if (bar != null) ...[const SizedBox(height: 10), bar],
                    if (!wide && actions.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Align(alignment: Alignment.centerRight, child: buttons),
                    ],
                  ],
                );
              }),
            ),
          ),
        ),
      ),
    );
  }

  Widget _progress(double? value, Color accent, ColorScheme scheme) => ClipRRect(
        borderRadius: BorderRadius.circular(4),
        child: LinearProgressIndicator(
          value: value,
          minHeight: 6,
          color: accent,
          backgroundColor: scheme.onSurface.withValues(alpha: 0.12),
        ),
      );

  Widget _later() => _text('Позже', service.later);

  Widget _text(String label, VoidCallback onTap) => TextButton(
        onPressed: onTap,
        style: TextButton.styleFrom(minimumSize: const Size(0, 40)),
        child: Text(label),
      );

  Widget _primary(String label, IconData icon, Future<void> Function() onTap) => FilledButton.icon(
        onPressed: () => onTap(),
        style: FilledButton.styleFrom(minimumSize: const Size(0, 40), padding: const EdgeInsets.symmetric(horizontal: 16)),
        icon: Icon(icon, size: 18),
        label: Text(label),
      );
}

