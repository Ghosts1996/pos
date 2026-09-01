import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

/// Два физически разных способа получить штрихкод/код маркировки, но
/// один и тот же результат для остального приложения — строка [onCode].
///
/// 1. HID-сканер (обычный "пистолет"-сканер, USB или Bluetooth в режиме
///    HID) — для операционной системы он не отдельное устройство, а
///    клавиатура: он быстро "печатает" символы кода и в конце шлёт Enter.
///    Отдельного плагина не нужно — ловим это как обычный ввод с
///    клавиатуры через [HidScannerListener] ниже.
/// 2. Камера телефона/планшета — настоящий сканер через пакет
///    `mobile_scanner` (ML Kit на Android, AVFoundation на iOS), открывается
///    модальным окном через [showCameraScanner].
/// Оборачивает поддерево виджетов и слушает быстрый ввод символов,
/// характерный для HID-сканера (посимвольные события клавиатуры, идущие
/// намного быстрее, чем человек может печатать руками, завершающиеся
/// Enter). Обычную ручную печать в текстовые поля не перехватывает и не
/// ломает — разница определяется по скорости между нажатиями.
///
/// Разместить один раз над экраном, где должно работать сканирование
/// (например, над `MenuSelectionScreen`/`PaymentScreen`), и передать
/// [onCode] — колбэк вызовется с полным считанным кодом.
class HidScannerListener extends StatefulWidget {
  final Widget child;
  final ValueChanged<String> onCode;

  /// Если между двумя нажатиями прошло больше этого времени — считаем,
  /// что это не сканер, а человек печатает руками, и сбрасываем буфер.
  /// HID-сканеры обычно укладываются в 5-20 мс между символами, обычная
  /// печать человеком — от ~80 мс и выше, поэтому 60 мс — надёжный порог.
  final Duration keystrokeGap;

  /// Активен ли слушатель — например, можно выключать на экранах, где
  /// сканирование не нужно, чтобы не перехватывать обычный ввод в поля.
  final bool enabled;

  const HidScannerListener({
    super.key,
    required this.child,
    required this.onCode,
    this.keystrokeGap = const Duration(milliseconds: 60),
    this.enabled = true,
  });

  @override
  State<HidScannerListener> createState() => _HidScannerListenerState();
}

class _HidScannerListenerState extends State<HidScannerListener> {
  final _buffer = StringBuffer();
  DateTime? _lastKeyTime;
  final _focusNode = FocusNode(skipTraversal: true, canRequestFocus: true);

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (!widget.enabled) return KeyEventResult.ignored;
    if (event is! KeyDownEvent) return KeyEventResult.ignored;

    final now = DateTime.now();
    final gapTooLong = _lastKeyTime != null && now.difference(_lastKeyTime!) > widget.keystrokeGap;
    if (gapTooLong) _buffer.clear();
    _lastKeyTime = now;

    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter) {
      final code = _buffer.toString();
      _buffer.clear();
      // Сканер печатает быстро, но одиночные нажатия Enter человеком
      // (например, в другом текстовом поле) — не наш случай, там gap
      // между предыдущим символом и Enter будет большим и буфер уже
      // окажется пустым к этому моменту.
      if (code.length >= 4) {
        widget.onCode(code);
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }

    final char = event.character;
    if (char != null && char.isNotEmpty && char.trim().isNotEmpty) {
      _buffer.write(char);
    }
    return KeyEventResult.ignored; // не мешаем обычным полям ввода на экране
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: _focusNode,
      onKeyEvent: _handleKey,
      child: widget.child,
    );
  }
}

/// Открывает модальный экран камеры и возвращает первый считанный код
/// (или null, если пользователь закрыл экран без сканирования).
///
/// Поддерживает практически все форматы, включая DataMatrix (нужен для
/// кодов «Честного знака») и обычные EAN/QR — детектор сам определяет
/// формат.
Future<String?> showCameraScanner(BuildContext context, {String title = 'Сканирование'}) {
  return Navigator.of(context).push<String>(
    MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => _CameraScannerScreen(title: title),
    ),
  );
}

