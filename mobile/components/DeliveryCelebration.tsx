// DeliveryCelebration.tsx
// An MMO "level up" flourish, played when a driver submits a POD and the stop
// flips to Delivered. Built entirely on React Native's Animated API (no extra
// dependencies) and themed to Discra's dark-fantasy palette: a void-purple
// backdrop, a golden sigil, expanding rune rings, a radiant sunburst, and
// rising embers.
import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
  useWindowDimensions,
} from "react-native";

type Props = {
  /** Small line shown beneath the banner — typically the order reference. */
  reference?: string;
  /** Fired once the flourish has fully played (or is tapped) so the parent unmounts it. */
  onDone: () => void;
};

// ─── Dark-fantasy palette (matches DriverScreen) ──────────────────────────────
const VOID = "#070510";
const GOLD = "#C8973A";
const GOLD_BRIGHT = "#F5D98B";
const GOLD_PALE = "#F0C060";
const EMBER = "#E05A3B";
const CREAM = "#EDE0C4";
const PANEL = "#130F1A";
const MUTED = "#968AA8";

// react-native-web has no native animation module; fall back to the JS driver
// there so the flourish still plays in the web preview without warnings.
const NATIVE = Platform.OS !== "web";

const RAY_COUNT = 12; // 12 diameters → 24 visible spokes
const RAY_WIDTH = 3;
const EMBER_COUNT = 16;
const RING_COUNT = 3;
const RUNE = 168; // rotating rune-ring diameter
const RUNE_TICKS = 8;
const HOLD_MS = 1500; // time the banner holds before it dissolves

