import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/utils/pii_scrub.dart';

void main() {
  test('телефоны, почта, карта, СНИЛС, ИНН вычищаются; суммы, столы, время — нет', () {
    expect(PiiScrub.text('Позвоните +7 (900) 123-45-67 или 8 912 345 67 89, почта ivan@mail.ru, карта 4276 1600 1234 5678'),
        'Позвоните [телефон] или [телефон], почта [почта], карта [номер]');
    expect(PiiScrub.text('СНИЛС 123-456-789 01, ИНН 151211052290, номер 9001234567'), 'СНИЛС [номер], ИНН [номер], номер [телефон]');
    const plain = 'Стол 12, счёт 3500 ₽, 2 гостя, бронь на 19:30 14.11.2026, чек №1045, 250 г';
    expect(PiiScrub.text(plain), plain);
  });

  test('тело запроса к ИИ: текст сообщений чистится, служебные поля и картинки — нет', () {
    final out = PiiScrub.payload({
      'model': 'gpt-4o',
      'messages': [
        {'role': 'user', 'content': 'тел 89001234567'},
        {'role': 'user', 'content': [{'type': 'text', 'text': 'a@b.ru'}, {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,89001234567'}}]},
      ],
      'max_tokens': 900,
    }) as Map;
    expect(out['model'], 'gpt-4o');
    expect(out['max_tokens'], 900);
    final m = out['messages'] as List;
    expect((m[0] as Map)['content'], 'тел [телефон]');
    final parts = (m[1] as Map)['content'] as List;
    expect((parts[0] as Map)['text'], '[почта]');
    expect(((parts[1] as Map)['image_url'] as Map)['url'], 'data:image/png;base64,89001234567');
  });
}