/// То же самое, что [showCameraScanner], но вместо полноэкранного перехода —
/// небольшое окошко поверх текущего экрана (для разовой проверки кода в
/// настройках, где не нужен весь экран под камеру). Закрывается тапом мимо
/// окна или крестиком, как и обычный диалог. Если камера не заводится в
/// маленьком окне на конкретном устройстве, в диалоге есть кнопка
/// "Открыть на весь экран" — тогда прозрачно подхватывается проверенный
/// [showCameraScanner].
Future<String?> showCompactCameraScanner(BuildContext context, {String title = 'Сканирование'}) async {
  final result = await showDialog<String>(
    context: context,
    builder: (_) => _CompactCameraScannerDialog(title: title),
  );
  if (result == _fullscreenFallbackSentinel) {
    if (!context.mounted) return null;
    return showCameraScanner(context, title: title);
  }
  return result;
}

const _fullscreenFallbackSentinel = '__open_fullscreen_scanner__';

class _CompactCameraScannerDialog extends StatefulWidget {
  final String title;
  const _CompactCameraScannerDialog({required this.title});

  @override
  State<_CompactCameraScannerDialog> createState() => _CompactCameraScannerDialogState();
}

class _CompactCameraScannerDialogState extends State<_CompactCameraScannerDialog> {
  // ВАЖНО: autoStart оставляем true (по умолчанию) и НЕ вызываем
  // _controller.start() вручную до того, как виджет MobileScanner
  // реально попал в дерево и его платформенная camera-view успела
  // прикрепиться. Раньше здесь было autoStart: false + ручной
  // await _controller.start() из initState, ПОКА на экране висел
  // спиннер вместо MobileScanner — то есть start() дёргался для
  // контроллера, у которого ещё не было ни одного attached виджета.
  // На части устройств/версий CameraX это валится нативным NPE вида
  // "Attempt to invoke virtual method ... on a null object reference",
  // потому что CameraX пытается забиндить preview к ещё не созданному
  // SurfaceProvider. Правильный порядок: сразу строим MobileScanner
  // (он сам запускает камеру через autoStart, дожидаясь attach), а
  // разрешение на камеру запрашиваем отдельно, параллельно, только
  // чтобы показать понятный текст, если пользователь его не дал.
  final MobileScannerController _controller = MobileScannerController(
    formats: const [
      BarcodeFormat.dataMatrix,
      BarcodeFormat.ean13,
      BarcodeFormat.ean8,
      BarcodeFormat.code128,
      BarcodeFormat.qrCode,
      BarcodeFormat.code39,
    ],
  );
  bool _handled = false;
  String? _errorText;
  bool _checkingPermission = true;

  @override
  void initState() {
    super.initState();
    _checkPermission();
  }

