/// Сколько провести кнопкой терминала у поля «Оплата с терминала».
///
/// [received] — безнал, который уже пришёл и сам не вернётся: гость оплатил
/// по СБП со стола и прошлые оплаты терминалом на этом экране. Он уже стоит
/// в поле терминала, и второй раз его брать нельзя.
///
/// [terminalTyped] — кассир сам перенёс сумму в поле терминала: тогда
/// проводим то, что в поле сверх уже полученного. Иначе — остаток счёта
/// после сумм, которые кассир сам вписал в другие способы ([others]).
/// Наличные, которые касса подставила по умолчанию, в [others] не входят:
/// это подсказка, а не деньги, — иначе кнопка терминала списала бы всю
/// сумму и касса ещё показала бы её «сдачей».
double terminalCharge({
  required double due,
  required double received,
  required double terminalField,
  required bool terminalTyped,
  required double others,
}) {
  if (terminalTyped) {
    final typed = terminalField - received;
    if (typed > 0.004) return _kop(typed);
  }
  final rest = due - received - others;
  return rest > 0.004 ? _kop(rest) : 0;
}

/// Сколько уже получено безналом и должно остаться в поле терминала:
/// оплата гостя со стола (не больше счёта — переплату банк вернёт сам) и
/// оплаты терминалом на этом экране.
double terminalReceived({required double due, required double guestPaid, required double charged}) {
  final guest = guestPaid > due ? due : guestPaid;
  return _kop((guest > 0 ? guest : 0) + charged);
}

double _kop(double v) => (v * 100).roundToDouble() / 100;
