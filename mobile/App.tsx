import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import * as Location from "expo-location";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type Workspace = "admin" | "driver";

type OrderRecord = {
  id: string;
  customer_name: string;
  reference_number: number;
  pick_up_address: string;
  delivery: string;
  dimensions: string;
  weight: number;
  status: string;
  assigned_to?: string | null;
};

type DriverLocationRecord = {
  driver_id: string;
  lat: number;
  lng: number;
  timestamp: string;
};

const STORAGE_KEY = "discra_mobile_config_v1";
const DEFAULT_API_BASE = "http://127.0.0.1:3000/dev/backend";
const DRIVER_STATUS = ["PickedUp", "EnRoute", "Failed", "Delivered"];
const ADMIN_STATUS = ["Assigned", "PickedUp", "EnRoute", "Delivered", "Failed"];

function normalizeApiBase(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

function endpointUrl(apiBase: string, path: string): string {
  const base = normalizeApiBase(apiBase);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function formatTime(value?: string): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

type ApiRequestOptions = {
  method?: "GET" | "POST";
  token: string;
  json?: unknown;
};

async function apiRequest<T>(apiBase: string, path: string, options: ApiRequestOptions): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
  };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(endpointUrl(apiBase, path), {
    method: options.method || "GET",
    headers,
    body,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = text;
    }
  }
  if (!response.ok) {
    if (payload && typeof payload === "object" && "detail" in payload) {
      throw new Error(String((payload as { detail: unknown }).detail));
    }
    throw new Error(`Request failed (${response.status})`);
  }
  return payload as T;
}

