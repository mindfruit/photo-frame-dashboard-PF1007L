package com.wesbos.homehq;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.Gravity;
import android.net.Uri;
import android.webkit.ValueCallback;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import android.text.InputType;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Full-screen kiosk WebView for the Home HQ wall tablet.
 * - Immersive mode hides the status + navigation bars (true 1280x800).
 * - Controls: hold two fingers still on the screen for 1.5s for launcher/settings/reload.
 * - Remote debugging is OFF unless launched with the debug extra (every app on this device
 *   gets root, so the devtools socket should only exist while actively debugging):
 *     adb shell am start -n com.wesbos.homehq/.MainActivity --ez debug true
 * - Set the URL (saved across reboots): adb shell am start -a android.intent.action.VIEW -d <url> -n com.wesbos.homehq/.MainActivity
 *   or two-finger hold -> Change dashboard URL.
 * - Kiosk exit PIN: if admin (Settings, or Screens > screen) sets one, the hold asks for it first.
 *   The app GETs <dashboard origin>/api/kiosk/config?device=<id> on start, on Reload and every 5 min,
 *   and caches {salt, pinHash} in SharedPreferences so it still works offline. The device id is
 *   ?device= in the dashboard URL, else the page's localStorage 'deviceId' (what /api/state uses).
 */
public class MainActivity extends Activity {
  static final String TAG = "HomeHQ";
  static final String DEFAULT_URL = "http://192.168.7.237:5173/";
  static final long EXIT_HOLD_MS = 1500;
  static final long RETRY_MS = 5000;
  static final float EXIT_SLOP_PX = 60;
  static final long PIN_REFRESH_MS = 5 * 60 * 1000;

  private WebView web;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final int[] exitIds = new int[2];
  private final float[] exitX = new float[2];
  private final float[] exitY = new float[2];
  private boolean exitArmed;
  private String retryUrl;

  private final Runnable retry = new Runnable() {
    @Override
    public void run() {
      if (retryUrl != null) web.loadUrl(retryUrl);
    }
  };

  private final Runnable refreshPin = new Runnable() {
    @Override
    public void run() {
      fetchKioskConfig();
      handler.removeCallbacks(this);
      handler.postDelayed(this, PIN_REFRESH_MS);
    }
  };

  private AlertDialog pinDialog;

  /** Two-finger hold: ask for the kiosk PIN first when one is set (or cached), else open the menu. */
  private final Runnable onHold = new Runnable() {
    @Override
    public void run() {
      exitArmed = false;
      if (prefs().getString("pin_hash", null) != null) showPinDialog();
      else showControls.run();
    }
  };

