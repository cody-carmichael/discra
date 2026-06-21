// App.tsx — Auth gateway + workspace router for Discra Mobile
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { apiRequest, decodeJwtPayload, extractTokenGroups, extractUsername, getTokenExp, isTokenExpired, normalizeApiBase } from "./lib";
import AdminScreen from "./screens/AdminScreen";
import DriverScreen from "./screens/DriverScreen";

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "discra_mobile_config_v4";
const STORAGE_PKCE_KEY = "discra_mobile_pkce_v1";
// When running the web preview locally (expo start --web on localhost), point
// at the local FastAPI backend so dev-only endpoints (e.g. /admin/simulator/*)
// are reachable. All other contexts use the deployed dev API.
const DEFAULT_API_BASE =
  Platform.OS === "web" &&
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:8000/dev/backend"
    : "https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev/backend";
const DEFAULT_COGNITO_USER_POOL_ID = "us-east-1_vMav7IRF7";
const DEFAULT_COGNITO_CLIENT_ID = "4gq64lj8ndo8pltt6hj5ritqi";

// Used only for the Hosted UI fallback in Advanced settings.
const REDIRECT_URI =
  Platform.OS === "web" && typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}`
    : "discra-mobile://auth/callback";

type Workspace = "admin" | "driver";

type PkceSession = {
  state: string;
  verifier: string;
  domain: string;
  clientId: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function looksLikeJwt(token: string): boolean {
  return (token || "").trim().split(".").length >= 2;
}

function normalizeDomain(value: string): string {
  return (value || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function parseQueryParams(url: string): URLSearchParams {
  const qi = url.indexOf("?");
  if (qi < 0) return new URLSearchParams();
  const hi = url.indexOf("#", qi);
  const query = hi >= 0 ? url.slice(qi + 1, hi) : url.slice(qi + 1);
  return new URLSearchParams(query);
}

function parseHashParams(url: string): URLSearchParams {
  const hi = url.indexOf("#");
  if (hi < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(hi + 1));
}

function toBase64Url(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== "function") throw new Error("btoa required");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return globalThis.btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomStr(n: number): string {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += alpha[b % alpha.length];
  return s;
}

async function buildPkce(verifier: string): Promise<{ challenge: string; method: "S256" | "plain" }> {
  try {
    const input = new Uint8Array(verifier.length);
    for (let i = 0; i < verifier.length; i++) input[i] = verifier.charCodeAt(i);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
    return { challenge: toBase64Url(new Uint8Array(digest)), method: "S256" };
  } catch {
    return { challenge: verifier, method: "plain" };
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [token, setToken] = useState("");
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [cognitoClientId] = useState(DEFAULT_COGNITO_CLIENT_ID);
  const [cognitoUserPoolId] = useState(DEFAULT_COGNITO_USER_POOL_ID);
  const [cognitoDomain, setCognitoDomain] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>("driver");
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  // Login state
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Token groups
  const tokenGroups = useMemo(() => extractTokenGroups(token), [token]);
  const isDriver = tokenGroups.includes("Driver");
  const isAdmin = tokenGroups.includes("Admin") || tokenGroups.includes("Dispatcher");
  const username = useMemo(() => extractUsername(token), [token]);
  const simulatorEnabled = username === "cody.carmichael";

  // Auto-select workspace based on groups when token changes
  useEffect(() => {
    if (!token) return;
    if (isDriver && !isAdmin) setWorkspace("driver");
    else if (isAdmin && !isDriver) setWorkspace("admin");
    // If the user has both roles (e.g. cody.carmichael), keep whatever
    // workspace is already selected (restored from storage; defaults to "driver").
  }, [token, isDriver, isAdmin]);

  // Token-expiry watchdog. id_tokens expire (~1h) with no refresh token kept,
  // so a session left open mid-shift would otherwise fail every API call with
  // an opaque toast. Detect expiry and drop the user back to a sign-in screen
  // with a clear message, both immediately and on a poll for in-session expiry.
  useEffect(() => {
    if (!looksLikeJwt(token)) return;
    const expireNow = () => {
      setToken("");
      setLoginMsg("Your session expired. Please sign in again.");
    };
    if (isTokenExpired(token)) {
      expireNow();
      return;
    }
    const exp = getTokenExp(token);
    const id = setInterval(() => {
      if (isTokenExpired(token)) expireNow();
    }, 30_000);
    // If we know the exact expiry, also schedule a precise wake-up for it.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (exp != null) {
      const msUntil = exp * 1000 - Date.now();
      if (msUntil > 0 && msUntil < 0x7fffffff) timeoutId = setTimeout(expireNow, msUntil);
    }
    return () => {
      clearInterval(id);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [token]);

  // ── Storage ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!mounted || !raw) return;
        const parsed = JSON.parse(raw) as {
          token?: string;
          apiBase?: string;
          cognitoDomain?: string;
          workspace?: Workspace;
        };
        // Restore a stored token only if it's structurally valid AND not already
        // expired — a stale token would otherwise drop the user into the
        // authenticated UI where every API call 401s with no clear recovery.
        if (parsed.token && looksLikeJwt(parsed.token)) {
          if (isTokenExpired(parsed.token)) {
            setLoginMsg("Your session expired. Please sign in again.");
          } else {
            setToken(parsed.token);
          }
        }
        if (parsed.apiBase && Platform.OS !== "web") setApiBase(parsed.apiBase);
        if (parsed.cognitoDomain) setCognitoDomain(normalizeDomain(parsed.cognitoDomain));
        if (parsed.workspace === "admin" || parsed.workspace === "driver") setWorkspace(parsed.workspace);
      })
      .catch(() => undefined)
      .finally(() => { if (mounted) setIsLoadingConfig(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (isLoadingConfig) return;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: token.trim(),
        apiBase: normalizeApiBase(apiBase),
        cognitoDomain: normalizeDomain(cognitoDomain),
        workspace,
      })
    ).catch(() => undefined);
  }, [token, apiBase, cognitoDomain, workspace, isLoadingConfig]);

  // ── Deep-link / hosted UI callback ────────────────────────────────────────

  useEffect(() => {
    const sub = Linking.addEventListener("url", (e) => consumeCallback(e.url).catch(() => undefined));
    Linking.getInitialURL()
      .then((u) => { if (u) consumeCallback(u).catch(() => undefined); })
      .catch(() => undefined);
    return () => sub.remove();
  }, []);

  async function consumeCallback(url: string) {
    const query = parseQueryParams(url);
    const code = (query.get("code") || "").trim();
    const cbState = (query.get("state") || "").trim();
    const err = query.get("error");
    if (err) { await AsyncStorage.removeItem(STORAGE_PKCE_KEY); setLoginMsg(query.get("error_description") || err); return; }

    if (code) {
      const sessionRaw = await AsyncStorage.getItem(STORAGE_PKCE_KEY);
      if (!sessionRaw) { setLoginMsg("PKCE session missing. Try logging in again."); return; }
      let session: PkceSession | null = null;
      try {
        const p = JSON.parse(sessionRaw) as Partial<PkceSession>;
        if (p.state && p.verifier && p.domain && p.clientId) session = p as PkceSession;
      } catch { /* ok */ }
      if (!session || cbState !== session.state) {
        await AsyncStorage.removeItem(STORAGE_PKCE_KEY);
        setLoginMsg("State mismatch. Try logging in again.");
        return;
      }
      const form = new URLSearchParams();
      form.set("grant_type", "authorization_code");
      form.set("client_id", session.clientId);
      form.set("code", code);
      form.set("redirect_uri", REDIRECT_URI);
      form.set("code_verifier", session.verifier);
      try {
        const resp = await fetch(`https://${session.domain}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const data = (await resp.json()) as Record<string, unknown>;
        await AsyncStorage.removeItem(STORAGE_PKCE_KEY);
        if (!resp.ok) { setLoginMsg(String(data.error_description || data.error || "Token exchange failed.")); return; }
        const next = String(data.id_token || data.access_token || "").trim();
        if (!next) { setLoginMsg("No token in response."); return; }
        setToken(next);
        setLoginMsg("");
      } catch {
        setLoginMsg("Token exchange failed.");
      }
      return;
    }

    // Implicit flow fallback
    const hash = parseHashParams(url);
    const next = (hash.get("id_token") || hash.get("access_token") || "").trim();
    if (next) { setToken(next); setLoginMsg(""); }
  }

  // ── Sign-in with Cognito SRP (primary — no domain required) ─────────────────

  async function signIn() {
    const username = loginUser.trim();
    if (!username || !loginPass) { setLoginMsg("Username and password are required."); return; }
    setLoginLoading(true);
    setLoginMsg("");
    try {
      const idToken = await new Promise<string>((resolve, reject) => {
        const pool = new CognitoUserPool({ UserPoolId: cognitoUserPoolId, ClientId: cognitoClientId });
        const user = new CognitoUser({ Username: username, Pool: pool });
        user.authenticateUser(
          new AuthenticationDetails({ Username: username, Password: loginPass }),
          {
            onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
            onFailure: (err) => reject(err),
            newPasswordRequired: () => reject(new Error("A new password is required. Please reset via Forgot Password.")),
          }
        );
      });
      setToken(idToken);
      setLoginPass("");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      const msgMap: Record<string, string> = {
        NotAuthorizedException: "Incorrect username or password.",
        UserNotFoundException: "No account found with that username.",
        UserNotConfirmedException: "Please verify your email before signing in.",
        PasswordResetRequiredException: "A password reset is required.",
        LimitExceededException: "Too many attempts. Please wait and try again.",
      };
      setLoginMsg(msgMap[code] ?? (err instanceof Error ? err.message : "Sign-in failed."));
    } finally {
      setLoginLoading(false);
    }
  }

  // ── Hosted UI login (advanced fallback) ──────────────────────────────────────

  async function startHostedLogin() {
    const domain = normalizeDomain(cognitoDomain || "");
    if (!domain) { setLoginMsg("Enter your Cognito domain to continue."); return; }
    setLoginLoading(true);
    setLoginMsg("");
    try {
      const state = randomStr(32);
      const verifier = randomStr(64);
      const pkce = await buildPkce(verifier);
      const session: PkceSession = { state, verifier, domain, clientId: cognitoClientId };
      await AsyncStorage.setItem(STORAGE_PKCE_KEY, JSON.stringify(session));
      const params = new URLSearchParams();
      params.set("client_id", cognitoClientId);
      params.set("response_type", "code");
      params.set("scope", "openid email profile");
      params.set("redirect_uri", REDIRECT_URI);
      params.set("state", state);
      params.set("code_challenge", pkce.challenge);
      params.set("code_challenge_method", pkce.method);
      await Linking.openURL(`https://${domain}/oauth2/authorize?${params.toString()}`);
    } catch (err) {
      setLoginMsg(err instanceof Error ? err.message : "Failed to open login.");
      setLoginLoading(false);
    }
  }

  // ── Sign out ───────────────────────────────────────────────────────────────

  function signOut() {
    setToken("");
    setLoginMsg("");
  }

  // ─── Loading splash ───────────────────────────────────────────────────────

  if (isLoadingConfig) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#C8973A" />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Authenticated: route to workspace ───────────────────────────────────

  if (looksLikeJwt(token) && !isTokenExpired(token)) {
    // If token is valid but groups are empty (shouldn't happen normally), show sign-out
    const canAdmin = isAdmin;
    const canDriver = isDriver;

    // Workspace selector — shown when user has BOTH roles
    const showWorkspaceSelector = canAdmin && canDriver;

    // Pick which screen to render
    const renderScreen = () => {
      if (workspace === "admin" && canAdmin) {
        return <AdminScreen token={token} apiBase={apiBase} onSignOut={signOut} />;
      }
      if (workspace === "driver" && canDriver) {
        return <DriverScreen token={token} apiBase={apiBase} onSignOut={signOut} />;
      }
      // Fallback — user lacks permission for selected workspace
      return (
        <SafeAreaView style={styles.screen}>
          <View style={styles.loadingWrap}>
            <Text style={styles.loginHeading}>Workspace Unavailable</Text>
            <Text style={styles.loginLead}>
              Your account ({tokenGroups.join(", ")}) doesn't have access to the{" "}
              {workspace} workspace.
            </Text>
            <View style={styles.workspaceSwitcher}>
              {canAdmin ? (
                <Pressable style={[styles.wsBtn, styles.wsBtnActive]} onPress={() => setWorkspace("admin")}>
                  <Text style={styles.wsBtnText}>Go to Dispatch</Text>
                </Pressable>
              ) : null}
              {canDriver ? (
                <Pressable style={[styles.wsBtn, styles.wsBtnActive]} onPress={() => setWorkspace("driver")}>
                  <Text style={styles.wsBtnText}>Go to Driver</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.wsBtn} onPress={signOut}>
                <Text style={styles.wsBtnGhostText}>Sign Out</Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      );
    };

    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        {/* Top banner — always visible when authenticated; tabs only for multi-role users */}
        <View style={styles.workspaceBanner}>
          <View style={styles.workspaceBannerTabs}>
            {showWorkspaceSelector ? (
              <>
                <Pressable
                  style={[styles.wsChip, workspace === "driver" && styles.wsChipActive]}
                  onPress={() => setWorkspace("driver")}
                >
                  <Text style={[styles.wsChipText, workspace === "driver" && styles.wsChipTextActive]}>
                    Driver
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.wsChip, workspace === "admin" && styles.wsChipActive]}
                  onPress={() => setWorkspace("admin")}
                >
                  <Text style={[styles.wsChipText, workspace === "admin" && styles.wsChipTextActive]}>
                    Dispatch
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
          {simulatorEnabled ? (
            <Pressable style={styles.settingsGearBtn} onPress={() => setSettingsOpen(true)}>
              <Text style={styles.settingsGearText}>⚙</Text>
            </Pressable>
          ) : null}
        </View>
        {renderScreen()}

        {/* Settings modal — simulator controls (cody.carmichael only) */}
        {simulatorEnabled ? (
          <Modal visible={settingsOpen} animationType="slide" transparent onRequestClose={() => setSettingsOpen(false)}>
            <View style={styles.settingsBackdrop}>
              <SafeAreaView style={{ width: "100%" }}>
                <View style={styles.settingsCard}>
                  <SimulatorPanel
                    apiBase={apiBase}
                    token={token}
                    open={settingsOpen}
                    onClose={() => setSettingsOpen(false)}
                  />
                </View>
              </SafeAreaView>
            </View>
          </Modal>
        ) : null}
      </View>
    );
  }

  // ─── Login screen ─────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.loginScreen}>
        <View style={styles.loginCard}>
          {/* Brand */}
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>D</Text>
            </View>
            <Text style={styles.brandName}>Discra</Text>
          </View>
          <Text style={styles.loginHeading}>Welcome Back</Text>
          <Text style={styles.loginLead}>Sign in to your workspace.</Text>

          <Text style={styles.label}>Username</Text>
          <TextInput
            testID="login-username"
            style={styles.input}
            value={loginUser}
            onChangeText={setLoginUser}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Enter username"
            placeholderTextColor="#4A3F60"
            returnKeyType="next"
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            testID="login-password"
            style={styles.input}
            value={loginPass}
            onChangeText={setLoginPass}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="••••••••"
            placeholderTextColor="#4A3F60"
            returnKeyType="done"
            onSubmitEditing={() => signIn().catch(() => undefined)}
          />

          {loginMsg ? <Text style={styles.errorText}>{loginMsg}</Text> : null}

          <Pressable
            testID="login-submit"
            style={[styles.btn, styles.btnPrimary, styles.loginBtn, loginLoading && { opacity: 0.6 }]}
            onPress={() => signIn().catch(() => undefined)}
            disabled={loginLoading}
          >
            {loginLoading
              ? <ActivityIndicator size="small" color="#0B0910" />
              : <Text style={styles.btnPrimaryText}>Sign In</Text>}
          </Pressable>

        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Simulator Panel ──────────────────────────────────────────────────────────

