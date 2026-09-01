/// Результат одной операции оплаты через терминал.
class TerminalPaymentResult {
  final bool success;
  final String? errorMessage;
  final String? operationId; // номер операции/слипа от банка, для сверки
  final String? maskedCardNumber; // например "•• 4242" — если банк его отдаёт

  const TerminalPaymentResult.success({this.operationId, this.maskedCardNumber})
      : success = true,
        errorMessage = null;

  const TerminalPaymentResult.failure(this.errorMessage)
      : success = false,
        operationId = null,
        maskedCardNumber = null;
}

/// Абстракция над оплатой банковской картой через физический терминал.
///
/// Экран оплаты ([PaymentScreen]) работает только с этим интерфейсом и
/// ничего не знает о конкретном банке — поэтому подключение реального
/// эквайринга сводится к одному шагу:
///
///   1. Получить Android/iOS SDK у банка (Тинькофф Acquiring SDK,
///      Sberbank Acquiring SDK, Alfa Terminal SDK и т.п.) и договор
///      эквайринга.
///   2. Написать класс, реализующий [PaymentTerminalService], который
///      внутри вызывает нативный SDK через platform channel (MethodChannel)
///      — Flutter не может напрямую дернуть Kotlin/Java-код банка, нужен
///      мост.
///   3. Заменить [MockPaymentTerminalService] на новый класс в месте
///      создания сервиса (см. [paymentTerminalService] в конце файла) —
///      экран оплаты трогать не придётся.
///
/// До тех пор используется [MockPaymentTerminalService] — он ничего не
/// списывает по-настоящему, только имитирует задержку и всегда завершает
/// оплату успехом, чтобы можно было обкатать весь UI-поток уже сейчас.
abstract class PaymentTerminalService {
  /// Есть ли вообще подключённый терминал (для мока — всегда true;
  /// для реального SDK — например, проверка Bluetooth-соединения).
  bool get isAvailable;

  /// Отправляет сумму [amount] (в рублях) на терминал и ждёт результат
  /// операции — гость в это время прикладывает карту/телефон к
  /// терминалу. Для реальных SDK это обычно нативный экран банка поверх
  /// приложения; после его закрытия SDK отдаёт результат сюда.
  Future<TerminalPaymentResult> pay(double amount);
}

/// Заглушка для разработки и демонстрации, пока нет доступа к реальному
/// банковскому SDK. Имитирует поход к терминалу (задержка ~2 сек) и
/// всегда возвращает успех — так весь путь "нажал → подождал → сумма
/// подставилась" можно проверить уже сейчас, без физического устройства.
class MockPaymentTerminalService implements PaymentTerminalService {
  @override
  bool get isAvailable => true;

  @override
  Future<TerminalPaymentResult> pay(double amount) async {
    await Future.delayed(const Duration(seconds: 2));
    return TerminalPaymentResult.success(
      operationId: 'MOCK-${DateTime.now().millisecondsSinceEpoch}',
      maskedCardNumber: '•• 4242',
    );
  }
}

/// Единая точка получения сервиса терминала во всём приложении.
/// Когда появится реальный банковский SDK — меняется только эта строка.
PaymentTerminalService paymentTerminalService = MockPaymentTerminalService();