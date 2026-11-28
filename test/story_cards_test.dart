import 'package:flutter_test/flutter_test.dart';
import 'package:hookah_pos/models/menu_models.dart';
import 'package:hookah_pos/services/ai/ai_agents.dart';

// Лента для гостей (SaaS): фото карточек — из меню, без табака и алкоголя,
// без «хитов продаж» в подсказке ИИ.
void main() {
  MenuItem item(String id, String name, {String img = ''}) =>
      MenuItem(id: id, categoryId: 'c', name: name, price: 290, imageUrl: img);
  final menu = [
    (item: item('s1', 'Сырники', img: 'https://x/s.jpg'), category: 'Завтраки', categoryImage: ''),
    (item: item('p1', 'Паста карбонара'), category: 'Горячее', categoryImage: 'https://x/hot.jpg'),
    (item: item('l1', 'Лимонад манго'), category: 'Напитки', categoryImage: ''),
  ];

  test('фото по id от ИИ, по названию в тексте и фото категории', () {
    final out = AiService.attachMenuPhotos([
      const StoryDraft(title: 'Сырники к кофе', text: 'Пышные, со сметаной', action: 'menu', menuItemId: 's1'),
      const StoryDraft(title: 'Тёплый вечер', text: 'Паста карбонара — сливочная и сытная', action: 'menu'),
      const StoryDraft(title: 'Стол на вечер', text: 'Забронируйте заранее', action: 'booking'),
    ], menu);
    expect(out, hasLength(3));
    expect(out[0].imageUrl, 'https://x/s.jpg');
    expect(out[1].menuItemId, 'p1');
    expect(out[1].imageUrl, 'https://x/hot.jpg');
    expect(out[2].imageUrl, isEmpty);
  });

  test('алкоголь, табак и позиции не из разрешённого меню — выбрасываются', () {
    final out = AiService.attachMenuPhotos([
      const StoryDraft(title: 'Пиво к снекам', text: 'Светлое фильтрованное за 250 ₽', action: 'menu'),
      const StoryDraft(title: 'Новый кальян', text: 'Ягодный микс', action: 'menu'),
      const StoryDraft(title: 'Что-то', text: 'Позиция', action: 'menu', menuItemId: 'beer-id'),
      const StoryDraft(title: 'Лимонад манго', text: 'Безалкогольный и холодный', action: 'menu', menuItemId: 'l1'),
    ], menu);
    expect(out.map((d) => d.menuItemId), ['l1']);
  });

  test('одна позиция — одна карточка; «[id:…]» от модели понимается', () {
    final d = StoryDraft.fromMap({'title': 'Сырники', 'text': 'Тёплые', 'action': 'menu', 'menuItemId': '[id:s1]'});
    expect(d.menuItemId, 's1');
    final out = AiService.attachMenuPhotos([d, d], menu);
    expect(out, hasLength(1));
  });

  test('в меню для ИИ — пометка фото, без слов о рейтинге продаж', () {
    final text = AiService.storyMenuText(menu);
    expect(text, contains('[есть фото]'));
    expect(text.split('\n').first, contains('Сырники'));
    expect(text, isNot(contains('хит')));
  });
}
