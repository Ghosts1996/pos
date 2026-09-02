import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
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

/// Форматы кодов, которые распознаёт камера — вынесены в константу и
/// используются везде, где создаётся [MobileScannerController], чтобы не
/// дублировать список и не разойтись между полноэкранным и компактным
/// вариантами.
const List<BarcodeFormat> _scannerFormats = [
  BarcodeFormat.dataMatrix,
  BarcodeFormat.ean13,
  BarcodeFormat.ean8,
  BarcodeFormat.code128,
  BarcodeFormat.qrCode,
  BarcodeFormat.code39,
];

/// Сколько раз автоматически, без участия пользователя, пересоздать
/// камеру и попробовать снова, если нативная сторона (CameraX на
/// Android) упала с ошибкой при запуске. Такие сбои (характерная ошибка —
/// NullPointerException вида "Attempt to invoke virtual method ... on a
/// null object reference" при попытке привязать preview) — это известная,
/// хорошо задокументированная гонка между CameraX и ещё не до конца
/// готовым native-view на части устройств/прошивок Android; она почти
/// всегда не воспроизводится повторно на том же устройстве через доли
/// секунды, поэтому автоматический повтор — самый надёжный способ
/// добиться того, чтобы камера в итоге завелась без вмешательства
/// пользователя.
/// Метка сборки — видна прямо в тексте ошибки на экране. Нужна ТОЛЬКО для
/// диагностики: чтобы по скриншоту/видео с устройства сразу было понятно,
/// действительно ли на телефоне стоит сборка с последними правками этого
/// файла (автоповтор с жёстким дедлайном по времени), а не более старая
/// версия APK. Увеличивайте при каждой следующей правке этого файла.
const String _scannerServiceBuildTag = 'scanner-fix-v4';

const int _maxAutoRetries = 2;

/// Абсолютный потолок по времени на автоматические попытки — страховка на
/// случай, если счётчик попыток [_maxAutoRetries] по каким-то причинам не
/// сработает как ожидалось (например, повторные сбои приходят настолько
/// плотно друг за другом, что реальное поведение на конкретном устройстве
/// расходится с расчётной раскладкой по времени). Независимо от того, что
/// происходит со счётчиком, через это время с МОМЕНТА ПЕРВОЙ ошибки мы
/// принудительно показываем финальный экран с кнопками — гарантия того,
/// что "Повторный запуск камеры…" не может висеть вечно.
const Duration _autoRetryHardDeadline = Duration(seconds: 5);

/// Исключение "код не найден на фото" — отдельный тип, чтобы вызывающий
/// код мог показать пользователю осмысленный текст, а не сырую ошибку.
class _PhotoScanNoCodeException implements Exception {
  const _PhotoScanNoCodeException();
  @override
  String toString() => 'Код не распознан на фото';
}

