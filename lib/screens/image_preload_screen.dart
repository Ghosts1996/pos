import 'package:flutter/material.dart';
import '../services/image_preload_service.dart';
import 'login_screen.dart';
import '../theme/app_colors.dart';

/// Заставка на долю секунды: экран входа открывается сразу, а кэш фото
/// меню прогревается в фоне (ImagePreloadService).
class ImagePreloadScreen extends StatefulWidget {
  const ImagePreloadScreen({super.key});

  @override
  State<ImagePreloadScreen> createState() => _ImagePreloadScreenState();
}

class _ImagePreloadScreenState extends State<ImagePreloadScreen> {
  bool _loginShown = false;

  @override
  void initState() {
    super.initState();
    // Сразу переходим на экран входа, не дожидаясь ни кадра отрисовки этого
    // экрана и уж тем более прогрева кэша. Специально используем push, а не
    // pushReplacement: этот экран остаётся смонтированным (просто скрытым
    // под экраном входа) — иначе его BuildContext уничтожился бы вместе с
    // виджетом, а фоновому прогреву кэша (precacheImage) нужен живой
    // context на всё время скачивания.
    WidgetsBinding.instance.addPostFrameCallback((_) => _showLogin());
    // Прогрев кэша фото — полностью в фоне, не блокирует UI.
    _warmUpInBackground();
  }

  void _showLogin() {
    if (!mounted) return;
    _loginShown = true;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => const LoginScreen()));
  }

  Future<void> _warmUpInBackground() async {
    if (!mounted) return;
    try {
      await ImagePreloadService()
          .preloadAll(context)
          .timeout(const Duration(seconds: 40), onTimeout: () {});
    } catch (_) {
      // Фоновый прогрев — любая ошибка (нет сети и т.п.) просто
      // игнорируется, на работу приложения это не влияет.
    }
  }

  @override
  Widget build(BuildContext context) {
    // Экран, лежавший поверх, закрыли (жест «Назад» и т.п.) — заставка не
    // должна оставаться тупиком: снова открываем вход.
    if (_loginShown && (ModalRoute.of(context)?.isCurrent ?? false)) {
      _loginShown = false;
      WidgetsBinding.instance.addPostFrameCallback((_) => _showLogin());
    }
    // Виден долю секунды — хватает логотипа, без прогресс-бара.
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: Image.asset('assets/icon/icon.png', width: 72, height: 72),
      ),
    );
  }
}