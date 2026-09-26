import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/services/ai/ai_settings.dart';

void main() {
  group('AiSettings.fromMap', () {
    test('старый формат (один шлюз с ключом в aiSettings) переносится в провайдера по адресу', () {
      final s = AiSettings.fromMap({
        'enabled': true,
        'apiKey': 'old-key',
        'baseUrl': 'https://api.tooken.club/v1/',
        'model': 'gpt-4o-mini',
      });
      expect(s.vendor, AiVendors.tooken.id);
      expect(s.isReady, isTrue);
      expect(s.primary.apiKey, 'old-key');
      expect(s.primary.model, 'gpt-4o-mini');
      expect(s.primary.analyticsModel, 'gpt-4o-mini');
      expect(s.primary.baseUrl, 'https://api.tooken.club/v1');
    });

    test('старый адрес DarkAPI/Gemini распознаётся как свой провайдер', () {
      expect(AiSettings.fromMap({'apiKey': 'k', 'baseUrl': 'https://darkapi.shop/v1'}).vendor, AiVendors.darkapi.id);
      expect(
        AiSettings.fromMap({'apiKey': 'k', 'baseUrl': 'https://generativelanguage.googleapis.com/v1beta/openai'}).vendor,
        AiVendors.gemini.id,
      );
      final custom = AiSettings.fromMap({'apiKey': 'k', 'baseUrl': 'https://proxy.example/v1', 'provider': 'anthropic'});
      expect(custom.vendor, AiVendors.custom.id);
      expect(custom.primary.format, 'anthropic');
    });

    test('неизвестный провайдер в документе не ломает настройки', () {
      final s = AiSettings.fromMap({'vendor': 'nope', 'apiKey': 'k'});
      expect(s.vendor, AiVendors.tooken.id);
      expect(s.vendors.keys, everyElement(isIn(AiVendors.all.map((v) => v.id))));
    });

    test('новый формат: публичная часть + ключи из aiSecrets, адрес по умолчанию у провайдера', () {
      final s = AiSettings.fromMap(
        {
          'enabled': true,
          'vendor': 'darkapi',
          'fallbackVendor': 'gemini',
          'vendors': {
            'darkapi': {'model': 'gpt-4o-mini', 'hasKey': true},
            'gemini': {'model': 'gemini-flash-latest', 'hasKey': true},
          },
        },
        secrets: {
          'vendors': {
            'darkapi': {'apiKey': 'dk', 'baseUrl': ''},
            'gemini': {'apiKey': 'gk', 'baseUrl': ''},
          },
        },
      );
      expect(s.primary.vendor.id, 'darkapi');
      expect(s.primary.baseUrl, AiVendors.darkapi.baseUrl);
      expect(s.primary.apiKey, 'dk');
      expect(s.fallback, isNotNull);
      expect(s.fallback!.vendor.id, 'gemini');
      expect(s.fallback!.slot, 'fallback');
      expect(s.fallback!.apiKey, 'gk');
      expect(s.fallback!.model, 'gemini-flash-latest');
    });

    test('гость без доступа к aiSecrets видит, что ИИ готов (hasKey), но не видит ключ', () {
      final s = AiSettings.fromMap({
        'enabled': true,
        'vendor': 'gemini',
        'vendors': {
          'gemini': {'model': 'gemini-flash-latest', 'hasKey': true},
        },
      });
      expect(s.isReady, isTrue);
      expect(s.primary.apiKey, isEmpty);
    });

    test('гость со «Своим шлюзом» тоже видит, что ИИ готов (адрес знает только сервер)', () {
      final guest = AiSettings.fromMap({
        'enabled': true,
        'vendor': 'custom',
        'vendors': {
          'custom': {'hasKey': true},
        },
      });
      expect(guest.isReady, isTrue);
      // А у персонала без адреса своего шлюза — не готово: запрос некуда слать.
      final staff = AiSettings.fromMap(
        {'enabled': true, 'vendor': 'custom', 'vendors': {}},
        secrets: {
          'vendors': {
            'custom': {'apiKey': 'k', 'baseUrl': ''},
          },
        },
      );
      expect(staff.isReady, isFalse);
    });

    test('резервный провайдер без ключа или совпадающий с основным не используется', () {
      final noKey = AiSettings.fromMap({
        'enabled': true,
        'vendor': 'tooken',
        'fallbackVendor': 'gemini',
        'vendors': {
          'tooken': {'hasKey': true},
        },
      });
      expect(noKey.fallback, isNull);
      final same = AiSettings.fromMap({
        'enabled': true,
        'vendor': 'gemini',
        'fallbackVendor': 'gemini',
        'vendors': {
          'gemini': {'hasKey': true},
        },
      });
      expect(same.fallback, isNull);
    });
  });

  group('AiSettings: сохранение', () {
    test('в публичную часть не попадают ни ключи, ни адреса', () {
      final s = AiSettings.fromMap(
        {'enabled': true, 'vendor': 'custom', 'vendors': {}},
        secrets: {
          'vendors': {
            'custom': {'apiKey': 'secret', 'baseUrl': 'https://proxy.example/v1'},
          },
        },
      );
      final pub = s.toPublicMap();
      final flat = pub.toString();
      expect(flat.contains('secret'), isFalse);
      expect(flat.contains('proxy.example'), isFalse);
      expect(pub.containsKey('apiKey'), isFalse);
      expect((pub['vendors'] as Map)['custom']['hasKey'], isTrue);
      final sec = s.toSecretsMap();
      expect((sec['vendors'] as Map)['custom'], {'apiKey': 'secret', 'baseUrl': 'https://proxy.example/v1'});
    });

    test('публичная часть и ключи вместе дают те же настройки', () {
      final original = AiSettings.fromMap(
        {
          'enabled': true,
          'vendor': 'gemini',
          'fallbackVendor': 'darkapi',
          'maxTokens': 1500,
          'vendors': {
            'gemini': {'model': 'gemini-2.5-flash', 'analyticsModel': 'gemini-2.5-pro', 'hasKey': true},
          },
        },
        secrets: {
          'vendors': {
            'gemini': {'apiKey': 'gk', 'baseUrl': ''},
            'darkapi': {'apiKey': 'dk', 'baseUrl': ''},
          },
        },
      );
      final restored = AiSettings.fromMap(original.toPublicMap(), secrets: original.toSecretsMap());
      expect(restored.vendor, 'gemini');
      expect(restored.maxTokens, 1500);
      expect(restored.primary.model, 'gemini-2.5-flash');
      expect(restored.primary.analyticsModel, 'gemini-2.5-pro');
      expect(restored.fallback?.vendor.id, 'darkapi');
      expect(restored.fallback?.apiKey, 'dk');
    });
  });
}