/// Запасной способ получить код, который принципиально НЕ использует живое
/// превью камеры (CameraX) внутри нашего приложения — а значит не подвержен
/// сбоям вида "Attempt to invoke virtual method ... on a null object
/// reference", которые возникают именно при попытке привязать (bind) живое
/// превью на некоторых устройствах/прошивках Android. Такие сбои — это
/// несовместимость конкретного устройства с тем, как CameraX поднимает
/// живой предпросмотр, а не что-то, что можно надёжно вылечить повторными
/// попытками на стороне Flutter (см. историю правок этого файла).
///
/// Вместо живого превью здесь используется:
/// 1. Системное приложение камеры Android через `image_picker` — совсем
///    другой, штатный компонент ОС, который не имеет отношения к CameraX
///    и работает практически на любом устройстве (это то же самое
///    приложение камеры, которым пользователь фотографирует каждый день).
/// 2. Одноразовый статический анализ полученного фото через
///    `MobileScannerController.analyzeImage` — тот же движок ML Kit, что и
///    у живого сканера, но без живого видеопотока и без привязки preview,
///    поэтому сюда не может протечь тот же сбой.
///
/// Возвращает найденный код или null, если пользователь отменил
/// фотографирование. Бросает [_PhotoScanNoCodeException], если код на фото
/// не распознан, — вызывающая сторона показывает это как обычную ошибку.
Future<String?> _scanBarcodeFromCameraPhoto() async {
  final photo = await ImagePicker().pickImage(
    source: ImageSource.camera,
    maxWidth: 1920,
    maxHeight: 1920,
    imageQuality: 90,
  );
  if (photo == null) return null;
  final controller = MobileScannerController(formats: _scannerFormats);
  try {
    final result = await controller.analyzeImage(photo.path);
    final barcodes = result?.barcodes ?? const [];
    final value = barcodes.isNotEmpty ? barcodes.first.rawValue : null;
    if (value == null || value.isEmpty) {
      throw const _PhotoScanNoCodeException();
    }
    return value;
  } finally {
    controller.dispose();
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
/// маленьком окне на конкретном устройстве даже после автоматических
/// повторов, в диалоге есть кнопка "Открыть на весь экран" — тогда
/// подхватывается полноэкранный [showCameraScanner] (со своими
/// собственными автоматическими повторами).
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

/// Небольшой диалог ручного ввода кода — последний, ни от чего не зависящий
/// способ передать код в приложение, когда камера (живое превью ИЛИ разовый
/// снимок через [_scanBarcodeFromCameraPhoto]) не работает на конкретном
/// устройстве вообще никак. Не зависит от CameraX/ML Kit, поэтому не может
/// упасть с той же ошибкой, что и остальные способы — использует только
/// обычное текстовое поле.
Future<String?> _showManualEntryDialog(BuildContext context) {
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Ввести код вручную'),
      content: TextField(
        controller: controller,
        autofocus: true,
        textInputAction: TextInputAction.done,
        decoration: const InputDecoration(hintText: 'Код маркировки или штрихкод'),
        onSubmitted: (value) {
          final trimmed = value.trim();
          if (trimmed.isNotEmpty) Navigator.of(dialogContext).pop(trimmed);
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('Отмена'),
        ),
        TextButton(
          onPressed: () {
            final trimmed = controller.text.trim();
            if (trimmed.isNotEmpty) Navigator.of(dialogContext).pop(trimmed);
          },
          child: const Text('Готово'),
        ),
      ],
    ),
  );
}

/// Кнопка-ссылка "Ввести код вручную" — общая для компактного и
/// полноэкранного сканера. Всегда доступна, а не только после сбоя камеры:
/// на устройствах, где живое превью в принципе не заводится, не нужно
/// заставлять пользователя сначала дождаться ошибки, чтобы найти этот путь.
class _ManualEntryLink extends StatelessWidget {
  final Future<void> Function() onManualEntry;
  const _ManualEntryLink({required this.onManualEntry});

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: onManualEntry,
      icon: const Icon(Icons.keyboard, size: 18),
      label: const Text('Ввести код вручную'),
    );
  }
}

class _CompactCameraScannerDialog extends StatefulWidget {
  final String title;
  const _CompactCameraScannerDialog({required this.title});
@override
  State<_CompactCameraScannerDialog> createState() => _CompactCameraScannerDialogState();
}

