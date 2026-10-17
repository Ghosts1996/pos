/// Веб-версия: браузер UDP не умеет, сигналы по локальной сети не ходят.
class LanTransport {
  LanTransport({int port = 0});

  bool get supported => false;

  Future<bool> open(void Function(List<int> bytes) onData) async => false;

  Future<void> broadcast(List<int> bytes) async {}

  Future<void> close() async {}
}
