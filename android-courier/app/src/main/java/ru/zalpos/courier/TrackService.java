package ru.zalpos.courier;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Смена курьера: точка телефона идёт на сервер ZalPOS (api/ping) и при
 * выключенном экране — служба переднего плана с уведомлением «Вы на линии».
 * Точки копятся без связи и уходят пачкой, как в веб-приложении.
 * Сервер ответил «смена закрыта» или ключ недействителен — служба сама
 * останавливается. Координаты уходят только на наш сервер.
 *
 * Новые заказы: вместе с точками служба спрашивает у нашего сервера «что
 * нового» (news) и, если приложение закрыто, показывает уведомление со
 * звуком — «Вам назначен заказ №N» или «Новый заказ №N». Без сервисов
 * Google: уведомление рисует сам телефон, в нём только номер заказа.
 */
public class TrackService extends Service implements LocationListener {
    private static final String PREFS = "track";
    private static final String CHANNEL = "track";
    private static final int NOTE_ID = 7;
    private static final long MIN_TIME_MS = 5000;
    private static final float MIN_DIST_M = 10f;
    private static final long SEND_EVERY_MS = 20000;
    private static final int MAX_BUFFER = 600;

    private static volatile boolean running = false;
    private static final String ORDERS = "orders";

    /** Приложение на экране — уведомления не нужны, оно звучит само. */
    public static volatile boolean appVisible = false;

    /** Первый ответ после запуска — запоминаем, что уже есть, без уведомлений. */
    private boolean newsBaseline = true;

    private final List<JSONObject> buffer = new ArrayList<>();
    private HandlerThread thread;
    private Handler handler;
    private LocationManager lm;
    private PowerManager.WakeLock wake;
    private String token;
    private String apiBase;
    private Location last;
    private boolean sending = false;

    public static boolean isRunning() {
        return running;
    }