class _CompactCameraScannerDialogState extends State<_CompactCameraScannerDialog> {
  // ВАЖНО: autoStart оставляем true (по умолчанию) и НЕ вызываем
  // _controller.start() вручную — MobileScanner сам запускает камеру,
  // дожидаясь attach нативного view.
  Key _scannerKey = UniqueKey();
  MobileScannerController _controller = MobileScannerController(formats: _scannerFormats);
  bool _handled = false;
  String? _errorText;
  bool _checkingPermission = true;
  // Остаётся false, пока не закончится анимация появления диалога (Dialog
  // по умолчанию открывается с fade+scale переходом). Если смонтировать
  // MobileScanner (а с ним и CameraX preview) прямо во время этой
  // анимации, на части устройств/прошивок получаем нативный сбой при
  // попытке забиндить preview к ещё не до конца готовому view. Дожидаемся,
  // пока переход диалога полностью завершится, и только тогда строим сам
  // виджет камеры.
  bool _transitionFinished = false;
  // Сколько автоматических попыток перезапуска камеры уже сделано после
  // нативной ошибки — см. комментарий у [_maxAutoRetries].
  int _retryCount = 0;
  // true, пока идёт короткая пауза перед очередной автоматической
  // попыткой — в это время показываем спиннер вместо текста ошибки, чтобы
  // пользователь вообще не видел сбой, если он устранится сам.
  bool _autoRetryPending = false;
  // Защита от повторного срабатывания errorBuilder для одной и той же
  // попытки запуска (Flutter может вызвать builder несколько раз за кадр).
  bool _errorHandledForThisAttempt = false;
  // Момент ПЕРВОЙ ошибки в текущей серии попыток — см. комментарий у
  // [_autoRetryHardDeadline].
  DateTime? _firstErrorAt;
  // Сторож на случай "тихого" зависания: на некоторых устройствах нативная
  // сторона (CameraX) не вызывает ни onDetect, ни errorBuilder — preview
  // просто никогда не подключается, и без этого таймера состояние
  // "Повторный запуск камеры…" осталось бы навсегда. Если за отведённое
  // время не пришло ни кадра, ни ошибки — считаем это ошибкой сами и идём
  // по тому же пути автоповтора/показа ошибки, что и настоящий сбой.
  Timer? _watchdogTimer;
  static const _watchdogTimeout = Duration(seconds: 4);
  // true, пока открыто системное приложение камеры и/или идёт
  // статический анализ снятого фото — см. [_scanBarcodeFromCameraPhoto].
  bool _photoScanInProgress = false;

  @override
  void initState() {
    super.initState();
    _checkPermission();
    WidgetsBinding.instance.addPostFrameCallback((_) => _waitForTransition());
  }

  void _waitForTransition() {
    final route = ModalRoute.of(context);
    final animation = route?.animation;
    if (animation == null || animation.isCompleted) {
      if (mounted) {
        setState(() => _transitionFinished = true);
        _startWatchdog();
      }
      return;
    }
    void onStatus(AnimationStatus status) {
      if (status == AnimationStatus.completed) {
        animation.removeStatusListener(onStatus);
        if (mounted) {
          setState(() => _transitionFinished = true);
          _startWatchdog();
        }
      }
    }

    animation.addStatusListener(onStatus);
    // На случай, если статус уже completed к моменту подписки (гонка
    // между addPostFrameCallback и завершением анимации).
    if (animation.isCompleted) {
      animation.removeStatusListener(onStatus);
      if (mounted) {
        setState(() => _transitionFinished = true);
        _startWatchdog();
      }
    }
  }

