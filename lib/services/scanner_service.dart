import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

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
library scanner_service;

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
          MobileScanner(controller: _controller, onDetect: _onDetect),
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
      ),
    );
  }
}