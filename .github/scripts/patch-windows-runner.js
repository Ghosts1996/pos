// Касса на Windows: на весь экран без рамки (и обратно в окно) по команде
// из приложения — канал zalpos/window, метод setFullscreen(bool), см.
// lib/services/window_mode.dart.
//
// windows/ создаёт `flutter create` прямо в сборке, поэтому правим
// сгенерированный flutter_window.cpp. Не нашли нужные места (сменился
// шаблон Flutter) — предупреждаем и выходим без ошибки: касса просто
// откроется обычным окном, сборка не падает.
const fs = require('fs');

const file = 'windows/runner/flutter_window.cpp';
let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.log(`::warning::${file} не найден — режим «на весь экран» не добавлен`);
  process.exit(0);
}
if (src.includes('zalpos/window')) {
  console.log('Канал zalpos/window уже есть');
  process.exit(0);
}

const anchorInclude = '#include "flutter/generated_plugin_registrant.h"';
const anchorRegister = 'RegisterPlugins(flutter_controller_->engine());';
if (!src.includes(anchorInclude) || !src.includes(anchorRegister)) {
  console.log('::warning::шаблон flutter_window.cpp изменился — режим «на весь экран» не добавлен');
  process.exit(0);
}

const helpers = `${anchorInclude}

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>

#include <memory>
#include <variant>

namespace {

// Положение окна до перехода на весь экран — чтобы вернуть как было.
WINDOWPLACEMENT g_zal_placement = {sizeof(WINDOWPLACEMENT)};

// На весь экран без рамки и заголовка — или обратно обычным окном.
void ZalSetFullscreen(HWND hwnd, bool on) {
  const LONG style = GetWindowLong(hwnd, GWL_STYLE);
  const bool full = !(style & WS_OVERLAPPEDWINDOW);
  if (on && !full) {
    MONITORINFO mi = {sizeof(mi)};
    if (GetWindowPlacement(hwnd, &g_zal_placement) &&
        GetMonitorInfo(MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY), &mi)) {
      SetWindowLong(hwnd, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW);
      SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                   mi.rcMonitor.right - mi.rcMonitor.left,
                   mi.rcMonitor.bottom - mi.rcMonitor.top,
                   SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    }
  } else if (!on && full) {
    SetWindowLong(hwnd, GWL_STYLE, style | WS_OVERLAPPEDWINDOW);
    SetWindowPlacement(hwnd, &g_zal_placement);
    SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER |
                     SWP_FRAMECHANGED);
  }
}

std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> g_zal_channel;

}  // namespace`;

const channel = `${anchorRegister}
  {
    HWND top = GetHandle();
    g_zal_channel = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
        flutter_controller_->engine()->messenger(), "zalpos/window",
        &flutter::StandardMethodCodec::GetInstance());
    g_zal_channel->SetMethodCallHandler(
        [top](const flutter::MethodCall<flutter::EncodableValue>& call,
              std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
          if (call.method_name() == "setFullscreen") {
            const auto* on = std::get_if<bool>(call.arguments());
            ZalSetFullscreen(top, on != nullptr && *on);
            result->Success();
          } else {
            result->NotImplemented();
          }
        });
  }`;

src = src.replace(anchorInclude, helpers).replace(anchorRegister, channel);
fs.writeFileSync(file, src);
console.log('flutter_window.cpp: добавлен канал zalpos/window (на весь экран без рамки)');
