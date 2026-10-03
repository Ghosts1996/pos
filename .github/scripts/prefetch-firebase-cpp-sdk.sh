#!/usr/bin/env bash
# Firebase C++ SDK для Windows-сборки — заранее и с повторами.
#
# Плагин firebase_core качает этот архив сам (dl.google.com) одной попыткой,
# а сервер Google иногда отвечает 502 — и вся Windows-сборка падала. Здесь
# тот же архив той же версии, но с повторами; готовую папку плагин берёт из
# FIREBASE_CPP_SDK_DIR (см. firebase_core/windows/CMakeLists.txt). Не вышло —
# ничего не ломаем: плагин попробует скачать сам, как раньше.
set -u

lock_ver=$(awk '/^  firebase_core:/{f=1} f && /^    version:/{gsub(/"/, "", $2); print $2; exit}' pubspec.lock)
cache=$(cygpath -u "${PUB_CACHE:-$LOCALAPPDATA/Pub/Cache}" 2>/dev/null || echo "${PUB_CACHE:-}")
cmake_file="$cache/hosted/pub.dev/firebase_core-$lock_ver/windows/CMakeLists.txt"
ver=$(sed -n 's/.*set(FIREBASE_SDK_VERSION "\([0-9.]*\)").*/\1/p' "$cmake_file" 2>/dev/null | head -1)
if [ -z "$ver" ]; then
  echo "::warning::Не нашли версию Firebase C++ SDK ($cmake_file) — плагин скачает сам"
  exit 0
fi

dir="${RUNNER_TEMP:-/tmp}/firebase_cpp_sdk_$ver"
zip="$dir.zip"
url="https://dl.google.com/firebase/sdk/cpp/firebase_cpp_sdk_windows_$ver.zip"
if ! curl -fsSL --retry 6 --retry-all-errors --retry-delay 15 --connect-timeout 30 -o "$zip" "$url"; then
  echo "::warning::Firebase C++ SDK $ver не скачался и с повторами — плагин попробует сам"
  exit 0
fi

mkdir -p "$dir"
if command -v 7z >/dev/null 2>&1; then
  7z x -y -bd -o"$dir" "$zip" >/dev/null || { echo "::warning::Не распаковали Firebase C++ SDK"; exit 0; }
else
  unzip -q -o "$zip" -d "$dir" || { echo "::warning::Не распаковали Firebase C++ SDK"; exit 0; }
fi
rm -f "$zip"

sdk="$dir/firebase_cpp_sdk_windows"
if [ ! -f "$sdk/include/firebase/version.h" ]; then
  echo "::warning::В архиве Firebase C++ SDK нет include/firebase/version.h — плагин скачает сам"
  exit 0
fi
echo "FIREBASE_CPP_SDK_DIR=$(cygpath -m "$sdk" 2>/dev/null || echo "$sdk")" >> "$GITHUB_ENV"
echo "Firebase C++ SDK $ver готов: $sdk"
