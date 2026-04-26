// App.tsx — Auth gateway + workspace router for Discra Mobile
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { decodeJwtPayload, extractTokenGroups, normalizeApiBase } from "./lib";
import AdminScreen from "./screens/AdminScreen";
import DriverScreen from "./screens/DriverScreen";

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "discra_mobile_config_v4";
const STORAGE_PKCE_KEY = "discra_mobile_pkce_v1";
const DEFAULT_API_BASE =
  Platform.OS === "web"
    ? "http://localhost:8000/backend"
    : "https://m50fjhgrn7.execute-api.us-east-1.amazonaws.com/dev/backend";
const DEFAULT_COGNITO_USER_POOL_ID = "us-east-1_vMav7IRF7";
const DEFAULT_COGNITO_CLIENT_ID = "4gq64lj8ndo8pltt6hj5ritqi";
const REDIRECT_URI = "discra-mobile://auth/callback";

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
  const [cognitoUserPoolId] = useState(DEFAULT_COGNITO_USER_POOL_ID);
  const [cognitoClientId] = useState(DEFAULT_COGNITO_CLIENT_ID);
  const [cognitoDomain, setCognitoDomain] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>("driver");
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  // Login form
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

  // Auto-select workspace based on groups when token changes
  useEffect(() => {
    if (!token) return;
    if (isDriver && !isAdmin) setWorkspace("driver");
    else if (isAdmin && !isDriver) setWorkspace("admin");
    // if both (like cody.carmichael), keep current choice or default to admin
    else if (isAdmin && isDriver && workspace === "driver" && !isDriver) setWorkspace("admin");
  }, [token, isDriver, isAdmin]);

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
        if (parsed.token && looksLikeJwt(parsed.token)) setToken(parsed.token);
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

  // ── Sign-in with Cognito SRP ───────────────────────────────────────────────

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

  // ── Hosted UI login ────────────────────────────────────────────────────────

  async function startHostedLogin() {
    const domain = normalizeDomain(cognitoDomain || "");
    if (!domain) { setLoginMsg("Cognito domain is required for Hosted UI login."); return; }
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

  if (looksLikeJwt(token)) {
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
          <Pressable style={styles.settingsGearBtn} onPress={() => setSettingsOpen(true)}>
            <Text style={styles.settingsGearText}>⚙</Text>
          </Pressable>
        </View>
        {renderScreen()}

        {/* Settings modal — opened via ⚙ in the top banner */}
        <Modal visible={settingsOpen} animationType="slide" transparent onRequestClose={() => setSettingsOpen(false)}>
          <View style={styles.settingsBackdrop}>
            <SafeAreaView>
              <View style={styles.settingsCard}>
                <Text style={styles.loginHeading}>Settings</Text>
                <Text style={styles.label}>API Base URL</Text>
                <TextInput
                  style={styles.input}
                  value={apiBase}
                  onChangeText={setApiBase}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholderTextColor="#4A3F60"
                />
                <Text style={styles.label}>Cognito Domain (Hosted UI)</Text>
                <TextInput
                  style={styles.input}
                  value={cognitoDomain}
                  onChangeText={setCognitoDomain}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholderTextColor="#4A3F60"
                  placeholder="auth.example.com"
                />
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setSettingsOpen(false)}>
                  <Text style={styles.btnGhostText}>Done</Text>
                </Pressable>
              </View>
            </SafeAreaView>
          </View>
        </Modal>
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

          {/* Username / password */}
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={loginUser}
            onChangeText={setLoginUser}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="default"
            placeholder="Enter username"
            placeholderTextColor="#4A3F60"
            returnKeyType="next"
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
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
            style={[styles.btn, styles.btnPrimary, styles.loginBtn, loginLoading && { opacity: 0.6 }]}
            onPress={() => signIn().catch(() => undefined)}
            disabled={loginLoading}
          >
            <Text style={styles.btnPrimaryText}>{loginLoading ? "Signing in…" : "Sign In"}</Text>
          </Pressable>

          {/* Settings link */}
          <Pressable onPress={() => setSettingsOpen(true)} style={{ alignSelf: "center" }}>
            <Text style={styles.settingsLink}>Advanced settings</Text>
          </Pressable>
        </View>
      </View>

      {/* Settings modal */}
      <Modal visible={settingsOpen} animationType="slide" transparent onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.settingsBackdrop}>
          <View style={styles.settingsCard}>
            <Text style={styles.loginHeading}>Settings</Text>
            <Text style={styles.label}>API Base URL</Text>
            <TextInput
              style={styles.input}
              value={apiBase}
              onChangeText={setApiBase}
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor="#4A3F60"
              placeholder="https://.../dev/backend"
            />
            <Text style={styles.label}>Cognito Domain (Hosted UI)</Text>
            <TextInput
              style={styles.input}
              value={cognitoDomain}
              onChangeText={setCognitoDomain}
              autoCapitalize="none"
              autoCorrect={false}
              placeholderTextColor="#4A3F60"
              placeholder="auth.example.com"
            />
            <View style={styles.row}>
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => startHostedLogin().catch((e) => setLoginMsg(e instanceof Error ? e.message : "Failed."))}>
                <Text style={styles.btnPrimaryText}>Hosted UI Login</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setSettingsOpen(false)}>
                <Text style={styles.btnGhostText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
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
  settingsLink: {
    color: "#968AA8",
    fontSize: 12,
    marginTop: 4,
    textDecorationLine: "underline",
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
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
  },
});
