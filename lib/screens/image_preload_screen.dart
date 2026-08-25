import 'package:flutter/material.dart';
import '../services/image_preload_service.dart';
import 'login_screen.dart';

/// Показывается один раз при каждом запуске приложения, сразу после
/// инициализации Firebase, и заранее прогревает дисковый кэш всех фото
/// категорий и позиций меню (см. ImagePreloadService).
///
/// При первом запуске на устройстве это реально качает все фото — экран
/// покажет прогресс "Фото меню: N из M". На всех последующих запусках фото
/// уже лежат в дисковом кэше, поэтому проверка пролетает почти мгновенно
/// и экран входа открывается без задержки.
///
/// Общий таймаут на 40 секунд гарантирует, что даже при очень плохой сети
/// или большом количестве фото приложение всё равно откроется, а не
/// "зависнет" на этом экране — оставшиеся фото просто догрузятся по месту
/// использования, как и раньше.
class ImagePreloadScreen extends StatefulWidget {
  const ImagePreloadScreen({super.key});

  @override
  State<ImagePreloadScreen> createState() => _ImagePreloadScreenState();
}

class _ImagePreloadScreenState extends State<ImagePreloadScreen> {
  int _done = 0;
  int _total = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run());
  }

  Future<void> _run() async {
    await ImagePreloadService()
        .preloadAll(
          context,
          onProgress: (done, total) {
            if (!mounted) return;
            setState(() {
              _done = done;
              _total = total;
            });
          },
        )
        .timeout(const Duration(seconds: 40), onTimeout: () {});
    if (!mounted) return;
    Navigator.of(context)
        .pushReplacement(MaterialPageRoute(builder: (_) => const LoginScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final progress = _total == 0 ? null : _done / _total;
    return Scaffold(
      backgroundColor: const Color(0xFF1B1B1F),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.smoking_rooms, color: Colors.white70, size: 56),
            const SizedBox(height: 12),
            const Text('Hookah POS',
                style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 24),
            SizedBox(
              width: 180,
              child: LinearProgressIndicator(
                value: progress,
                backgroundColor: Colors.white12,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              _total == 0 ? 'Загрузка…' : 'Фото меню: $_done из $_total',
              style: const TextStyle(color: Colors.white70, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}