  private final Runnable showControls = new Runnable() {
    @Override
    public void run() {
      exitArmed = false;
      Log.i(TAG, "Two-finger hold: opening controls");
      new AlertDialog.Builder(MainActivity.this)
          .setTitle("Home HQ")
          .setItems(new String[] {"Open launcher", "Android settings", "Reload dashboard", "Change dashboard URL"},
              (dialog, which) -> {
                if (which == 0) openLauncher();
                else if (which == 1) startActivity(new Intent(Settings.ACTION_SETTINGS));
                else if (which == 2) { web.reload(); fetchKioskConfig(); }
                else editUrl();
              })
          .setNegativeButton("Back to dashboard", null).show();
    }
  };

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    applyDebugFlag(getIntent());
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        | WindowManager.LayoutParams.FLAG_FULLSCREEN);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setUseWideViewPort(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    // Keep navigation inside the kiosk. When the kiosk starts at boot before Wi-Fi is up, the
    // first load fails and would stay on the error page, so retry failed main-frame loads.
    web.setWebViewClient(new WebViewClient() {
      @Override
      @SuppressWarnings("deprecation")
      public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
        Log.w(TAG, "Load failed (" + desc + "), retrying in " + RETRY_MS + " ms");
        retryUrl = failingUrl;
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
      }

      @Override
      public void onPageFinished(WebView view, String loaded) {
        learnDeviceId();
      }
    });
    setContentView(web);

    String url = getIntent().getDataString();
    if (url != null) saveUrl(url);
    web.loadUrl(savedUrl());
    handler.post(refreshPin); // fetch now (cached id/URL), then every 5 min
  }

  @Override
  protected void onResume() {
    super.onResume();
    NavigationService.setDashboardVisible(true);
  }

  @Override
  protected void onPause() {
    cancelExit();
    NavigationService.setDashboardVisible(false);
    super.onPause();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    applyDebugFlag(intent);
    String url = intent.getDataString();
    if (url != null) {
      saveUrl(url);
      handler.removeCallbacks(retry);
      web.loadUrl(url);
      fetchKioskConfig();
    }
  }

  private SharedPreferences prefs() { return getSharedPreferences("kiosk", MODE_PRIVATE); }

  /** The last URL sent by intent or typed in the controls; survives reboots. */
  private String savedUrl() { return prefs().getString("url", DEFAULT_URL); }

  private void saveUrl(String url) { prefs().edit().putString("url", url).apply(); }

  private void editUrl() {
    final EditText field = new EditText(this);
    field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    field.setText(savedUrl());
    new AlertDialog.Builder(this)
        .setTitle("Dashboard URL")
        .setView(field)
        .setPositiveButton("Save", (d, w) -> {
          String url = field.getText().toString().trim();
          if (url.isEmpty()) return;
          if (!url.contains("://")) url = "http://" + url;
          saveUrl(url);
          handler.removeCallbacks(retry);
          web.loadUrl(url);
          fetchKioskConfig();
        })
        .setNegativeButton("Cancel", null).show();
  }

  // ------------------------------------------------------------------ kiosk exit PIN

  /** ?device= in the dashboard URL wins (same rule as js/data.js), else the id the page saved. */
  private String deviceId() {
    try {
      String q = Uri.parse(savedUrl()).getQueryParameter("device");
      if (q != null && !q.isEmpty()) return q;
    } catch (Exception ignored) { }
    return prefs().getString("device", null);
  }

  /** After a page load, read the page's localStorage deviceId so the PIN lookup uses this screen's override. */
  private void learnDeviceId() {
    web.evaluateJavascript("(function(){try{return localStorage.getItem('deviceId')}catch(e){return null}})()",
        new ValueCallback<String>() {
          @Override
          public void onReceiveValue(String v) {
            if (v == null || v.equals("null") || v.length() < 3) return;
            String id = v.substring(1, v.length() - 1); // JSON string -> plain (ids are [\w.-])
            if (!id.matches("[\\w.-]{1,64}")) return;
            if (!id.equals(prefs().getString("device", null))) {
              prefs().edit().putString("device", id).apply();
              fetchKioskConfig();
            }
          }
        });
  }

  /** GET <origin>/api/kiosk/config in the background; only a good answer changes the cache. */
  private void fetchKioskConfig() {
    final String base;
    try {
      Uri u = Uri.parse(savedUrl());
      if (u.getScheme() == null || u.getAuthority() == null) return;
      base = u.getScheme() + "://" + u.getAuthority();
    } catch (Exception e) { return; }
    final String id = deviceId();
    new Thread(new Runnable() {
      @Override
      public void run() {
        HttpURLConnection c = null;
        try {
          String q = id == null ? "" : "?device=" + Uri.encode(id);
          c = (HttpURLConnection) new URL(base + "/api/kiosk/config" + q).openConnection();
          c.setConnectTimeout(5000);
          c.setReadTimeout(5000);
          c.setUseCaches(false);
          if (c.getResponseCode() != 200) { Log.w(TAG, "Kiosk config HTTP " + c.getResponseCode()); return; }
          InputStream in = c.getInputStream();
          ByteArrayOutputStream out = new ByteArrayOutputStream();
          byte[] buf = new byte[1024];
          for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
          JSONObject j = new JSONObject(out.toString("UTF-8"));
          SharedPreferences.Editor ed = prefs().edit();
          // Admin 'Clear lockout': a new lockoutResetAt (server clock; compared only for change) ends any cooldown.
          long reset = j.optLong("lockoutResetAt", 0);
          if (reset > 0 && reset != prefs().getLong("lockout_seen", 0)) {
            ed.putLong("lockout_seen", reset).putInt("pin_fails", 0).putLong("pin_cooldown_until", 0);
            Log.i(TAG, "Kiosk PIN: lockout cleared by admin");
          }
          if (j.isNull("pin") || !j.optBoolean("pin", false)) {
            ed.remove("pin_salt").remove("pin_hash");
            Log.i(TAG, "Kiosk PIN: none set");
          } else {
            String salt = j.optString("salt", ""), hash = j.optString("pinHash", "");
            if (salt.isEmpty() || !hash.matches("[0-9a-fA-F]{64}")) { Log.w(TAG, "Kiosk config: bad hash"); return; }
            ed.putString("pin_salt", salt).putString("pin_hash", hash);
            Log.i(TAG, "Kiosk PIN: set (" + j.optString("scope", "?") + ")");
          }
          ed.apply();
        } catch (Exception e) {
          Log.w(TAG, "Kiosk config fetch failed, keeping cached PIN: " + e);
        } finally {
          if (c != null) c.disconnect();
        }
      }
    }).start();
  }

  private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

  /** Numeric keypad (masked). 3 wrong tries -> 30 s cooldown, stored in prefs so reopening doesn't reset it. */
  private void showPinDialog() {
    if (pinDialog != null && pinDialog.isShowing()) return;
    final StringBuilder typed = new StringBuilder();
    final TextView dots = new TextView(this);
    dots.setTextSize(28);
    dots.setGravity(Gravity.CENTER);
    dots.setMinHeight(dp(44));
    final TextView msg = new TextView(this);
    msg.setGravity(Gravity.CENTER);
    msg.setTextSize(15);
    final GridLayout pad = new GridLayout(this);
    pad.setColumnCount(3);
    final Button[] keys = new Button[12];
    String[] labels = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "\u232b", "0", "OK"};
    final Runnable[] tick = new Runnable[1];
    final Runnable redraw = new Runnable() {
      @Override
      public void run() {
        StringBuilder d = new StringBuilder();
        for (int i = 0; i < typed.length(); i++) d.append("\u25cf ");
        dots.setText(d.toString().trim());
      }
    };
    final Runnable checkCooldown = new Runnable() {
      @Override
      public void run() {
        long left = KioskPin.cooldownLeft(prefs().getLong("pin_cooldown_until", 0), System.currentTimeMillis());
        boolean locked = left > 0;
        for (Button b : keys) b.setEnabled(!locked);
        handler.removeCallbacks(tick[0]);
        if (locked) {
          msg.setText("Too many wrong tries. Try again in " + ((left + 999) / 1000) + " s");
          handler.postDelayed(tick[0], 250);
        } else if (msg.getText().toString().startsWith("Too many")) {
          msg.setText("Enter the kiosk PIN");
        }
      }
    };
    tick[0] = checkCooldown;
    for (int i = 0; i < 12; i++) {
      final String k = labels[i];
      Button b = new Button(this);
      b.setText(k);
      b.setTextSize(22);
      GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
      lp.width = dp(84);
      lp.height = dp(64);
      lp.setMargins(dp(4), dp(4), dp(4), dp(4));
      b.setLayoutParams(lp);
      b.setOnClickListener(new View.OnClickListener() {
        @Override
        public void onClick(View v) {
          if (k.equals("OK")) {
            SharedPreferences p = prefs();
            if (KioskPin.matches(p.getString("pin_salt", null), p.getString("pin_hash", null), typed.toString())) {
              p.edit().putInt("pin_fails", 0).putLong("pin_cooldown_until", 0).apply();
              Log.i(TAG, "Kiosk PIN ok");
              pinDialog.dismiss();
              showControls.run();
              return;
            }
            int fails = p.getInt("pin_fails", 0) + 1;
            typed.setLength(0);
            if (fails >= KioskPin.MAX_TRIES) {
              p.edit().putInt("pin_fails", 0).putLong("pin_cooldown_until", System.currentTimeMillis() + KioskPin.COOLDOWN_MS).apply();
            } else {
              p.edit().putInt("pin_fails", fails).apply();
              msg.setText("Wrong PIN (" + (KioskPin.MAX_TRIES - fails) + " left)");
            }
            checkCooldown.run();
          } else if (k.equals("\u232b")) {
            if (typed.length() > 0) typed.setLength(typed.length() - 1);
          } else if (typed.length() < 8) {
            typed.append(k);
          }
          redraw.run();
        }
      });
      keys[i] = b;
      pad.addView(b);
    }
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER_HORIZONTAL);
    box.setPadding(dp(16), dp(8), dp(16), dp(8));
    box.addView(msg);
    box.addView(dots);
    box.addView(pad);
    msg.setText("Enter the kiosk PIN");
    pinDialog = new AlertDialog.Builder(this)
        .setTitle("Home HQ")
        .setView(box)
        .setNegativeButton("Back to dashboard", null)
        .create();
    pinDialog.setOnDismissListener(new android.content.DialogInterface.OnDismissListener() {
      @Override
      public void onDismiss(android.content.DialogInterface d) {
        handler.removeCallbacks(tick[0]);
        hideSystemUi();
      }
    });
    pinDialog.setCanceledOnTouchOutside(false);
    pinDialog.show();
    checkCooldown.run();
  }

  private void openLauncher() {
    Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
    for (ResolveInfo info : getPackageManager().queryIntentActivities(home, 0)) {
      String pkg = info.activityInfo.packageName;
      if (pkg.equals(getPackageName()) || pkg.equals("com.android.settings")) continue;
      startActivity(new Intent(home).setComponent(new ComponentName(pkg, info.activityInfo.name)));
      return;
    }
    startActivity(new Intent(Settings.ACTION_SETTINGS));
  }

  @Override
  protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    if (pinDialog != null) pinDialog.dismiss();
    if (web != null) web.destroy();
    super.onDestroy();
  }

  /** Remote debugging only when explicitly requested; any normal launch turns it back off. */
  private void applyDebugFlag(Intent intent) {
    boolean debug = intent != null && intent.getBooleanExtra("debug", false);
    WebView.setWebContentsDebuggingEnabled(debug);
    Log.i(TAG, "WebView remote debugging " + (debug ? "ON" : "off"));
  }

  /** Watches for the two-finger exit hold; all touches still go to the page. */
  @Override
  public boolean dispatchTouchEvent(MotionEvent e) {
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_POINTER_DOWN:
        if (e.getPointerCount() == 2) {
          for (int i = 0; i < 2; i++) {
            exitIds[i] = e.getPointerId(i);
            exitX[i] = e.getX(i);
            exitY[i] = e.getY(i);
          }
          exitArmed = true;
          handler.removeCallbacks(showControls);
          handler.postDelayed(onHold, EXIT_HOLD_MS);
        } else {
          cancelExit(); // 3+ fingers
        }
        break;
      case MotionEvent.ACTION_MOVE:
        if (exitArmed) {
          for (int i = 0; i < 2; i++) {
            int idx = e.findPointerIndex(exitIds[i]);
            if (idx < 0 || Math.hypot(e.getX(idx) - exitX[i], e.getY(idx) - exitY[i]) > EXIT_SLOP_PX) {
              cancelExit();
              break;
            }
          }
        }
        break;
      case MotionEvent.ACTION_POINTER_UP:
      case MotionEvent.ACTION_UP:
      case MotionEvent.ACTION_CANCEL:
        cancelExit();
        break;
      default:
        break;
    }
    return super.dispatchTouchEvent(e);
  }

  private void cancelExit() {
    if (!exitArmed) return;
    exitArmed = false;
    handler.removeCallbacks(onHold);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemUi();
  }

  private void hideSystemUi() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
  }
}
