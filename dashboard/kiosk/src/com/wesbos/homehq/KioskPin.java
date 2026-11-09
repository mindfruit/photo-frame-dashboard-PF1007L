package com.wesbos.homehq;

import java.nio.charset.Charset;
import java.security.MessageDigest;

/** Kiosk exit PIN check, kept free of Android classes so it can be unit-tested with plain java. */
final class KioskPin {
  static final int MAX_TRIES = 3;
  static final long COOLDOWN_MS = 30000;

  private KioskPin() {}

  /** Same as the server: hex(sha256(salt + ":" + pin)). */
  static String hash(String salt, String pin) {
    try {
      byte[] d = MessageDigest.getInstance("SHA-256").digest((salt + ":" + pin).getBytes(Charset.forName("UTF-8")));
      StringBuilder sb = new StringBuilder(d.length * 2);
      for (byte b : d) sb.append(String.format("%02x", b & 0xff));
      return sb.toString();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }

  /** Constant-time compare of the typed PIN against the cached hash. */
  static boolean matches(String salt, String pinHash, String pin) {
    if (salt == null || pinHash == null || pin == null || pin.isEmpty()) return false;
    Charset u = Charset.forName("UTF-8");
    return MessageDigest.isEqual(hash(salt, pin).getBytes(u), pinHash.toLowerCase().getBytes(u));
  }

  /** Remaining cooldown; a stored end time far in the future (clock changed) is clamped to one cooldown. */
  static long cooldownLeft(long until, long now) {
    long left = until - now;
    if (left <= 0) return 0;
    return Math.min(left, COOLDOWN_MS);
  }
}
