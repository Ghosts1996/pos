/// События, на которые звенят реле, принтер и устройства в зале.
class SignalEvent {
  SignalEvent._();

  static const kitchenOrder = 'kitchen_order';
  static const barOrder = 'bar_order';
  static const hookahOrder = 'hookah_order';
  static const dishReady = 'dish_ready';
  static const guestCall = 'guest_call';
  static const guestOrder = 'guest_order';

  static const all = [kitchenOrder, barOrder, hookahOrder, dishReady, guestCall, guestOrder];

  static String label(String e) => switch (e) {
        kitchenOrder => 'Новый заказ на кухню',
        barOrder => 'Новый заказ в бар',
        hookahOrder => 'Новый заказ на кальяны',
        dishReady => 'Блюдо готово (кухня нажала «Готово»)',
        guestCall => 'Гость зовёт официанта или кальянщика',
        guestOrder => 'Заказ из приложения гостя',
        _ => e,
      };

  /// Новый заказ цеха: kitchen → kitchen_order и т. д.
  static String orderFor(String station) => switch (station) {
        'bar' => barOrder,
        'hookah' => hookahOrder,
        _ => kitchenOrder,
      };
}

/// Виды Wi‑Fi реле и других приёмников сигнала.
class RelayKind {
  RelayKind._();

  /// Shelly 1 / 1PM / 2.5 / Plug S — первое поколение, HTTP /relay/0.
  static const shellyGen1 = 'shelly1';

  /// Shelly Plus / Pro / Gen3 / Gen4 — RPC /rpc/Switch.Set.
  static const shellyGen2 = 'shelly2';

  /// Sonoff в режиме DIY (Basic R3, Mini R2/R3, RE5V1C) — порт 8081.
  static const sonoffDiy = 'sonoff';

  /// Любое реле с прошивкой Tasmota (Sonoff, Gosund, NOUS и др.).
  static const tasmota = 'tasmota';

  /// Свой адрес: Home Assistant, ioBroker, любой HTTP-приёмник.
  static const webhook = 'webhook';

  static const all = [shellyGen1, shellyGen2, sonoffDiy, tasmota, webhook];

  static String label(String k) => switch (k) {
        shellyGen1 => 'Shelly (1-е поколение: Shelly 1, 1PM, 2.5, Plug S)',
        shellyGen2 => 'Shelly Plus / Pro / Gen3 / Gen4',
        sonoffDiy => 'Sonoff в режиме DIY (Basic R3, Mini R2/R3, RE5V1C)',
        tasmota => 'Реле с прошивкой Tasmota',
        webhook => 'Свой адрес (Home Assistant и др.)',
        _ => k,
      };
}

/// Одно реле: куда слать и на какие события.
class RelayDevice {
  final String id;
  final String name;
  final String kind;

  /// IP в сети заведения (192.168.1.50) или, для [RelayKind.webhook],
  /// полный адрес с подстановками {event}, {table}, {text}.
  final String address;

  /// Номер выхода у многоканальных реле (Shelly 2.5, Sonoff 4CH), с 0.
  final int channel;

  /// Сколько секунд держать включённым: звонок — 1–3, лампа — 10–30.
  final int pulseSeconds;
  final Set<String> events;
  final bool enabled;

  const RelayDevice({
    required this.id,
    required this.name,
    required this.kind,
    required this.address,
    this.channel = 0,
    this.pulseSeconds = 2,
    this.events = const {},
    this.enabled = true,
  });

  RelayDevice copyWith({
    String? name,
    String? kind,
    String? address,
    int? channel,
    int? pulseSeconds,
    Set<String>? events,
    bool? enabled,
  }) =>
      RelayDevice(
        id: id,
        name: name ?? this.name,
        kind: kind ?? this.kind,
        address: address ?? this.address,
        channel: channel ?? this.channel,
        pulseSeconds: pulseSeconds ?? this.pulseSeconds,
        events: events ?? this.events,
        enabled: enabled ?? this.enabled,
      );

  Map<String, dynamic> toMap() => {
        'id': id,
        'name': name,
        'kind': kind,
        'address': address,
        'channel': channel,
        'pulseSeconds': pulseSeconds,
        'events': events.toList()..sort(),
        'enabled': enabled,
      };