  Future<void> _checkPermission() async {
    try {
      final status = await Permission.camera.request();
      if (!mounted) return;
      setState(() {
        _checkingPermission = false;
        if (!status.isGranted) {
          _errorText = 'Нет разрешения на камеру — разрешите доступ в настройках телефона';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _checkingPermission = false;
        _errorText = 'Не удалось запросить разрешение на камеру: $e';
      });
    }
  }

  /// Кнопка "Повторить" в состоянии ошибки — просто заново проверяет
  /// разрешение и, если оно уже есть, сбрасывает _errorText, снова
  /// показывая MobileScanner (он перезапустит камеру сам через autoStart
  /// при следующей вставке в дерево/через встроенный lifecycle).
  Future<void> _retry() async {
    setState(() => _errorText = null);
    await _checkPermission();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final value = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (value == null || value.isEmpty) return;
    _handled = true;
    Navigator.of(context).pop(value);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
                if (_errorText == null && !_checkingPermission)
                  IconButton(
                    icon: ValueListenableBuilder(
                      valueListenable: _controller,
                      builder: (context, state, child) => Icon(
                        state.torchState == TorchState.on ? Icons.flash_on : Icons.flash_off,
                      ),
                    ),
                    onPressed: () => _controller.toggleTorch(),
                  ),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
            SizedBox(
              width: 280,
              height: 280,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: _errorText != null
                    ? _buildError(_errorText!)
                    : _checkingPermission
                        ? const ColoredBox(
                            color: Colors.black,
                            child: Center(
                              child: CircularProgressIndicator(color: Colors.white70),
                            ),
                          )
                        : Stack(
                            fit: StackFit.expand,
                            children: [
                              MobileScanner(
                                controller: _controller,
                                onDetect: _onDetect,
                                // placeholderBuilder закрывает короткий
                                // промежуток, пока сам виджет ещё
                                // прикрепляется и запускает камеру через
                                // autoStart — раньше в это время рендерился
                                // отдельный "_starting" спиннер поверх ещё
                                // не построенного MobileScanner, что и
                                // приводило к преждевременному start().
                                placeholderBuilder: (context, child) => const ColoredBox(
                                  color: Colors.black,
                                  child: Center(
                                    child: CircularProgressIndicator(color: Colors.white70),
                                  ),
                                ),
                                // Без errorBuilder виджет сам показывает свою
                                // англоязычную заглушку "An unexpected error
                                // occurred" поверх диалога. Ловим её здесь и
                                // прокидываем в тот же _errorText, чтобы
                                // получить единый текст на русском и те же
                                // кнопки "Повторить"/"На весь экран" снизу —
                                // вместо дублирования UI прямо здесь.
                                errorBuilder: (context, error, child) {
                                  final text =
                                      'Не удалось запустить камеру: ${error.errorDetails?.message ?? error.errorCode.name}';
                                  if (_errorText != text) {
                                    WidgetsBinding.instance.addPostFrameCallback((_) {
                                      if (mounted) setState(() => _errorText = text);
                                    });
                                  }
                                  return _buildError(text);
                                },
                              ),
                              IgnorePointer(
                                child: Container(
                                  margin: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    border: Border.all(color: Colors.white70, width: 2),
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                ),
                              ),
                            ],
                          ),
              ),
            ),
            const SizedBox(height: 10),
            if (_errorText == null)
              const Text(
                'Наведите камеру на код',
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
            if (_errorText != null) ...[
              const SizedBox(height: 4),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  TextButton(onPressed: _retry, child: const Text('Повторить')),
                  const SizedBox(width: 8),
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(_fullscreenFallbackSentinel),
                    child: const Text('Открыть на весь экран'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildError(String text) {
    return ColoredBox(
      color: Colors.black,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, color: Colors.white70, size: 32),
              const SizedBox(height: 8),
              Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70, fontSize: 13)),
            ],
          ),
        ),
      ),
    );
  }
}

class _CameraScannerScreen extends StatefulWidget {
  final String title;
  const _CameraScannerScreen({required this.title});

  @override
  State<_CameraScannerScreen> createState() => _CameraScannerScreenState();
}

class _CameraScannerScreenState extends State<_CameraScannerScreen> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const [
      BarcodeFormat.dataMatrix,
      BarcodeFormat.ean13,
      BarcodeFormat.ean8,
      BarcodeFormat.code128,
      BarcodeFormat.qrCode,
      BarcodeFormat.code39,
    ],
  );
  bool _handled = false;
  // Тот же класс ошибок, что и в компактном диалоге (см. комментарий там):
  // без errorBuilder виджет MobileScanner сам показывает нередактируемую
  // англоязычную заглушку "An unexpected error occurred", если разрешение
  // не выдано или камера не смогла запуститься — а полноэкранный переход
  // такую ошибку раньше вообще никак не обрабатывал.
  String? _errorText;

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final value = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (value == null || value.isEmpty) return;
    _handled = true;
    Navigator.of(context).pop(value);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          IconButton(
            icon: ValueListenableBuilder(
              valueListenable: _controller,
              builder: (context, state, child) => Icon(
                state.torchState == TorchState.on ? Icons.flash_on : Icons.flash_off,
              ),
            ),
            onPressed: () => _controller.toggleTorch(),
          ),
        ],
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
            errorBuilder: (context, error, child) {
              final text =
                  'Не удалось запустить камеру: ${error.errorDetails?.message ?? error.errorCode.name}';
              if (_errorText != text) {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) setState(() => _errorText = text);
                });
              }
              return ColoredBox(
                color: Colors.black,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.error_outline, color: Colors.white70, size: 40),
                        const SizedBox(height: 12),
                        Text(text, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white70)),
                        const SizedBox(height: 16),
                        TextButton(
                          onPressed: () {
                            setState(() => _errorText = null);
                            _controller.start();
                          },
                          child: const Text('Повторить'),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
          if (_errorText == null) ...[
            Center(
              child: Container(
                width: 260,
                height: 180,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.white70, width: 2),
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
            ),
            const Positioned(
              bottom: 32,
              left: 0,
              right: 0,
              child: Text(
                'Наведите камеру на штрихкод или DataMatrix-код',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white),
              ),
            ),
          ],
        ],
      ),
    );
  }
}