export default function DeliveryCelebration({ reference, onDone }: Props) {
  const { width, height } = useWindowDimensions();
  const reach = Math.max(width, height); // ray length spans the longer screen axis

  // ── Animation drivers ──────────────────────────────────────────────────────
  const backdrop = useRef(new Animated.Value(0)).current; // dim-in
  const burst = useRef(new Animated.Value(0)).current; // rays + rings + embers
  const emblem = useRef(new Animated.Value(0)).current; // central sigil spring
  const banner = useRef(new Animated.Value(0)).current; // text rise
  const exit = useRef(new Animated.Value(0)).current; // fade everything out
  const pulse = useRef(new Animated.Value(0)).current; // looping glow breath
  const spin = useRef(new Animated.Value(0)).current; // looping rune rotation

  // Fire onDone at most once, whether by timeout or by tap.
  const settled = useRef(false);
  const finishOnce = () => {
    if (settled.current) return;
    settled.current = true;
    onDone();
  };

  // Sunburst spoke angles (0–180°; each is a diameter, so it shows on both sides).
  const rayAngles = useMemo(
    () => Array.from({ length: RAY_COUNT }, (_, i) => (180 / RAY_COUNT) * i),
    []
  );

  // Rune-ring tick marks, placed around the ring and pointing outward.
  const ticks = useMemo(() => {
    const r = RUNE / 2 - 6;
    return Array.from({ length: RUNE_TICKS }, (_, i) => {
      const a = ((Math.PI * 2) / RUNE_TICKS) * i;
      return {
        left: RUNE / 2 + r * Math.cos(a) - 1.5,
        top: RUNE / 2 + r * Math.sin(a) - 6,
        rot: `${(180 / Math.PI) * a + 90}deg`,
      };
    });
  }, []);

  // Stable per-ember params (frozen on first render so they don't re-roll).
  const embers = useMemo(
    () =>
      Array.from({ length: EMBER_COUNT }, (_, i) => {
        const angle = ((Math.PI * 2) / EMBER_COUNT) * i + (Math.random() - 0.5) * 0.6;
        const dist = reach * (0.22 + Math.random() * 0.3);
        const size = 3 + Math.random() * 5;
        return {
          size,
          // Bias upward so the embers rise like sparks off a fire.
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist - reach * 0.12,
          delay: Math.random() * 0.22,
          warm: Math.random() > 0.5,
        };
      }),
    [reach]
  );

  useEffect(() => {
    // A short tactile "ding" on real devices (no-op / guarded off web).
    if (Platform.OS === "ios" || Platform.OS === "android") {
      Vibration.vibrate(Platform.OS === "android" ? [0, 35, 55, 80] : 45);
    }

    const breath = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE }),
      ])
    );
    const orbit = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: NATIVE })
    );
    breath.start();
    orbit.start();

    const intro = Animated.parallel([
      Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: NATIVE }),
      Animated.spring(emblem, { toValue: 1, friction: 5, tension: 70, useNativeDriver: NATIVE }),
      Animated.timing(burst, { toValue: 1, duration: 1100, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }),
      Animated.timing(banner, { toValue: 1, duration: 520, delay: 170, easing: Easing.out(Easing.back(1.7)), useNativeDriver: NATIVE }),
    ]);

    const sequence = Animated.sequence([
      intro,
      Animated.delay(HOLD_MS),
      Animated.timing(exit, { toValue: 1, duration: 360, easing: Easing.in(Easing.cubic), useNativeDriver: NATIVE }),
    ]);
    sequence.start(({ finished }) => {
      if (finished) finishOnce();
    });

    return () => {
      sequence.stop();
      breath.stop();
      orbit.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tap anywhere to dismiss early (drivers are busy) — fade then unmount.
  const dismiss = () => {
    Animated.timing(exit, {
      toValue: 1,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: NATIVE,
    }).start(finishOnce);
  };

  // ── Interpolations ─────────────────────────────────────────────────────────
  const rootOpacity = exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const backdropOpacity = backdrop.interpolate({ inputRange: [0, 1], outputRange: [0, 0.9] });

  const burstScale = burst.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1.15] });
  const burstSpin = burst.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "20deg"] });
  const burstOpacity = burst.interpolate({ inputRange: [0, 0.15, 0.7, 1], outputRange: [0, 0.55, 0.16, 0] });

  const flashScale = burst.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.2, 1.5, 1.9] });
  const flashOpacity = burst.interpolate({ inputRange: [0, 0.12, 0.35], outputRange: [0, 0.85, 0], extrapolate: "clamp" });

  const spinDeg = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const spinDegRev = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "-360deg"] });

  const emblemScale = emblem.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] });
  const emblemOpacity = emblem.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 1] });

  const glowScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const glowOpacity = Animated.multiply(
    emblemOpacity,
    pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.7] })
  );

  const bannerY = banner.interpolate({ inputRange: [0, 1], outputRange: [26, 0] });
  const dividerScale = banner.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: rootOpacity }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={dismiss}>
        {/* Dim the world */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOpacity }]}
        />

        {/* Radiant sunburst */}
        <View style={styles.fillCenter} pointerEvents="none">
          <Animated.View
            style={{
              width: reach,
              height: reach,
              opacity: burstOpacity,
              transform: [{ scale: burstScale }, { rotate: burstSpin }],
            }}
          >
            {rayAngles.map((deg, i) => (
              <View
                key={`ray-${i}`}
                style={[
                  styles.ray,
                  { height: reach, left: reach / 2 - RAY_WIDTH / 2, transform: [{ rotate: `${deg}deg` }] },
                ]}
              />
            ))}
          </Animated.View>
        </View>

        {/* Core flash */}
        <View style={styles.fillCenter} pointerEvents="none">
          <Animated.View style={[styles.flash, { opacity: flashOpacity, transform: [{ scale: flashScale }] }]} />
        </View>

        {/* Expanding rune rings */}
        {Array.from({ length: RING_COUNT }).map((_, k) => {
          const start = k * 0.12;
          const ringScale = burst.interpolate({
            inputRange: [start, 1],
            outputRange: [0.2, 2.6 + k * 0.5],
            extrapolate: "clamp",
          });
          const ringOpacity = burst.interpolate({
            inputRange: [start, start + 0.08, 0.7 + k * 0.08, 0.95],
            outputRange: [0, 0.8, 0.12, 0],
            extrapolate: "clamp",
          });
          return (
            <View key={`ring-${k}`} style={styles.fillCenter} pointerEvents="none">
              <Animated.View style={[styles.ring, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
            </View>
          );
        })}

        {/* Rising embers */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {embers.map((e, i) => {
            const cx = width / 2 - e.size / 2;
            const cy = height / 2 - e.size / 2;
            const tx = burst.interpolate({ inputRange: [e.delay, 1], outputRange: [cx, cx + e.dx], extrapolate: "clamp" });
            const ty = burst.interpolate({ inputRange: [e.delay, 1], outputRange: [cy, cy + e.dy], extrapolate: "clamp" });
            const op = burst.interpolate({
              inputRange: [e.delay, e.delay + 0.12, 0.75, 1],
              outputRange: [0, 1, 0.8, 0],
              extrapolate: "clamp",
            });
            const sc = burst.interpolate({ inputRange: [e.delay, 1], outputRange: [0.4, 1.1], extrapolate: "clamp" });
            return (
              <Animated.View
                key={`ember-${i}`}
                style={{
                  position: "absolute",
                  width: e.size,
                  height: e.size,
                  borderRadius: e.size / 2,
                  backgroundColor: e.warm ? EMBER : GOLD_PALE,
                  opacity: op,
                  transform: [{ translateX: tx }, { translateY: ty }, { scale: sc }],
                }}
              />
            );
          })}
        </View>

        {/* Emblem glow */}
        <View style={styles.fillCenter} pointerEvents="none">
          <Animated.View style={[styles.glow, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]} />
        </View>

        {/* Rotating rune ring */}
        <View style={styles.fillCenter} pointerEvents="none">
          <Animated.View
            style={[styles.runeRing, { opacity: emblemOpacity, transform: [{ scale: emblemScale }, { rotate: spinDeg }] }]}
          >
            {ticks.map((t, i) => (
              <View
                key={`tick-${i}`}
                style={[styles.runeTick, { left: t.left, top: t.top, transform: [{ rotate: t.rot }] }]}
              />
            ))}
          </Animated.View>
        </View>

        {/* Emblem core */}
        <View style={styles.fillCenter} pointerEvents="none">
          <Animated.View style={[styles.emblem, { opacity: emblemOpacity, transform: [{ scale: emblemScale }] }]}>
            <Animated.View style={[styles.emblemDashRing, { transform: [{ rotate: spinDegRev }] }]} />
            <Text style={styles.emblemGlyph}>✓</Text>
          </Animated.View>
        </View>

        {/* Banner */}
        <View
          style={[styles.bannerWrap, { top: height / 2 + RUNE / 2 + 18 }]}
          pointerEvents="none"
        >
          <Animated.Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={[styles.bannerTitle, { opacity: banner, transform: [{ translateY: bannerY }] }]}
          >
            DELIVERY COMPLETE
          </Animated.Text>
          <Animated.View style={[styles.divider, { opacity: banner, transform: [{ scaleX: dividerScale }] }]} />
          <Animated.Text style={[styles.bannerReward, { opacity: banner, transform: [{ translateY: bannerY }] }]}>
            ✦  STOP CLEARED  ✦
          </Animated.Text>
          {reference ? (
            <Animated.Text style={[styles.bannerRef, { opacity: banner }]} numberOfLines={1}>
              {reference}
            </Animated.Text>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    zIndex: 1000,
    elevation: 1000,
  },
  backdrop: {
    backgroundColor: VOID,
  },
  fillCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  ray: {
    position: "absolute",
    top: 0,
    width: RAY_WIDTH,
    borderRadius: RAY_WIDTH / 2,
    backgroundColor: "rgba(240,192,96,0.45)",
  },
  flash: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: GOLD_BRIGHT,
  },
  ring: {
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 2,
    borderColor: GOLD,
  },
  glow: {
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: GOLD,
    shadowColor: GOLD_PALE,
    shadowOpacity: 0.9,
    shadowRadius: 44,
    shadowOffset: { width: 0, height: 0 },
  },
  runeRing: {
    width: RUNE,
    height: RUNE,
    borderRadius: RUNE / 2,
    borderWidth: 1,
    borderColor: "rgba(200,151,58,0.5)",
  },
  runeTick: {
    position: "absolute",
    width: 3,
    height: 12,
    borderRadius: 1.5,
    backgroundColor: GOLD_PALE,
  },
  emblem: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: PANEL,
    borderWidth: 2,
    borderColor: GOLD,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: GOLD,
    shadowOpacity: 0.85,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
  },
  emblemDashRing: {
    position: "absolute",
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 1,
    borderColor: "rgba(245,217,139,0.45)",
    borderStyle: "dashed",
  },
  emblemGlyph: {
    fontSize: 62,
    fontWeight: "900",
    color: GOLD_BRIGHT,
    textShadowColor: "rgba(200,151,58,0.9)",
    textShadowRadius: 16,
    textShadowOffset: { width: 0, height: 0 },
    // Nudge the glyph optically centered inside the disc.
    marginTop: -2,
  },
  bannerWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 28,
  },
  bannerTitle: {
    color: GOLD_BRIGHT,
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: 2,
    textAlign: "center",
    textShadowColor: "rgba(200,151,58,0.85)",
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 0 },
  },
  divider: {
    height: 2,
    width: 220,
    marginVertical: 12,
    borderRadius: 1,
    backgroundColor: GOLD,
    opacity: 0.85,
  },
  bannerReward: {
    color: CREAM,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 4,
  },
  bannerRef: {
    color: MUTED,
    fontSize: 12,
    letterSpacing: 1,
    marginTop: 10,
  },
});