const SIM_AREAS: Array<{ key: string; label: string }> = [
  { key: "fortworth", label: "Fort Worth, TX" },
  { key: "dallas", label: "Dallas, TX" },
  { key: "austin", label: "Austin, TX" },
  { key: "houston", label: "Houston, TX" },
  { key: "nyc", label: "New York City" },
  { key: "la", label: "Los Angeles" },
];

type SimDriver = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heading: number;
  state: string;
  active_order_id: string | null;
};

type SimStatus = {
  running: boolean;
  update_count: number;
  config: { area: string; interval_sec: number; speed_mph: number } | null;
  drivers: SimDriver[];
};

function SimulatorPanel({
  apiBase,
  token,
  open,
  onClose,
}: {
  apiBase: string;
  token: string;
  open: boolean;
  onClose: () => void;
}) {
  const [count, setCount] = useState("5");
  const [areaKey, setAreaKey] = useState("fortworth");
  const [intervalSec, setIntervalSec] = useState("5");
  const [speedMph, setSpeedMph] = useState("30");
  const [seedCount, setSeedCount] = useState("5");
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Initial fetch + poll while open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function refresh() {
      try {
        const s = await apiRequest<SimStatus>(apiBase, "/admin/simulator/status", { token });
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : "Status failed.");
      }
    }
    refresh();
    const id = setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, apiBase, token]);

  // Pre-fill form from current config when status loads
  useEffect(() => {
    if (status?.config) {
      setAreaKey(status.config.area);
      setIntervalSec(String(status.config.interval_sec));
      setSpeedMph(String(status.config.speed_mph));
    }
  }, [status?.config?.area, status?.config?.interval_sec, status?.config?.speed_mph]);

  async function spawn() {
    setBusy(true);
    setMsg("");
    try {
      const next = await apiRequest<SimStatus>(apiBase, "/admin/simulator/spawn", {
        method: "POST",
        token,
        json: {
          count: parseInt(count, 10) || 5,
          area: areaKey,
          interval_sec: parseFloat(intervalSec) || 5,
          speed_mph: parseFloat(speedMph) || 30,
        },
      });
      setStatus(next);
      setMsg(`Spawned ${next.drivers.length} driver(s).`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Spawn failed.");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setMsg("");
    try {
      const next = await apiRequest<SimStatus>(apiBase, "/admin/simulator/stop", {
        method: "POST",
        token,
      });
      setStatus(next);
      setMsg("Simulator stopped.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Stop failed.");
    } finally {
      setBusy(false);
    }
  }

  async function seedOrders() {
    setBusy(true);
    setMsg("");
    try {
      const resp = await apiRequest<{ created: number; order_ids: string[] }>(
        apiBase,
        "/admin/simulator/seed-orders",
        {
          method: "POST",
          token,
          json: { count: parseInt(seedCount, 10) || 5, area: areaKey },
        }
      );
      setMsg(`Seeded ${resp.created} order(s). Refresh the dispatch tab to see them.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Seed failed.");
    } finally {
      setBusy(false);
    }
  }

  const stateLabel = (s: string) =>
    s === "to_pickup" ? "→ Pickup" : s === "to_delivery" ? "→ Delivery" : "Roaming";

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={styles.loginHeading}>Driver Simulator</Text>
        <Pressable onPress={onClose}>
          <Text style={{ color: "#968AA8", fontSize: 18 }}>✕</Text>
        </Pressable>
      </View>

      {/* Configuration */}
      <Text style={styles.label}>Number of drivers (1–20)</Text>
      <TextInput
        style={styles.input}
        value={count}
        onChangeText={setCount}
        keyboardType="number-pad"
        placeholderTextColor="#4A3F60"
      />

      <Text style={styles.label}>Area</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {SIM_AREAS.map((a) => (
          <Pressable
            key={a.key}
            onPress={() => setAreaKey(a.key)}
            style={[
              styles.simChip,
              areaKey === a.key && styles.simChipActive,
            ]}
          >
            <Text style={[styles.simChipText, areaKey === a.key && styles.simChipTextActive]}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Interval (sec)</Text>
          <TextInput
            style={styles.input}
            value={intervalSec}
            onChangeText={setIntervalSec}
            keyboardType="number-pad"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Speed (mph)</Text>
          <TextInput
            style={styles.input}
            value={speedMph}
            onChangeText={setSpeedMph}
            keyboardType="number-pad"
          />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.5 }]}
          onPress={spawn}
          disabled={busy}
        >
          <Text style={styles.btnPrimaryText}>{status?.running ? "Respawn" : "Spawn"}</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnGhost, (!status?.running || busy) && { opacity: 0.4 }]}
          onPress={stop}
          disabled={!status?.running || busy}
        >
          <Text style={styles.btnGhostText}>Stop</Text>
        </Pressable>
      </View>

      {/* Status */}
      <View style={styles.simStatusBar}>
        <Text style={styles.simStatusText}>
          {status?.running ? "● Running" : "○ Stopped"} · {status?.drivers.length ?? 0} drivers · {status?.update_count ?? 0} updates
        </Text>
      </View>

      {/* Seed test orders */}
      <View style={{ height: 1, backgroundColor: "#241A33", marginVertical: 4 }} />
      <Text style={styles.label}>Seed test orders ({areaKey})</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
        <View style={{ flex: 1 }}>
          <TextInput
            style={styles.input}
            value={seedCount}
            onChangeText={setSeedCount}
            keyboardType="number-pad"
            placeholder="5"
            placeholderTextColor="#4A3F60"
          />
        </View>
        <Pressable
          style={[styles.btn, styles.btnPrimary, busy && { opacity: 0.5 }]}
          onPress={seedOrders}
          disabled={busy}
        >
          <Text style={styles.btnPrimaryText}>+ Seed Orders</Text>
        </Pressable>
      </View>

      {msg ? <Text style={{ color: "#C8973A", fontSize: 12 }}>{msg}</Text> : null}

      {/* Driver list */}
      {status && status.drivers.length > 0 ? (
        <View style={{ gap: 4, maxHeight: 220 }}>
          <Text style={styles.label}>Drivers</Text>
          {status.drivers.slice(0, 20).map((d) => (
            <View key={d.id} style={styles.simDriverRow}>
              <Text style={styles.simDriverName} numberOfLines={1}>{d.name}</Text>
              <Text style={styles.simDriverState}>{stateLabel(d.state)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0B0910",
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
  },
  loadingText: {
    color: "#968AA8",
    fontSize: 14,
  },
  loginScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loginCard: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: "#130F1A",
    borderWidth: 1,
    borderColor: "#3A2F50",
    borderRadius: 16,
    padding: 24,
    gap: 10,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  brandMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "#C8973A",
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkText: {
    color: "#0B0910",
    fontWeight: "800",
    fontSize: 18,
  },
  brandName: {
    color: "#F5D98B",
    fontSize: 20,
    fontWeight: "700",
  },
  loginHeading: {
    color: "#F5D98B",
    fontSize: 20,
    fontWeight: "700",
  },
  loginLead: {
    color: "#968AA8",
    fontSize: 13,
  },
  label: {
    color: "#968AA8",
    fontSize: 11,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderColor: "#3A2F50",
    borderRadius: 10,
    color: "#EDE0C4",
    backgroundColor: "#0F0C16",
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  errorText: {
    color: "#F0C060",
    fontSize: 12,
    fontWeight: "600",
  },
  btn: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: {
    backgroundColor: "#C8973A",
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: "#6B4F2A",
    backgroundColor: "#130F1A",
  },
  btnPrimaryText: {
    color: "#0B0910",
    fontWeight: "700",
    fontSize: 14,
  },
  btnGhostText: {
    color: "#C8973A",
    fontWeight: "700",
    fontSize: 14,
  },
  loginBtn: {
    marginTop: 4,
    paddingVertical: 13,
  },
  // Workspace banner — always visible when authenticated
  workspaceBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0B0910",
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  workspaceBannerTabs: {
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
  },
  settingsGearBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsGearText: {
    fontSize: 18,
    color: "#968AA8",
  },
  wsChip: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#1A1526",
  },
  wsChipActive: {
    backgroundColor: "#C8973A",
    borderColor: "#C8973A",
  },
  wsChipText: {
    color: "#968AA8",
    fontWeight: "600",
    fontSize: 13,
  },
  wsChipTextActive: {
    color: "#0B0910",
  },
  // Workspace not available
  workspaceSwitcher: {
    gap: 10,
    alignItems: "center",
    marginTop: 16,
  },
  wsBtn: {
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#1A1526",
    minWidth: 160,
    alignItems: "center",
  },
  wsBtnActive: {
    backgroundColor: "#C8973A",
    borderColor: "#C8973A",
  },
  wsBtnText: {
    color: "#0B0910",
    fontWeight: "700",
    fontSize: 14,
  },
  wsBtnGhostText: {
    color: "#968AA8",
    fontWeight: "600",
    fontSize: 14,
  },
  // Settings modal
  settingsBackdrop: {
    flex: 1,
    backgroundColor: "rgba(7,5,12,0.88)",
    justifyContent: "flex-end",
  },
  settingsCard: {
    backgroundColor: "#130F1A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 20,
    gap: 10,
    maxHeight: "92%",
  },
  // Simulator panel
  simChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#0F0C16",
  },
  simChipActive: { borderColor: "#C8973A", backgroundColor: "#2A1E10" },
  simChipText: { color: "#968AA8", fontSize: 12, fontWeight: "600" },
  simChipTextActive: { color: "#C8973A" },
  simStatusBar: {
    backgroundColor: "#0F0C16",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 8,
  },
  simStatusText: { color: "#EDE0C4", fontSize: 12, fontWeight: "600" },
  simDriverRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#241A33",
  },
  simDriverName: { color: "#EDE0C4", fontSize: 13, fontWeight: "600", flex: 1 },
  simDriverState: { color: "#C8973A", fontSize: 12, fontWeight: "700" },
});