    public static void start(Context ctx, String token, String apiBase) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString("token", token).putString("base", apiBase).putBoolean("on", true).apply();
        Intent i = new Intent(ctx, TrackService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    public static void stop(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("on", false).remove("token").apply();
        ctx.stopService(new Intent(ctx, TrackService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("zalpos-track");
        thread.start();
        handler = new Handler(thread.getLooper());
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        token = p.getString("token", null);
        apiBase = p.getString("base", null);
        boolean ok = p.getBoolean("on", false) && token != null && apiBase != null && hasLocation();
        try {
            showForeground();
        } catch (RuntimeException e) {
            // Нет разрешения на геолокацию (отозвали) — смену в фоне не ведём.
            ok = false;
        }
        if (!ok) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zalpos:courier");
            wake.setReferenceCounted(false);
            wake.acquire(14 * 3600 * 1000L);
            requestUpdates();
            handler.postDelayed(sender, SEND_EVERY_MS);
        }
        // Система перезапустит службу, если её выгрузили, — смена продолжится.
        return START_STICKY;
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void showForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(getString(R.string.track_title))
            .setContentText(getString(R.string.track_text))
            .setContentIntent(pi)
            .setOngoing(true)
            .setShowWhen(false)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTE_ID, n);
    }

    @SuppressWarnings("MissingPermission")
    private void requestUpdates() {
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_TIME_MS, MIN_DIST_M, this, thread.getLooper());
            }
        } catch (Exception ignored) {
            // нет GPS — останется сеть
        }
        try {
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, MIN_TIME_MS * 2, MIN_DIST_M, this, thread.getLooper());
            }
        } catch (Exception ignored) {
            // нет определения по сети
        }
    }

    @Override
    public void onLocationChanged(Location loc) {
        // Сеть даёт грубую точку — не перебиваем ею свежую точку со спутников.
        if (last != null && LocationManager.NETWORK_PROVIDER.equals(loc.getProvider())
            && LocationManager.GPS_PROVIDER.equals(last.getProvider())
            && loc.getTime() - last.getTime() < 30000) return;
        // Как в веб-приложении: каждые 15 с или при сдвиге на 25 м.
        if (last != null && loc.getTime() - last.getTime() < 15000 && loc.distanceTo(last) < 25) return;
        last = loc;
        try {
            JSONObject o = new JSONObject();
            o.put("lat", loc.getLatitude());
            o.put("lng", loc.getLongitude());
            o.put("acc", Math.round(loc.hasAccuracy() ? loc.getAccuracy() : 9999));
            o.put("at", System.currentTimeMillis());
            synchronized (buffer) {
                buffer.add(o);
                while (buffer.size() > MAX_BUFFER) buffer.remove(0);
            }
        } catch (Exception ignored) {
            // точка без координат
        }
        if (buffer.size() >= 30) handler.post(this::flush);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
    }

    @Override
    public void onProviderEnabled(String provider) {
    }

    @Override
    public void onProviderDisabled(String provider) {
    }

    private final Runnable sender = new Runnable() {
        @Override
        public void run() {
            flush();
            if (running) handler.postDelayed(this, SEND_EVERY_MS);
        }
    };

    /** Отправка пачкой. Без связи — точки ждут следующей попытки. */
    private void flush() {
        if (sending) return;
        List<JSONObject> batch;
        synchronized (buffer) {
            // Пустая пачка тоже уходит: в ответе — новые заказы.
            batch = new ArrayList<>(buffer.subList(0, Math.min(300, buffer.size())));
        }
        sending = true;
        HttpURLConnection c = null;
        try {
            JSONArray arr = new JSONArray();
            for (JSONObject o : batch) arr.put(o);
            byte[] body = new JSONObject().put("points", arr).put("news", true).toString().getBytes(StandardCharsets.UTF_8);
            URL url = new URL(apiBase + (apiBase.endsWith("/") ? "" : "/") + "api/ping");
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body);
            }
            int code = c.getResponseCode();
            if (code == 401 || code == 403) {
                finish();
                return;
            }
            if (code >= 200 && code < 300) {
                synchronized (buffer) {
                    buffer.subList(0, Math.min(batch.size(), buffer.size())).clear();
                }
                String text = read(c.getInputStream());
                JSONObject reply = new JSONObject(text);
                if (reply.optBoolean("off", false)) finish();
                else handleNews(reply.optJSONObject("news"));
            }
        } catch (Exception ignored) {
            // нет связи — повторим
        } finally {
            sending = false;
            if (c != null) c.disconnect();
        }
    }

    /** Новые заказы с прошлого ответа — уведомление, если приложение закрыто. */
    private void handleNews(JSONObject news) {
        if (news == null) return;
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        Set<String> seenMine = new HashSet<>(p.getStringSet("seenMine", new HashSet<>()));
        Set<String> seenFree = new HashSet<>(p.getStringSet("seenFree", new HashSet<>()));
        Set<String> mine = new HashSet<>();
        Set<String> free = new HashSet<>();
        List<String> newMine = new ArrayList<>();
        List<String> newFree = new ArrayList<>();
        JSONArray m = news.optJSONArray("mine");
        for (int i = 0; m != null && i < m.length(); i++) {
            JSONObject o = m.optJSONObject(i);
            if (o == null) continue;
            String key = o.optString("key");
            mine.add(key);
            if (!seenMine.contains(key)) newMine.add(o.optString("no"));
        }
        JSONArray f = news.optJSONArray("free");
        for (int i = 0; f != null && i < f.length(); i++) {
            JSONObject o = f.optJSONObject(i);
            if (o == null) continue;
            String key = o.optString("key");
            free.add(key);
            if (!seenFree.contains(key)) newFree.add(o.optString("no"));
        }
        p.edit().putStringSet("seenMine", mine).putStringSet("seenFree", free).apply();
        boolean first = newsBaseline;
        newsBaseline = false;
        if (first || appVisible) return;
        if (!newMine.isEmpty()) {
            notifyOrders(101, newMine.size() == 1 ? "Вам назначен заказ №" + newMine.get(0) : "Вам назначены заказы: " + android.text.TextUtils.join(", ", newMine),
                "Откройте приложение — заказ в «Мои поездки»");
        }
        if (!newFree.isEmpty()) {
            notifyOrders(102, newFree.size() == 1 ? "Новый заказ №" + newFree.get(0) : "Новых заказов: " + newFree.size(),
                "Свободен — нажмите, чтобы взять");
        }
    }

    private void notifyOrders(int id, String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(ORDERS, getString(R.string.channel_orders), NotificationManager.IMPORTANCE_HIGH);
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[] {0, 300, 150, 300});
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, ORDERS) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE);
        if (Build.VERSION.SDK_INT < 26) {
            b.setDefaults(Notification.DEFAULT_ALL).setPriority(Notification.PRIORITY_HIGH);
        }
        try {
            nm.notify(id, b.build());
        } catch (SecurityException ignored) {
            // Уведомления запрещены в настройках телефона.
        }
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    /** Смена закрыта на сервере или ключ отозван. */
    private void finish() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("on", false).remove("token").apply();
        new Handler(Looper.getMainLooper()).post(this::stopSelf);
    }

    @Override
    public void onDestroy() {
        running = false;
        try {
            lm.removeUpdates(this);
        } catch (Exception ignored) {
            // уже сняты
        }
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
            handler.post(this::flush);
        }
        if (thread != null) thread.quitSafely();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