  factory RelayDevice.fromMap(Map<String, dynamic> m) => RelayDevice(
        id: (m['id'] ?? '').toString(),
        name: (m['name'] ?? '').toString(),
        kind: RelayKind.all.contains(m['kind']) ? m['kind'] as String : RelayKind.shellyGen1,
        address: (m['address'] ?? '').toString().trim(),
        channel: ((m['channel'] as num?) ?? 0).toInt().clamp(0, 7),
        pulseSeconds: ((m['pulseSeconds'] as num?) ?? 2).toInt().clamp(1, 300),
        events: {for (final e in (m['events'] as List? ?? const [])) if (SignalEvent.all.contains(e)) e as String},
        enabled: m['enabled'] != false,
      );
}

/// Зуммер кухонного принтера при печати бегунка.
class PrinterBeep {
  PrinterBeep._();
  static const off = 'off';

  /// Встроенный зуммер (ESC B n t): Xprinter, Gprinter, Rongta, HPRT,
  /// Sunmi, Epson TM-T20/T82 с зуммером.
  static const builtIn = 'beep';

  /// Импульс в разъём денежного ящика (ESC p): туда подключают внешний
  /// звонок или лампу, если своего зуммера у принтера нет.
  static const drawer = 'drawer';

  static const all = [off, builtIn, drawer];
}

/// Все настройки сигналов заведения: settings/integrations.
class SignalSettings {
  final List<RelayDevice> relays;

  /// Зуммер кухонного и барного принтеров.
  final String printerBeep;

  /// Сколько раз пискнуть (1–9).
  final int printerBeepTimes;

  /// Пищать принтером при новом заказе, даже если бегунки не печатают.
  final bool printerBeepOnOrder;

  /// Сигналы между планшетами по Wi‑Fi заведения — работают без интернета.
  final bool lanEnabled;

  /// Ключ подписи сигналов в локальной сети (у каждого заведения свой).
  final String lanKey;

  const SignalSettings({
    this.relays = const [],
    this.printerBeep = PrinterBeep.off,
    this.printerBeepTimes = 3,
    this.printerBeepOnOrder = false,
    this.lanEnabled = true,
    this.lanKey = '',
  });

  static const empty = SignalSettings();

  List<RelayDevice> relaysFor(String event) =>
      [for (final r in relays) if (r.enabled && r.address.isNotEmpty && r.events.contains(event)) r];

  factory SignalSettings.fromMap(Map<String, dynamic>? d) {
    if (d == null) return empty;
    return SignalSettings(
      relays: [
        for (final r in (d['signalRelays'] as List? ?? const []))
          if (r is Map) RelayDevice.fromMap(Map<String, dynamic>.from(r)),
      ],
      printerBeep: PrinterBeep.all.contains(d['printerBeep']) ? d['printerBeep'] as String : PrinterBeep.off,
      printerBeepTimes: ((d['printerBeepTimes'] as num?) ?? 3).toInt().clamp(1, 9),
      printerBeepOnOrder: d['printerBeepOnOrder'] == true,
      lanEnabled: d['lanSignals'] != false,
      lanKey: (d['lanSignalKey'] ?? '').toString(),
    );
  }

  Map<String, dynamic> toMap() => {
        'signalRelays': [for (final r in relays) r.toMap()],
        'printerBeep': printerBeep,
        'printerBeepTimes': printerBeepTimes,
        'printerBeepOnOrder': printerBeepOnOrder,
        'lanSignals': lanEnabled,
        if (lanKey.isNotEmpty) 'lanSignalKey': lanKey,
      };

  SignalSettings copyWith({
    List<RelayDevice>? relays,
    String? printerBeep,
    int? printerBeepTimes,
    bool? printerBeepOnOrder,
    bool? lanEnabled,
    String? lanKey,
  }) =>
      SignalSettings(
        relays: relays ?? this.relays,
        printerBeep: printerBeep ?? this.printerBeep,
        printerBeepTimes: printerBeepTimes ?? this.printerBeepTimes,
        printerBeepOnOrder: printerBeepOnOrder ?? this.printerBeepOnOrder,
        lanEnabled: lanEnabled ?? this.lanEnabled,
        lanKey: lanKey ?? this.lanKey,
      );
}

/// Текущие настройки на этом устройстве. Заполняет [applySignalSettings]
/// из того же документа, что и принтеры.
SignalSettings signalSettings = SignalSettings.empty;

void applySignalSettings(Map<String, dynamic>? data) {
  signalSettings = SignalSettings.fromMap(data);
}