  /// Запускает (пере)отсчёт таймаута для текущей попытки запуска камеры.
  void _startWatchdog() {
    _watchdogTimer?.cancel();
    _watchdogTimer = Timer(_watchdogTimeout, () {
      if (!mounted || _handled) return;
      // Если камера уже реально запустилась (isInitialized) — это не
      // зависание, а просто пользователь ещё не навёл её на код. Ложную
      // ошибку в этом случае показывать нельзя.
      if (_controller.value.isInitialized) return;
      // Камера не подала признаков жизни — ни кадра, ни ошибки от плагина.
      _handleScannerError(
        'Камера не отвечает [$_scannerServiceBuildTag] — не удалось получить изображение с камеры',
      );
    });
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

  /// Полностью пересоздаёт контроллер и виджет камеры (новый [Key]) —
  /// самый надёжный способ повторной попытки независимо от версии
  /// плагина: некоторые версии mobile_scanner ведут себя непредсказуемо
  /// при повторном ручном .start() уже использованного контроллера.
  void _resetScanner() {
    final oldController = _controller;
    setState(() {
      _errorText = null;
      _autoRetryPending = false;
      _errorHandledForThisAttempt = false;
      _scannerKey = UniqueKey();
      _controller = MobileScannerController(formats: _scannerFormats);
    });
    oldController.dispose();
    if (_transitionFinished) _startWatchdog();
  }

  /// Кнопка "Повторить", нажатая пользователем вручную после того, как
  /// автоматические попытки закончились неудачей.
  Future<void> _retry() async {
    _retryCount = 0;
    _firstErrorAt = null;
    _resetScanner();
    await _checkPermission();
  }

  /// Вызывается из errorBuilder MobileScanner — то есть при сбое именно
  /// нативного запуска камеры (не разрешения). Первые [_maxAutoRetries]
  /// раз пробуем молча пересоздать камеру и запустить её снова — на
  /// практике такие сбои почти всегда транзиентные и исчезают сами уже
  /// со второй попытки. Только если и это не помогло, показываем текст
  /// ошибки и ручные кнопки.
  void _handleScannerError(String text) {
    // errorBuilder вызывается СИНХРОННО во время build() виджета камеры,
    // поэтому вызывать setState прямо здесь нельзя — Flutter обрывает
    // выполнение на первом же setState, вызванном во время построения
    // дерева ("setState() called during build"), и весь код ниже (включая
    // Future.delayed с автоповтором) просто никогда не выполняется. Из-за
    // этого экран так и оставался с картинкой ошибки навсегда — ни
    // автоповтор, ни финальные кнопки не срабатывали. Откладываем всё до
    // конца текущего кадра.
    if (_errorHandledForThisAttempt) return;
    _errorHandledForThisAttempt = true;
    _firstErrorAt ??= DateTime.now();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // Жёсткая страховка: если с первой ошибки в этой серии прошло больше
      // [_autoRetryHardDeadline] — принудительно идём в финальную ветку,
      // ЧТО БЫ НИ ПРОИСХОДИЛО со счётчиком попыток. Без этого при
      // достаточно частых повторных сбоях экран мог технически никогда не
      // дойти до показа кнопок — именно это происходило на видео.
      final deadlinePassed =
          DateTime.now().difference(_firstErrorAt!) >= _autoRetryHardDeadline;
      if (_retryCount < _maxAutoRetries && !deadlinePassed) {
        _retryCount++;
        setState(() => _autoRetryPending = true);
        Future.delayed(Duration(milliseconds: 500 * _retryCount), () {
          if (!mounted) return;
          _resetScanner();
        });
      } else {
        _watchdogTimer?.cancel();
        setState(() => _errorText = text);
      }
    });
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final value = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (value == null || value.isEmpty) return;
    _handled = true;
    _watchdogTimer?.cancel();
    Navigator.of(context).pop(value);
  }

  /// Запасной путь через системную камеру + статический анализ фото — см.
  /// [_scanBarcodeFromCameraPhoto]. Используется, когда живое превью не
  /// заводится на устройстве вообще (см. кнопку в [_buildErrorButtons]).
  Future<void> _scanFromPhoto() async {
    if (_photoScanInProgress) return;
    setState(() => _photoScanInProgress = true);
    try {
      final value = await _scanBarcodeFromCameraPhoto();
      if (!mounted) return;
      if (value != null) {
        _handled = true;
        Navigator.of(context).pop(value);
        return;
      }
      // value == null — пользователь отменил съёмку, просто возвращаемся
      // к прежнему экрану ошибки без изменений.
      setState(() => _photoScanInProgress = false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _photoScanInProgress = false;
        _errorText = e is _PhotoScanNoCodeException
            ? 'Код не распознан на фото. Сфотографируйте код чётче и без бликов, либо введите его вручную.'
            : 'Не удалось сделать фото: $e';
      });
    }
  }

  /// Ручной ввод — см. [_showManualEntryDialog]. Единственный путь, который
  /// не зависит от камеры/ML Kit вообще и поэтому гарантированно работает
  /// даже на устройствах, где ни живое превью, ни разовый снимок не
  /// заводятся (см. видео с ошибкой [_scannerServiceBuildTag]).
  Future<void> _enterManually() async {
    final value = await _showManualEntryDialog(context);
    if (!mounted || value == null) return;
    _handled = true;
    Navigator.of(context).pop(value);
  }

  @override
  void dispose() {
    _watchdogTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final showSpinner = _checkingPermission || !_transitionFinished || _autoRetryPending;
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
                if (_errorText == null && !showSpinner)
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
                    : showSpinner
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
                                key: _scannerKey,
                                controller: _controller,
                                onDetect: _onDetect,
                                // placeholderBuilder закрывает короткий
                                // промежуток, пока сам виджет ещё
                                // прикрепляется и запускает камеру через
                                // autoStart.
                                placeholderBuilder: (context, child) => const ColoredBox(
                                  color: Colors.black,
                                  child: Center(
                                    child: CircularProgressIndicator(color: Colors.white70),
                                  ),
                                ),
                                // Без errorBuilder виджет сам показывает свою
                                // англоязычную заглушку "An unexpected error
                                // occurred" поверх диалога. Ловим её здесь и
                                // прогоняем через _handleScannerError —
                                // первые несколько раз это молча пересоздаст
                                // камеру, а не сразу покажет ошибку.
                                errorBuilder: (context, error, child) {
                                  final text =
                                      'Не удалось запустить камеру [$_scannerServiceBuildTag]: ${error.errorDetails?.message ?? error.errorCode.name}';
                                  _handleScannerError(text);
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
            if (_errorText == null && !_autoRetryPending && !_photoScanInProgress)
              const Text(
                'Наведите камеру на код',
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
            if (_autoRetryPending)
              const Text(
                'Повторный запуск камеры…',
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
            if (_photoScanInProgress)
              const Text(
                'Обработка фото…',
                style: TextStyle(color: Colors.grey, fontSize: 13),
              ),
            // Ссылка на ручной ввод доступна всегда, а не только после
            // сбоя камеры — на устройствах, где живое превью в принципе не
            // заводится (см. видео), не нужно заставлять пользователя ждать
            // ошибку, чтобы найти рабочий способ ввести код.
            if (!_photoScanInProgress) _ManualEntryLink(onManualEntry: _enterManually),
            if (_errorText != null) ...[
              const SizedBox(height: 4),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 8,
                runSpacing: 4,
                children: [
                  TextButton(
                    onPressed: _photoScanInProgress ? null : _retry,
                    child: const Text('Повторить'),
                  ),
                  // Живое превью камеры (CameraX) на этом устройстве не
                  // заводится — вместо него используем системную камеру
                  // Android + разовый анализ снимка (analyzeImage), это
                  // совсем другой, гораздо более надёжный путь. См.
                  // комментарий у [_scanBarcodeFromCameraPhoto].
                  TextButton(
                    onPressed: _photoScanInProgress ? null : _scanFromPhoto,
                    child: Text(_photoScanInProgress ? 'Обработка…' : 'Сделать фото'),
                  ),
                  TextButton(
                    onPressed: _photoScanInProgress
                        ? null
                        : () => Navigator.of(context).pop(_fullscreenFallbackSentinel),
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
  // _scannerKey меняется при каждой попытке — это заставляет Flutter
  // полностью пересоздать MobileScanner (и его internal state/controller
  // lifecycle) с нуля, а не просто повторно дёрнуть .start() у уже
  // существующего контроллера.
  Key _scannerKey = UniqueKey();
  MobileScannerController _controller = MobileScannerController(formats: _scannerFormats);
  bool _handled = false;
  String? _errorText;
  // Тот же приём, что и в компактном диалоге: не монтируем камеру, пока
  // не закончится анимация появления экрана (MaterialPageRoute тоже
  // анимирует переход даже с fullscreenDialog: true) — запуск CameraX
  // прямо во время этого перехода — частая причина нативного сбоя при
  // старте камеры на некоторых устройствах.
  bool _transitionFinished = false;
  int _retryCount = 0;
  bool _autoRetryPending = false;
  bool _errorHandledForThisAttempt = false;
  DateTime? _firstErrorAt;
  // См. комментарий у аналогичного поля в компактном диалоге — страхует
  // от "тихого" зависания камеры без ошибки и без кадра.
  Timer? _watchdogTimer;
  static const _watchdogTimeout = Duration(seconds: 4);
  // true, пока открыто системное приложение камеры и/или идёт
  // статический анализ снятого фото — см. [_scanBarcodeFromCameraPhoto].
  bool _photoScanInProgress = false;

  @override
void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _waitForTransition());
  }

  void _waitForTransition() {
    final route = ModalRoute.of(context);
    final animation = route?.animation;
    if (animation == null || animation.isCompleted) {
      if (mounted) {
        setState(() => _transitionFinished = true);
        _startWatchdog();
      }
      return;
    }
    void onStatus(AnimationStatus status) {
      if (status == AnimationStatus.completed) {
        animation.removeStatusListener(onStatus);
        if (mounted) {
          setState(() => _transitionFinished = true);
          _startWatchdog();
        }
      }
    }

    animation.addStatusListener(onStatus);
    if (animation.isCompleted) {
      animation.removeStatusListener(onStatus);
      if (mounted) {
        setState(() => _transitionFinished = true);
        _startWatchdog();
      }
    }
  }

  void _startWatchdog() {
    _watchdogTimer?.cancel();
    _watchdogTimer = Timer(_watchdogTimeout, () {
      if (!mounted || _handled) return;
      if (_controller.value.isInitialized) return;
      _handleScannerError(
        'Камера не отвечает [$_scannerServiceBuildTag] — не удалось получить изображение с камеры',
      );
    });
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    final value = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (value == null || value.isEmpty) return;
    _handled = true;
    _watchdogTimer?.cancel();
    Navigator.of(context).pop(value);
  }

  /// См. комментарий у аналогичного метода в компактном диалоге.
  Future<void> _scanFromPhoto() async {
    if (_photoScanInProgress) return;
    setState(() => _photoScanInProgress = true);
    try {
      final value = await _scanBarcodeFromCameraPhoto();
      if (!mounted) return;
      if (value != null) {
        _handled = true;
        Navigator.of(context).pop(value);
        return;
      }
      setState(() => _photoScanInProgress = false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _photoScanInProgress = false;
        _errorText = e is _PhotoScanNoCodeException
            ? 'Код не распознан на фото. Сфотографируйте код чётче и без бликов, либо введите его вручную.'
            : 'Не удалось сделать фото: $e';
      });
    }
  }

  /// См. комментарий у одноимённого метода в компактном диалоге.
  Future<void> _enterManually() async {
    final value = await _showManualEntryDialog(context);
    if (!mounted || value == null) return;
    _handled = true;
    Navigator.of(context).pop(value);
  }

  /// Полностью пересоздаёт контроллер камеры вместе с новым ключом
  /// виджета — см. комментарий у аналогичного метода в компактном
  /// диалоге.
  void _resetScanner() {
    final oldController = _controller;
    setState(() {
      _errorText = null;
      _autoRetryPending = false;
      _errorHandledForThisAttempt = false;
      _scannerKey = UniqueKey();
      _controller = MobileScannerController(formats: _scannerFormats);
    });
    oldController.dispose();
    if (_transitionFinished) _startWatchdog();
  }

  /// Кнопка "Повторить" — ручная попытка после того, как автоматические
  /// закончились неудачей.
  void _retry() {
    _retryCount = 0;
    _firstErrorAt = null;
    _resetScanner();
  }

  /// См. комментарий у [_maxAutoRetries] и у одноимённого метода в
  /// компактном диалоге — сначала пробуем молча пересоздать камеру
  /// несколько раз, и только потом показываем ошибку пользователю.
  void _handleScannerError(String text) {
    // См. подробный комментарий у одноимённого метода в компактном
    // диалоге: errorBuilder вызывается синхронно во время build(), поэтому
    // весь setState откладываем на конец кадра через addPostFrameCallback.
    if (_errorHandledForThisAttempt) return;
    _errorHandledForThisAttempt = true;
    _firstErrorAt ??= DateTime.now();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final deadlinePassed =
          DateTime.now().difference(_firstErrorAt!) >= _autoRetryHardDeadline;
      if (_retryCount < _maxAutoRetries && !deadlinePassed) {
        _retryCount++;
        setState(() => _autoRetryPending = true);
        Future.delayed(Duration(milliseconds: 500 * _retryCount), () {
          if (!mounted) return;
          _resetScanner();
        });
      } else {
        _watchdogTimer?.cancel();
        setState(() => _errorText = text);
      }
    });
  }

  @override
  void dispose() {
    _watchdogTimer?.cancel();
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
          if (_transitionFinished && _errorText == null && !_autoRetryPending)
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
          if (!_transitionFinished || _autoRetryPending)
            const ColoredBox(
              color: Colors.black,
              child: Center(
                child: CircularProgressIndicator(color: Colors.white70),
              ),
            )
          else
            MobileScanner(
              key: _scannerKey,
              controller: _controller,
              onDetect: _onDetect,
              errorBuilder: (context, error, child) {
                final text =
                    'Не удалось запустить камеру [$_scannerServiceBuildTag]: ${error.errorDetails?.message ?? error.errorCode.name}';
                _handleScannerError(text);
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
                          if (_errorText != null)
                            Wrap(
                              alignment: WrapAlignment.center,
                              spacing: 8,
                              runSpacing: 4,
                              children: [
                                TextButton(
                                  onPressed: _photoScanInProgress ? null : _retry,
                                  child: const Text('Повторить'),
                                ),
                                // См. комментарий у [_scanBarcodeFromCameraPhoto] —
                                // системная камера + разовый анализ фото вместо
                                // сломанного на этом устройстве живого превью.
                                TextButton(
                                  onPressed: _photoScanInProgress ? null : _scanFromPhoto,
                                  child: Text(_photoScanInProgress ? 'Обработка…' : 'Сделать фото'),
                                ),
                                // Гарантированно рабочий путь, не зависящий от
                                // камеры/ML Kit вообще — см. [_showManualEntryDialog].
                                TextButton(
                                  onPressed: _photoScanInProgress ? null : _enterManually,
                                  child: const Text('Ввести код вручную'),
                                ),
                              ],
                            ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          if (_autoRetryPending)
            const Positioned(
              bottom: 32,
              left: 0,
              right: 0,
              child: Text(
                'Повторный запуск камеры…',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white),
              ),
            ),
          if (_photoScanInProgress)
            const Positioned(
              bottom: 32,
              left: 0,
              right: 0,
              child: Text(
                'Обработка фото…',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white),
              ),
            ),
          if (_errorText == null && _transitionFinished && !_autoRetryPending) ...[
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
            Positioned(
              bottom: 32,
              left: 0,
              right: 0,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text(
                    'Наведите камеру на штрихкод или DataMatrix-код',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white),
                  ),
                  // Доступно сразу, не дожидаясь сбоя — см. комментарий у
                  // одноимённой ссылки в компактном диалоге.
                  if (!_photoScanInProgress)
                    _ManualEntryLink(onManualEntry: _enterManually),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}