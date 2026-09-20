import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/client_models.dart';
import 'hall_watch_service.dart';
import 'printer_service.dart';
import 'kassa_service.dart';
import 'payment_terminal_service.dart';
import 'egais_service.dart';
import 'chestny_znak_api_service.dart';
import 'push_service.dart';
import 'gift_card_service.dart';
import 'venue_service.dart';
import 'auto_stoplist_service.dart';
import 'session_alerts_service.dart';
import 'ai/ai_settings.dart';
import 'ai/ai_scheduler.dart';
import 'background_jobs_service.dart';

/// Всё, что не блокирует старт приложения — принтер/касса/ИИ подтянутся
/// чуть позже, если настроены, а не настроены — ничего не сломается.
///
/// Вызывается один раз: сразу при старте (одно-арендная сборка и уже
/// присоединённое SaaS-устройство, см. main.dart) либо сразу после
/// успешного присоединения к заведению (SaasDevicePairingScreen). Вынесено
/// из main.dart отдельным файлом, чтобы экран присоединения мог вызвать её,
/// не создавая циклический импорт main.dart ↔ экран.
void startBackgroundServices() {
  unawaited(loadSavedPrinterSettings());
  unawaited(loadSavedKassaSettings());
  unawaited(loadSavedTerminalSettings());
  unawaited(loadSavedEgaisSettings());
  unawaited(loadSavedChestnyZnakSettings());
  unawaited(AiSettingsStore.instance.init());
  unawaited(PushService.instance.initStaff());
  // Пороги/кешбек программы лояльности (см. settings/loyalty и
  // lib/screens/admin/loyalty_settings_screen.dart) — без них касса
  // начисляет бонусы по дефолтным цифрам ClientProfile.tiers.
  unawaited(loadLoyaltyTierSettings());

  // Локальные уведомления зала: новые брони, вызовы гостей, угли через
  // 35 минут и предупреждение за 10 минут до конца сеанса. Работают без
  // сервера и без платного тарифа Firebase.
  //
  // Старт слежения за залом не зависит от результата init(): запрос
  // разрешения на точные будильники бросает исключение на части
  // прошивок, и если бы старт был приклеен через `init().then(...)`,
  // такая осечка отменяла бы весь сервис — каналы уведомлений при этом
  // создаются и видны в настройках телефона, вызовы гостей видны на
  // экране, но в шторку ничего не приходит.
  // Слежение за залом ведёт ФОНОВАЯ СЛУЖБА, а не сам экран.
  //
  // Когда приложение смахивают из списка задач, Android уничтожает его
  // экран, а вместе с ним — весь основной изолят Dart со всеми
  // подписками на базу. Служба живёт в отдельном изоляте и переживает
  // это, поэтому подписки на вызовы гостей и брони заведены именно
  // там (см. HallWatchService).
  //
  // Здесь — только запасной путь: если система не дала запустить
  // службу, следим сами. Уведомления тогда работают, пока приложение
  // не выгрузили, — хуже, но лучше, чем ничего.
  unawaited(HallWatchService.instance.start().then((ok) {
    if (!ok) unawaited(SessionAlertsService.instance.start());
  }));
  VenueService.instance.watch();

  // Сертификаты из Telegram-канала: гость вводит код у себя, а
  // начисляет бонусы касса — сам себе гость их начислить не может, и
  // правила базы этого не разрешают. Пока заведение работает,
  // начисление занимает секунды.
  GiftCardService.instance.watchClaims();

  // Автостоп-лист следит за остатками и сам убирает из меню то, чего
  // нет в зале, — иначе гость закажет это в «Colibri Lounge».
  AutoStopListService.instance.start();

  // Фоновые ИИ-задания. Замок внутри планировщика гарантирует, что
  // работу выполнит только одно устройство в зале.
  final uid = FirebaseAuth.instance.currentUser?.uid;
  if (uid != null) AiScheduler.instance.start(deviceId: uid);

  // То, что раньше делали Cloud Functions: снять брони, к которым
  // гость не пришёл, и поздравить именинников. Функции доступны только
  // на платном тарифе Blaze, поэтому на бесплатном эту работу ведёт
  // сам POS — тоже под замком «дежурного устройства». В SaaS-режиме
  // тариф платный (Blaze нужен для Cloud Functions платформы), но эти
  // задачи всё равно дешевле оставить на устройстве — они привязаны к
  // конкретному заведению, а не к платформе в целом.
  if (uid != null) BackgroundJobsService.instance.start(deviceId: uid);
}