export default function App() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>("admin");
  const [statusMessage, setStatusMessage] = useState("Configure API base and JWT to begin.");
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [inboxOrders, setInboxOrders] = useState<OrderRecord[]>([]);
  const [drivers, setDrivers] = useState<DriverLocationRecord[]>([]);
  const [assignInputs, setAssignInputs] = useState<Record<string, string>>({});
  const [autoShareOn, setAutoShareOn] = useState(false);
  const locationTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!mounted || !raw) {
          return;
        }
        const parsed = JSON.parse(raw) as { apiBase?: string; token?: string; workspace?: Workspace };
        if (parsed.apiBase) {
          setApiBase(parsed.apiBase);
        }
        if (parsed.token) {
          setToken(parsed.token);
        }
        if (parsed.workspace === "admin" || parsed.workspace === "driver") {
          setWorkspace(parsed.workspace);
        }
      })
      .catch(() => {
        setStatusMessage("Could not load saved config.");
      })
      .finally(() => {
        if (mounted) {
          setIsLoadingConfig(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiBase: normalizeApiBase(apiBase),
        token: token.trim(),
        workspace,
      })
    ).catch(() => undefined);
  }, [apiBase, token, workspace]);

  useEffect(() => {
    return () => {
      if (locationTimer.current) {
        clearInterval(locationTimer.current);
      }
    };
  }, []);

  const hasConfig = useMemo(() => !!normalizeApiBase(apiBase) && !!token.trim(), [apiBase, token]);

  function setMessage(message: string) {
    setStatusMessage(message);
  }

  async function withLoading(action: () => Promise<void>) {
    setIsLoading(true);
    try {
      await action();
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshAdminData() {
    if (!hasConfig) {
      setMessage("API base and JWT token are required.");
      return;
    }
    await withLoading(async () => {
      const [ordersResponse, driversResponse] = await Promise.all([
        apiRequest<OrderRecord[]>(apiBase, "/orders/", { token }),
        apiRequest<DriverLocationRecord[]>(apiBase, "/drivers?active_minutes=120", { token }),
      ]);
      setOrders(ordersResponse || []);
      setDrivers(driversResponse || []);
      setMessage(`Loaded ${ordersResponse.length} orders and ${driversResponse.length} active drivers.`);
    });
  }

  async function refreshDriverInbox() {
    if (!hasConfig) {
      setMessage("API base and JWT token are required.");
      return;
    }
    await withLoading(async () => {
      const response = await apiRequest<OrderRecord[]>(apiBase, "/orders/driver/inbox", { token });
      setInboxOrders(response || []);
      setMessage(`Loaded ${response.length} assigned orders.`);
    });
  }

  async function assignOrder(orderId: string) {
    const driverId = (assignInputs[orderId] || "").trim();
    if (!driverId) {
      setMessage("Driver ID is required for assignment.");
      return;
    }
    await withLoading(async () => {
      await apiRequest<OrderRecord>(apiBase, `/orders/${orderId}/assign`, {
        method: "POST",
        token,
        json: { driver_id: driverId },
      });
      await refreshAdminData();
    });
  }

  async function unassignOrder(orderId: string) {
    await withLoading(async () => {
      await apiRequest<OrderRecord>(apiBase, `/orders/${orderId}/unassign`, {
        method: "POST",
        token,
      });
      await refreshAdminData();
    });
  }

  async function updateOrderStatus(orderId: string, status: string, nextWorkspace: Workspace) {
    await withLoading(async () => {
      await apiRequest<OrderRecord>(apiBase, `/orders/${orderId}/status`, {
        method: "POST",
        token,
        json: { status },
      });
      if (nextWorkspace === "admin") {
        await refreshAdminData();
      } else {
        await refreshDriverInbox();
      }
    });
  }

  async function sendDriverLocation() {
    if (!hasConfig) {
      setMessage("API base and JWT token are required.");
      return;
    }
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      setMessage("Location permission denied.");
      return;
    }
    await withLoading(async () => {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const headingValue =
        typeof location.coords.heading === "number" && Number.isFinite(location.coords.heading)
          ? location.coords.heading
          : null;
      await apiRequest(apiBase, "/drivers/location", {
        method: "POST",
        token,
        json: {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          heading: headingValue,
        },
      });
      setMessage(
        `Sent location at ${new Date().toLocaleTimeString()} (${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}).`
      );
    });
  }

  function toggleAutoShare() {
    if (autoShareOn) {
      if (locationTimer.current) {
        clearInterval(locationTimer.current);
        locationTimer.current = null;
      }
      setAutoShareOn(false);
      setMessage("Auto-share disabled.");
      return;
    }
    if (!hasConfig) {
      setMessage("API base and JWT token are required.");
      return;
    }
    sendDriverLocation().catch((error) => {
      setMessage(String(error instanceof Error ? error.message : error));
    });
    locationTimer.current = setInterval(() => {
      sendDriverLocation().catch(() => undefined);
    }, 60_000);
    setAutoShareOn(true);
    setMessage("Auto-share enabled (every 60s).");
  }

  function onError(error: unknown) {
    setMessage(error instanceof Error ? error.message : "Request failed.");
  }

  if (isLoadingConfig) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Loading mobile workspace...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.appTitle}>Discra Mobile</Text>
        <Text style={styles.subtitle}>Admin/Dispatcher + Driver workflows</Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Session</Text>
          <Text style={styles.label}>API Base URL</Text>
          <TextInput
            value={apiBase}
            onChangeText={setApiBase}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder={DEFAULT_API_BASE}
            placeholderTextColor="#6f8d98"
          />
          <Text style={styles.label}>JWT Token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.tokenInput]}
            multiline
            placeholder="Paste Cognito JWT"
            placeholderTextColor="#6f8d98"
          />
          <View style={styles.toggleRow}>
            <Pressable
              style={[styles.toggleButton, workspace === "admin" && styles.toggleButtonActive]}
              onPress={() => setWorkspace("admin")}
            >
              <Text style={[styles.toggleText, workspace === "admin" && styles.toggleTextActive]}>Admin/Dispatcher</Text>
            </Pressable>
            <Pressable
              style={[styles.toggleButton, workspace === "driver" && styles.toggleButtonActive]}
              onPress={() => setWorkspace("driver")}
            >
              <Text style={[styles.toggleText, workspace === "driver" && styles.toggleTextActive]}>Driver</Text>
            </Pressable>
          </View>
          <Text style={styles.metaText}>Use `/dev/backend` API base from deployed SAM endpoint.</Text>
        </View>

        {workspace === "admin" ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Dispatch + Driver Tracking</Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={() => refreshAdminData().catch(onError)}
                disabled={isLoading}
              >
                <Text style={styles.buttonText}>Refresh Orders + Drivers</Text>
              </Pressable>
            </View>
            {orders.map((order) => (
              <View key={order.id} style={styles.orderCard}>
                <Text style={styles.orderTitle}>{order.customer_name}</Text>
                <Text style={styles.orderMeta}>
                  #{order.reference_number} • {order.status} • Assigned: {order.assigned_to || "-"}
                </Text>
                <Text style={styles.orderMeta}>Pick Up: {order.pick_up_address}</Text>
                <Text style={styles.orderMeta}>Delivery: {order.delivery}</Text>
                <TextInput
                  style={styles.input}
                  value={assignInputs[order.id] ?? order.assigned_to ?? ""}
                  placeholder="Driver ID"
                  placeholderTextColor="#6f8d98"
                  onChangeText={(value) => setAssignInputs((prev) => ({ ...prev, [order.id]: value }))}
                />
                <View style={styles.row}>
                  <Pressable
                    style={[styles.button, styles.buttonPrimary]}
                    onPress={() => assignOrder(order.id).catch(onError)}
                  >
                    <Text style={styles.buttonText}>Assign</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, styles.buttonGhost]}
                    onPress={() => unassignOrder(order.id).catch(onError)}
                  >
                    <Text style={styles.buttonGhostText}>Unassign</Text>
                  </Pressable>
                </View>
                <View style={styles.statusWrap}>
                  {ADMIN_STATUS.map((status) => (
                    <Pressable
                      key={`${order.id}-${status}`}
                      style={[styles.statusButton, order.status === status && styles.statusButtonActive]}
                      onPress={() => updateOrderStatus(order.id, status, "admin").catch(onError)}
                    >
                      <Text style={styles.statusButtonText}>{status}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
            <Text style={styles.sectionSubtitle}>Active Drivers</Text>
            {drivers.length === 0 ? <Text style={styles.metaText}>No active drivers found.</Text> : null}
            {drivers.map((driver) => (
              <Pressable
                key={driver.driver_id}
                style={styles.driverCard}
                onPress={() => Linking.openURL(`https://maps.google.com/?q=${driver.lat},${driver.lng}`)}
              >
                <Text style={styles.driverTitle}>{driver.driver_id}</Text>
                <Text style={styles.metaText}>
                  {driver.lat.toFixed(5)}, {driver.lng.toFixed(5)}
                </Text>
                <Text style={styles.metaText}>{formatTime(driver.timestamp)}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Driver Workflow</Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={() => refreshDriverInbox().catch(onError)}
                disabled={isLoading}
              >
                <Text style={styles.buttonText}>Refresh Inbox</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => sendDriverLocation().catch(onError)}>
                <Text style={styles.buttonText}>Send Location</Text>
              </Pressable>
              <Pressable
                style={[styles.button, autoShareOn ? styles.buttonDanger : styles.buttonGhost]}
                onPress={toggleAutoShare}
              >
                <Text style={autoShareOn ? styles.buttonText : styles.buttonGhostText}>
                  {autoShareOn ? "Stop Auto Share" : "Start Auto Share"}
                </Text>
              </Pressable>
            </View>
            {inboxOrders.map((order) => (
              <View key={order.id} style={styles.orderCard}>
                <Text style={styles.orderTitle}>{order.customer_name}</Text>
                <Text style={styles.orderMeta}>
                  #{order.reference_number} • {order.status}
                </Text>
                <Text style={styles.orderMeta}>Pick Up: {order.pick_up_address}</Text>
                <Text style={styles.orderMeta}>Delivery: {order.delivery}</Text>
                <View style={styles.statusWrap}>
                  {DRIVER_STATUS.map((status) => (
                    <Pressable
                      key={`${order.id}-${status}`}
                      style={[styles.statusButton, order.status === status && styles.statusButtonActive]}
                      onPress={() => updateOrderStatus(order.id, status, "driver").catch(onError)}
                    >
                      <Text style={styles.statusButtonText}>{status}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
            {inboxOrders.length === 0 ? <Text style={styles.metaText}>No assigned orders.</Text> : null}
          </View>
        )}

        {isLoading ? <ActivityIndicator /> : null}
        <Text style={styles.footerMessage}>{statusMessage}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#07181f",
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 28,
  },
  loadingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  loadingText: {
    color: "#d2eaf5",
  },
  appTitle: {
    color: "#f1fbff",
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: "#89a8b5",
    marginTop: 2,
  },
  card: {
    borderWidth: 1,
    borderColor: "#265260",
    borderRadius: 14,
    padding: 12,
    backgroundColor: "#0d2832",
    gap: 8,
  },
  sectionTitle: {
    color: "#f1fbff",
    fontSize: 16,
    fontWeight: "700",
  },
  sectionSubtitle: {
    color: "#d2eaf5",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 6,
  },
  label: {
    color: "#97b4c0",
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderColor: "#3a6573",
    borderRadius: 10,
    color: "#f1fbff",
    backgroundColor: "#112f39",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tokenInput: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  toggleRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  toggleButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#3a6573",
    borderRadius: 999,
    paddingVertical: 9,
    alignItems: "center",
  },
  toggleButtonActive: {
    backgroundColor: "#27c8d7",
    borderColor: "#27c8d7",
  },
  toggleText: {
    color: "#b9d3dd",
    fontWeight: "600",
  },
  toggleTextActive: {
    color: "#04232b",
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignItems: "center",
  },
  buttonPrimary: {
    backgroundColor: "#27c8d7",
  },
  buttonDanger: {
    backgroundColor: "#ff706d",
  },
  buttonGhost: {
    borderWidth: 1,
    borderColor: "#5d8593",
  },
  buttonText: {
    color: "#04232b",
    fontWeight: "700",
    fontSize: 12,
  },
  buttonGhostText: {
    color: "#d2eaf5",
    fontWeight: "700",
    fontSize: 12,
  },
  orderCard: {
    borderWidth: 1,
    borderColor: "#2e5664",
    borderRadius: 12,
    backgroundColor: "#113341",
    padding: 10,
    gap: 6,
  },
  orderTitle: {
    color: "#f1fbff",
    fontSize: 15,
    fontWeight: "700",
  },
  orderMeta: {
    color: "#b3cdda",
    fontSize: 12,
  },
  statusWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 2,
  },
  statusButton: {
    borderWidth: 1,
    borderColor: "#567d8b",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusButtonActive: {
    backgroundColor: "#1b4b59",
    borderColor: "#27c8d7",
  },
  statusButtonText: {
    color: "#d2eaf5",
    fontSize: 11,
    fontWeight: "600",
  },
  driverCard: {
    borderWidth: 1,
    borderColor: "#2f5967",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#123440",
  },
  driverTitle: {
    color: "#f1fbff",
    fontWeight: "700",
  },
  metaText: {
    color: "#9ab7c3",
    fontSize: 12,
  },
  footerMessage: {
    color: "#9ab7c3",
    fontSize: 12,
    marginTop: 8,
  },
});
