import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import * as Location from "expo-location";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import MapView, { Marker, Polyline, Region } from "react-native-maps";
import SignatureScreen from "react-native-signature-canvas";

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

type RouteContextPoint = {
  latitude: number;
  longitude: number;
};

type RouteOptimizedStop = {
  sequence: number;
  order_id: string;
  lat: number;
  lng: number;
  address?: string | null;
  distance_from_previous_meters: number;
  duration_from_previous_seconds: number;
};

type RouteOptimizeResponse = {
  matrix_source: string;
  total_distance_meters: number;
  total_duration_seconds: number;
  ordered_stops: RouteOptimizedStop[];
};

type PodPresignUpload = {
  artifact_type: "photo" | "signature";
  key: string;
  url: string;
  fields: Record<string, string>;
};

type QueuedOperation =
  | {
      id: string;
      created_at: string;
      type: "driver_status";
      order_id: string;
      status: string;
    }
  | {
      id: string;
      created_at: string;
      type: "driver_location";
      lat: number;
      lng: number;
      heading: number | null;
    };

const STORAGE_KEY = "discra_mobile_config_v2";
const STORAGE_QUEUE_KEY = "discra_mobile_queue_v1";
const DEFAULT_API_BASE = "http://127.0.0.1:3000/dev/backend";
const REDIRECT_URI = "discra-mobile://auth/callback";
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

function normalizeDomain(value: string): string {
  return (value || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function parseHashParams(url: string): URLSearchParams {
  const hashIndex = url.indexOf("#");
  if (hashIndex < 0) {
    return new URLSearchParams();
  }
  return new URLSearchParams(url.slice(hashIndex + 1));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = (token || "").split(".");
  if (parts.length < 2 || !parts[1] || typeof globalThis.atob !== "function") {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch (error) {
    return null;
  }
}

function roleSummary(token: string): string {
  return extractTokenGroups(token).join(", ");
}

function extractTokenGroups(token: string): string[] {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return [];
  }
  const groups = payload["cognito:groups"] ?? payload.groups;
  if (Array.isArray(groups)) {
    return groups.map((item) => String(item));
  }
  if (groups) {
    return [String(groups)];
  }
  return [];
}

function looksLikeJwt(token: string): boolean {
  const trimmed = (token || "").trim();
  return trimmed.split(".").length >= 2;
}

function looksLikeBackendApiBase(url: string): boolean {
  const value = normalizeApiBase(url);
  return value.endsWith("/backend");
}

function inferContentType(uri: string, fallback: string): string {
  const lower = (uri || "").toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return fallback;
}

function buildMapRegion(drivers: DriverLocationRecord[]): Region | null {
  if (!drivers.length) {
    return null;
  }
  if (drivers.length === 1) {
    return {
      latitude: drivers[0].lat,
      longitude: drivers[0].lng,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    };
  }

  const latitudes = drivers.map((driver) => driver.lat);
  const longitudes = drivers.map((driver) => driver.lng);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);

  const latitude = (minLat + maxLat) / 2;
  const longitude = (minLng + maxLng) / 2;
  const latitudeDelta = Math.max((maxLat - minLat) * 1.5, 0.04);
  const longitudeDelta = Math.max((maxLng - minLng) * 1.5, 0.04);

  return {
    latitude,
    longitude,
    latitudeDelta,
    longitudeDelta,
  };
}

function tryParseLatLng(value: string): RouteContextPoint | null {
  const text = (value || "").trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/);
  if (!match) {
    return null;
  }
  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return {
    latitude: lat,
    longitude: lng,
  };
}

function formatDistanceMiles(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) {
    return "-";
  }
  const miles = meters / 1609.344;
  return `${miles.toFixed(1)} mi`;
}

function formatDurationShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
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
  const [cognitoDomain, setCognitoDomain] = useState("");
  const [cognitoClientId, setCognitoClientId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>("admin");
  const [statusMessage, setStatusMessage] = useState("Configure API base and JWT to begin.");
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [inboxOrders, setInboxOrders] = useState<OrderRecord[]>([]);
  const [drivers, setDrivers] = useState<DriverLocationRecord[]>([]);
  const [assignInputs, setAssignInputs] = useState<Record<string, string>>({});
  const [podNotes, setPodNotes] = useState<Record<string, string>>({});
  const [podPhotoUris, setPodPhotoUris] = useState<Record<string, string>>({});
  const [podSignatureData, setPodSignatureData] = useState<Record<string, string>>({});
  const [podSubmitting, setPodSubmitting] = useState<Record<string, boolean>>({});
  const [signatureOrderId, setSignatureOrderId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedOperation[]>([]);
  const [autoShareOn, setAutoShareOn] = useState(false);
  const [adminMapRegion, setAdminMapRegion] = useState<Region | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [routePlanDriverId, setRoutePlanDriverId] = useState<string | null>(null);
  const [selectedDriverRoutePlan, setSelectedDriverRoutePlan] = useState<RouteOptimizeResponse | null>(null);
  const [routePlanError, setRoutePlanError] = useState("");
  const [isRoutePlanLoading, setIsRoutePlanLoading] = useState(false);
  const locationTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([AsyncStorage.getItem(STORAGE_KEY), AsyncStorage.getItem(STORAGE_QUEUE_KEY)])
      .then(([configRaw, queueRaw]) => {
        if (!mounted) {
          return;
        }

        if (configRaw) {
          const parsed = JSON.parse(configRaw) as {
            apiBase?: string;
            token?: string;
            workspace?: Workspace;
            cognitoDomain?: string;
            cognitoClientId?: string;
          };
          if (parsed.apiBase) {
            setApiBase(parsed.apiBase);
          }
          if (parsed.token) {
            setToken(parsed.token);
          }
          if (parsed.workspace === "admin" || parsed.workspace === "driver") {
            setWorkspace(parsed.workspace);
          }
          if (parsed.cognitoDomain) {
            setCognitoDomain(parsed.cognitoDomain);
          }
          if (parsed.cognitoClientId) {
            setCognitoClientId(parsed.cognitoClientId);
          }
        }

        if (queueRaw) {
          const parsedQueue = JSON.parse(queueRaw) as QueuedOperation[];
          if (Array.isArray(parsedQueue)) {
            setQueue(parsedQueue);
          }
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
        cognitoDomain: normalizeDomain(cognitoDomain),
        cognitoClientId: cognitoClientId.trim(),
      })
    ).catch(() => undefined);
  }, [apiBase, token, workspace, cognitoDomain, cognitoClientId]);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_QUEUE_KEY, JSON.stringify(queue)).catch(() => undefined);
  }, [queue]);

  useEffect(() => {
    return () => {
      if (locationTimer.current) {
        clearInterval(locationTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      consumeHostedCallback(event.url);
    });
    Linking.getInitialURL()
      .then((initialUrl) => {
        if (initialUrl) {
          consumeHostedCallback(initialUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      subscription.remove();
    };
  }, []);

  const tokenRoleText = useMemo(() => roleSummary(token), [token]);
  const tokenGroups = useMemo(() => extractTokenGroups(token), [token]);
  const workspaceAllowed = useMemo(() => {
    if (workspace === "admin") {
      return tokenGroups.includes("Admin") || tokenGroups.includes("Dispatcher");
    }
    return tokenGroups.includes("Driver");
  }, [tokenGroups, workspace]);
  const sessionValidationMessage = useMemo(() => {
    if (!normalizeApiBase(apiBase)) {
      return "API base URL is required.";
    }
    if (!looksLikeBackendApiBase(apiBase)) {
      return "API base should end with /backend (example: .../dev/backend).";
    }
    if (!token.trim()) {
      return "JWT token is required.";
    }
    if (!looksLikeJwt(token)) {
      return "JWT token format appears invalid.";
    }
    if (workspace === "admin" && !workspaceAllowed) {
      return "Admin/Dispatcher workspace requires Admin or Dispatcher role.";
    }
    if (workspace === "driver" && !workspaceAllowed) {
      return "Driver workspace requires Driver role.";
    }
    return "";
  }, [apiBase, token, workspace, workspaceAllowed]);
  const selectedDriver = useMemo(
    () => drivers.find((driver) => driver.driver_id === selectedDriverId) || null,
    [drivers, selectedDriverId]
  );
  const selectedDriverOrders = useMemo(() => {
    if (!selectedDriverId) {
      return [];
    }
    return orders.filter((order) => order.assigned_to === selectedDriverId);
  }, [orders, selectedDriverId]);
  const selectedRoutePlan = useMemo(() => {
    if (!selectedDriverId) {
      return null;
    }
    if (routePlanDriverId !== selectedDriverId) {
      return null;
    }
    return selectedDriverRoutePlan;
  }, [selectedDriverId, routePlanDriverId, selectedDriverRoutePlan]);
  const selectedDriverRoutePoints = useMemo<RouteContextPoint[]>(() => {
    if (!selectedDriver) {
      return [];
    }
    const points: RouteContextPoint[] = [{ latitude: selectedDriver.lat, longitude: selectedDriver.lng }];
    if (selectedRoutePlan?.ordered_stops?.length) {
      for (const stop of selectedRoutePlan.ordered_stops) {
        points.push({ latitude: stop.lat, longitude: stop.lng });
      }
      return points;
    }
    for (const order of selectedDriverOrders) {
      const parsed = tryParseLatLng(order.delivery);
      if (parsed) {
        points.push(parsed);
      }
    }
    return points;
  }, [selectedDriver, selectedDriverOrders, selectedRoutePlan]);

  function setMessage(message: string) {
    setStatusMessage(message);
  }

  function ensureWorkspaceAccess(): boolean {
    if (sessionValidationMessage) {
      setMessage(sessionValidationMessage);
      return false;
    }
    return true;
  }

  async function withLoading(action: () => Promise<void>) {
    setIsLoading(true);
    try {
      await action();
    } finally {
      setIsLoading(false);
    }
  }

  async function loadDriverRoutePlan(driverId: string, silent: boolean) {
    if (!driverId) {
      setRoutePlanDriverId(null);
      setSelectedDriverRoutePlan(null);
      setRoutePlanError("");
      return;
    }

    setIsRoutePlanLoading(true);
    setRoutePlanError("");
    try {
      const routePlan = await apiRequest<RouteOptimizeResponse>(apiBase, "/routes/optimize", {
        method: "POST",
        token,
        json: { driver_id: driverId },
      });
      setRoutePlanDriverId(driverId);
      setSelectedDriverRoutePlan(routePlan);
      if (!silent) {
        setMessage(
          `Optimized ${routePlan.ordered_stops.length} stops (${formatDistanceMiles(routePlan.total_distance_meters)}, ${formatDurationShort(routePlan.total_duration_seconds)}).`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to optimize route.";
      setRoutePlanDriverId(driverId);
      setSelectedDriverRoutePlan(null);
      setRoutePlanError(message);
      if (!silent) {
        setMessage(message);
      }
    } finally {
      setIsRoutePlanLoading(false);
    }
  }

  function routeStopDestination(stop: RouteOptimizedStop): string {
    const address = (stop.address || "").trim();
    if (address) {
      return address;
    }
    return `${stop.lat},${stop.lng}`;
  }

  function enqueueOperation(operation: QueuedOperation) {
    setQueue((current) => [...current, operation]);
  }

  async function executeQueuedOperation(operation: QueuedOperation) {
    if (operation.type === "driver_status") {
      await apiRequest<OrderRecord>(apiBase, `/orders/${operation.order_id}/status`, {
        method: "POST",
        token,
        json: { status: operation.status },
      });
      return;
    }
    await apiRequest(apiBase, "/drivers/location", {
      method: "POST",
      token,
      json: {
        lat: operation.lat,
        lng: operation.lng,
        heading: operation.heading,
      },
    });
  }

  async function flushQueue(silent: boolean = false) {
    if (!ensureWorkspaceAccess()) {
      if (silent) {
        return;
      }
      return;
    }
    if (!queue.length) {
      if (!silent) {
        setMessage("No queued driver events.");
      }
      return;
    }

    await withLoading(async () => {
      let synced = 0;
      for (let index = 0; index < queue.length; index += 1) {
        const operation = queue[index];
        try {
          await executeQueuedOperation(operation);
          synced += 1;
        } catch (error) {
          const remaining = queue.slice(index);
          setQueue(remaining);
          if (!silent) {
            setMessage(`Synced ${synced} event(s). ${remaining.length} still queued.`);
          }
          return;
        }
      }
      setQueue([]);
      if (!silent) {
        setMessage(`Synced ${synced} queued event(s).`);
      }
    });
  }

  async function startHostedLogin() {
    const domain = normalizeDomain(cognitoDomain);
    const clientId = cognitoClientId.trim();
    if (!domain || !clientId) {
      setMessage("Cognito Hosted UI domain and client ID are required.");
      return;
    }
    const params = new URLSearchParams();
    params.set("client_id", clientId);
    params.set("response_type", "token");
    params.set("scope", "openid email profile");
    params.set("redirect_uri", REDIRECT_URI);
    await Linking.openURL(`https://${domain}/login?${params.toString()}`);
  }

  async function logoutHostedLogin() {
    const domain = normalizeDomain(cognitoDomain);
    const clientId = cognitoClientId.trim();
    setToken("");
    if (!domain || !clientId) {
      setMessage("Token cleared.");
      return;
    }
    const params = new URLSearchParams();
    params.set("client_id", clientId);
    params.set("logout_uri", REDIRECT_URI);
    await Linking.openURL(`https://${domain}/logout?${params.toString()}`);
    setMessage("Hosted UI logout launched.");
  }

  function consumeHostedCallback(url: string) {
    const params = parseHashParams(url);
    const idToken = params.get("id_token");
    const accessToken = params.get("access_token");
    const error = params.get("error");
    const errorDescription = params.get("error_description");
    if (error) {
      setMessage(errorDescription || error);
      return;
    }
    const nextToken = (idToken || accessToken || "").trim();
    if (!nextToken) {
      return;
    }
    setToken(nextToken);
    setMessage("Hosted UI login complete.");
  }

  async function capturePodPhoto(orderId: string) {
    const cameraPerm = await ImagePicker.requestCameraPermissionsAsync();
    if (!cameraPerm.granted) {
      setMessage("Camera permission is required for POD photo.");
      return;
    }
    const captured = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });
    if (captured.canceled || !captured.assets.length) {
      return;
    }
    const asset = captured.assets[0];
    if (!asset.uri) {
      setMessage("Could not capture photo.");
      return;
    }
    setPodPhotoUris((current) => ({ ...current, [orderId]: asset.uri }));
    setMessage("POD photo captured.");
  }

  function onSignatureSaved(signatureDataUrl: string) {
    if (!signatureOrderId) {
      return;
    }
    setPodSignatureData((current) => ({ ...current, [signatureOrderId]: signatureDataUrl }));
    setSignatureOrderId(null);
    setMessage("Signature saved.");
  }

  function clearPodPhoto(orderId: string) {
    setPodPhotoUris((current) => {
      const next = { ...current };
      delete next[orderId];
      return next;
    });
  }

  function clearPodSignature(orderId: string) {
    setPodSignatureData((current) => {
      const next = { ...current };
      delete next[orderId];
      return next;
    });
  }

  async function writeSignatureTempFile(orderId: string, dataUrl: string) {
    const marker = "base64,";
    const markerIndex = dataUrl.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error("Invalid signature payload.");
    }
    const base64Data = dataUrl.slice(markerIndex + marker.length);
    const directory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    if (!directory) {
      throw new Error("No writable cache directory available.");
    }
    const fileUri = `${directory}pod-signature-${orderId}-${Date.now()}.png`;
    await FileSystem.writeAsStringAsync(fileUri, base64Data, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const info = await FileSystem.getInfoAsync(fileUri, { size: true });
    if (!info.exists) {
      throw new Error("Signature file creation failed.");
    }
    const size = typeof info.size === "number" && Number.isFinite(info.size) ? info.size : 0;
    return {
      uri: fileUri,
      size,
      contentType: "image/png",
      fileName: `signature-${Date.now()}.png`,
      cleanup: async () => {
        await FileSystem.deleteAsync(fileUri, { idempotent: true });
      },
    };
  }

  async function uploadPresignedPost(upload: PodPresignUpload, fileUri: string, fileName: string, contentType: string) {
    const formData = new FormData();
    Object.entries(upload.fields || {}).forEach(([key, value]) => {
      formData.append(key, value);
    });
    formData.append("file", {
      uri: fileUri,
      name: fileName,
      type: contentType,
    } as any);
    const response = await fetch(upload.url, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(`POD upload failed (${response.status})`);
    }
  }

  async function maybeGetPodLocation() {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        return null;
      }
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const headingValue =
        typeof location.coords.heading === "number" && Number.isFinite(location.coords.heading)
          ? location.coords.heading
          : null;
      return {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        heading: headingValue,
      };
    } catch (error) {
      return null;
    }
  }

  async function submitPod(order: OrderRecord) {
    if (!ensureWorkspaceAccess()) {
      return;
    }
    const orderId = order.id;
    const photoUri = podPhotoUris[orderId];
    const signatureDataUrl = podSignatureData[orderId];
    if (!photoUri && !signatureDataUrl) {
      setMessage("Capture a photo or signature before submitting POD.");
      return;
    }

    setPodSubmitting((current) => ({ ...current, [orderId]: true }));
    const cleanupTasks: Array<() => Promise<void>> = [];
    try {
      const artifacts: Array<{
        artifact_type: "photo" | "signature";
        content_type: string;
        file_size_bytes: number;
        file_name: string;
        uri: string;
      }> = [];

      if (photoUri) {
        const info = await FileSystem.getInfoAsync(photoUri, { size: true });
        if (!info.exists) {
          throw new Error("POD photo file is unavailable.");
        }
        const size = typeof info.size === "number" && Number.isFinite(info.size) ? info.size : 0;
        artifacts.push({
          artifact_type: "photo",
          content_type: inferContentType(photoUri, "image/jpeg"),
          file_size_bytes: size,
          file_name: `photo-${Date.now()}.jpg`,
          uri: photoUri,
        });
      }

      if (signatureDataUrl) {
        const tempFile = await writeSignatureTempFile(orderId, signatureDataUrl);
        cleanupTasks.push(tempFile.cleanup);
        artifacts.push({
          artifact_type: "signature",
          content_type: tempFile.contentType,
          file_size_bytes: tempFile.size,
          file_name: tempFile.fileName,
          uri: tempFile.uri,
        });
      }

      const presign = await apiRequest<{ uploads: PodPresignUpload[] }>(apiBase, "/pod/presign", {
        method: "POST",
        token,
        json: {
          order_id: orderId,
          artifacts: artifacts.map((item) => ({
            artifact_type: item.artifact_type,
            content_type: item.content_type,
            file_size_bytes: Math.max(item.file_size_bytes, 1),
            file_name: item.file_name,
          })),
        },
      });

      const photoKeys: string[] = [];
      const signatureKeys: string[] = [];
      for (let index = 0; index < presign.uploads.length; index += 1) {
        const upload = presign.uploads[index];
        const artifact = artifacts[index];
        if (!artifact) {
          continue;
        }
        await uploadPresignedPost(upload, artifact.uri, artifact.file_name, artifact.content_type);
        if (upload.artifact_type === "photo") {
          photoKeys.push(upload.key);
        } else {
          signatureKeys.push(upload.key);
        }
      }

      const location = await maybeGetPodLocation();
      await apiRequest(apiBase, "/pod/metadata", {
        method: "POST",
        token,
        json: {
          order_id: orderId,
          photo_keys: photoKeys,
          signature_keys: signatureKeys,
          notes: podNotes[orderId] || null,
          location: location || null,
        },
      });

      await updateOrderStatus(orderId, "Delivered", "driver");
      clearPodPhoto(orderId);
      clearPodSignature(orderId);
      setPodNotes((current) => ({ ...current, [orderId]: "" }));
      setMessage("POD submitted and delivery marked complete.");
    } finally {
      for (const cleanup of cleanupTasks) {
        try {
          await cleanup();
        } catch (error) {
          // no-op
        }
      }
      setPodSubmitting((current) => ({ ...current, [orderId]: false }));
    }
  }

  async function refreshAdminData() {
    if (!ensureWorkspaceAccess()) {
      return;
    }
    await withLoading(async () => {
      const [ordersResponse, driversResponse] = await Promise.all([
        apiRequest<OrderRecord[]>(apiBase, "/orders/", { token }),
        apiRequest<DriverLocationRecord[]>(apiBase, "/drivers?active_minutes=120", { token }),
      ]);
      setOrders(ordersResponse || []);
      setDrivers(driversResponse || []);
      setAdminMapRegion(buildMapRegion(driversResponse || []));
      let nextSelectedDriverId: string | null = null;
      if (driversResponse && driversResponse.length) {
        if (selectedDriverId && driversResponse.some((driver) => driver.driver_id === selectedDriverId)) {
          nextSelectedDriverId = selectedDriverId;
        } else {
          nextSelectedDriverId = driversResponse[0].driver_id;
        }
      }
      setSelectedDriverId(nextSelectedDriverId);
      await loadDriverRoutePlan(nextSelectedDriverId || "", true);
      setMessage(`Loaded ${ordersResponse.length} orders and ${driversResponse.length} active drivers.`);
    });
  }

  function focusDriverOnMap(driver: DriverLocationRecord) {
    setSelectedDriverId(driver.driver_id);
    setAdminMapRegion({
      latitude: driver.lat,
      longitude: driver.lng,
      latitudeDelta: 0.04,
      longitudeDelta: 0.04,
    });
    loadDriverRoutePlan(driver.driver_id, true).catch(() => undefined);
  }

  async function optimizeSelectedDriverRoute() {
    if (!ensureWorkspaceAccess()) {
      return;
    }
    if (!selectedDriver) {
      setMessage("Select an active driver first.");
      return;
    }
    await withLoading(async () => {
      await loadDriverRoutePlan(selectedDriver.driver_id, false);
    });
  }

  async function openSelectedDriverRoute() {
    if (!selectedDriver) {
      setMessage("Select an active driver first.");
      return;
    }
    const routeStops = selectedRoutePlan?.ordered_stops || [];
    if (routeStops.length) {
      const destination = routeStopDestination(routeStops[routeStops.length - 1]);
      const waypoints = routeStops.slice(0, -1).map((stop) => routeStopDestination(stop));
      const params = new URLSearchParams();
      params.set("api", "1");
      params.set("origin", `${selectedDriver.lat},${selectedDriver.lng}`);
      params.set("destination", destination);
      if (waypoints.length) {
        params.set("waypoints", waypoints.join("|"));
      }
      params.set("travelmode", "driving");
      await Linking.openURL(`https://www.google.com/maps/dir/?${params.toString()}`);
      return;
    }
    if (!selectedDriverOrders.length) {
      setMessage("Selected driver has no assigned orders.");
      return;
    }
    const firstStop = selectedDriverOrders[0];
    const params = new URLSearchParams();
    params.set("api", "1");
    params.set("origin", `${selectedDriver.lat},${selectedDriver.lng}`);
    params.set("destination", firstStop.delivery);
    params.set("travelmode", "driving");
    await Linking.openURL(`https://www.google.com/maps/dir/?${params.toString()}`);
  }

  async function refreshDriverInbox() {
    if (!ensureWorkspaceAccess()) {
      return;
    }
    await withLoading(async () => {
      const response = await apiRequest<OrderRecord[]>(apiBase, "/orders/driver/inbox", { token });
      setInboxOrders(response || []);
      setMessage(`Loaded ${response.length} assigned orders.`);
      await flushQueue(true);
    });
  }

  async function assignOrder(orderId: string) {
    if (!ensureWorkspaceAccess()) {
      return;
    }
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
    if (!ensureWorkspaceAccess()) {
      return;
    }
    await withLoading(async () => {
      await apiRequest<OrderRecord>(apiBase, `/orders/${orderId}/unassign`, {
        method: "POST",
        token,
      });
      await refreshAdminData();
    });
  }

  async function updateOrderStatus(orderId: string, status: string, nextWorkspace: Workspace) {
    if (!ensureWorkspaceAccess()) {
      return;
    }
    await withLoading(async () => {
      try {
        await apiRequest<OrderRecord>(apiBase, `/orders/${orderId}/status`, {
          method: "POST",
          token,
          json: { status },
        });
      } catch (error) {
        if (nextWorkspace === "driver") {
          enqueueOperation({
            id: `${Date.now()}-status-${orderId}-${status}`,
            created_at: new Date().toISOString(),
            type: "driver_status",
            order_id: orderId,
            status,
          });
          setMessage(`Queued status ${status} for retry sync.`);
          return;
        }
        throw error;
      }
      if (nextWorkspace === "admin") {
        await refreshAdminData();
      } else {
        await refreshDriverInbox();
      }
    });
  }

  async function sendDriverLocation() {
    if (!ensureWorkspaceAccess()) {
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
      const payload = {
        lat: location.coords.latitude,
        lng: location.coords.longitude,
        heading: headingValue,
      };
      try {
        await apiRequest(apiBase, "/drivers/location", {
          method: "POST",
          token,
          json: payload,
        });
        setMessage(
          `Sent location at ${new Date().toLocaleTimeString()} (${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}).`
        );
      } catch (error) {
        enqueueOperation({
          id: `${Date.now()}-location`,
          created_at: new Date().toISOString(),
          type: "driver_location",
          lat: payload.lat,
          lng: payload.lng,
          heading: payload.heading,
        });
        setMessage("Location send failed; queued for retry.");
      }
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
    if (!ensureWorkspaceAccess()) {
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
          <Text style={styles.label}>Cognito Hosted UI Domain</Text>
          <TextInput
            value={cognitoDomain}
            onChangeText={setCognitoDomain}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="your-domain.auth.us-east-1.amazoncognito.com"
            placeholderTextColor="#6f8d98"
          />
          <Text style={styles.label}>Cognito App Client ID</Text>
          <TextInput
            value={cognitoClientId}
            onChangeText={setCognitoClientId}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="app client id"
            placeholderTextColor="#6f8d98"
          />
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => startHostedLogin().catch(onError)}>
              <Text style={styles.buttonText}>Login Hosted UI</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => logoutHostedLogin().catch(onError)}>
              <Text style={styles.buttonGhostText}>Logout Hosted UI</Text>
            </Pressable>
          </View>
          <Text style={styles.label}>JWT Token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.tokenInput]}
            multiline
            placeholder="Paste JWT or login via Hosted UI"
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
          {tokenRoleText ? <Text style={styles.metaText}>Token roles: {tokenRoleText}</Text> : null}
          {queue.length ? <Text style={styles.metaText}>Queued driver events: {queue.length}</Text> : null}
          {sessionValidationMessage ? <Text style={styles.validationText}>{sessionValidationMessage}</Text> : null}
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
            {drivers.length && adminMapRegion ? (
              <MapView
                style={styles.mapView}
                region={adminMapRegion}
                onRegionChangeComplete={setAdminMapRegion}
                showsUserLocation={false}
              >
                {drivers.map((driver) => (
                  <Marker
                    key={`marker-${driver.driver_id}`}
                    coordinate={{ latitude: driver.lat, longitude: driver.lng }}
                    pinColor={driver.driver_id === selectedDriverId ? "#ffb347" : "#27c8d7"}
                    title={driver.driver_id}
                    description={formatTime(driver.timestamp)}
                  />
                ))}
                {selectedDriverRoutePoints.length > 1 ? (
                  <Polyline coordinates={selectedDriverRoutePoints} strokeColor="#ffb347" strokeWidth={3} />
                ) : null}
              </MapView>
            ) : (
              <Text style={styles.metaText}>No active drivers to display on the map.</Text>
            )}
            <View style={styles.routeContextCard}>
              <Text style={styles.sectionSubtitle}>Route Context</Text>
              <Text style={styles.metaText}>
                Selected driver: {selectedDriver ? selectedDriver.driver_id : "None"}
              </Text>
              {selectedRoutePlan ? (
                <Text style={styles.metaText}>
                  Optimized via {selectedRoutePlan.matrix_source}:{" "}
                  {formatDistanceMiles(selectedRoutePlan.total_distance_meters)} /{" "}
                  {formatDurationShort(selectedRoutePlan.total_duration_seconds)}
                </Text>
              ) : (
                <Text style={styles.metaText}>No optimized route loaded yet.</Text>
              )}
              {isRoutePlanLoading ? <Text style={styles.metaText}>Optimizing route...</Text> : null}
              {routePlanError && routePlanDriverId === selectedDriverId ? (
                <Text style={styles.validationText}>{routePlanError}</Text>
              ) : null}
              <View style={styles.row}>
                <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => optimizeSelectedDriverRoute().catch(onError)}>
                  <Text style={styles.buttonText}>Optimize Route</Text>
                </Pressable>
                <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => openSelectedDriverRoute().catch(onError)}>
                  <Text style={styles.buttonGhostText}>Open Route in Maps</Text>
                </Pressable>
              </View>
              {selectedRoutePlan && selectedRoutePlan.ordered_stops.length ? (
                selectedRoutePlan.ordered_stops.map((stop) => {
                  const order = orders.find((candidate) => candidate.id === stop.order_id);
                  return (
                    <View key={`route-order-${stop.order_id}`} style={styles.routeStopCard}>
                      <Text style={styles.routeStopTitle}>
                        {stop.sequence}. {order ? `#${order.reference_number} - ${order.customer_name}` : stop.order_id}
                      </Text>
                      <Text style={styles.metaText}>Delivery: {stop.address || routeStopDestination(stop)}</Text>
                      <Text style={styles.metaText}>
                        Leg: {formatDistanceMiles(stop.distance_from_previous_meters)} /{" "}
                        {formatDurationShort(stop.duration_from_previous_seconds)}
                      </Text>
                    </View>
                  );
                })
              ) : selectedDriverOrders.length ? (
                selectedDriverOrders.map((order) => (
                  <View key={`route-order-${order.id}`} style={styles.routeStopCard}>
                    <Text style={styles.routeStopTitle}>
                      #{order.reference_number} - {order.customer_name} ({order.status})
                    </Text>
                    <Text style={styles.metaText}>Delivery: {order.delivery}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.metaText}>No assigned stops for selected driver.</Text>
              )}
            </View>
            {orders.map((order) => (
              <View key={order.id} style={styles.orderCard}>
                <Text style={styles.orderTitle}>{order.customer_name}</Text>
                <Text style={styles.orderMeta}>
                  #{order.reference_number} - {order.status} - Assigned: {order.assigned_to || "-"}
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
                style={[styles.driverCard, driver.driver_id === selectedDriverId && styles.driverCardSelected]}
                onPress={() => focusDriverOnMap(driver)}
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
              <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => flushQueue(false).catch(onError)}>
                <Text style={styles.buttonGhostText}>Sync Queue ({queue.length})</Text>
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
                  #{order.reference_number} - {order.status}
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
                <View style={styles.podSection}>
                  <Text style={styles.podTitle}>Proof Of Delivery</Text>
                  {podPhotoUris[order.id] ? (
                    <Image source={{ uri: podPhotoUris[order.id] }} style={styles.podPhotoPreview} />
                  ) : (
                    <Text style={styles.metaText}>No POD photo captured.</Text>
                  )}
                  <View style={styles.row}>
                    <Pressable
                      style={[styles.button, styles.buttonPrimary]}
                      onPress={() => capturePodPhoto(order.id).catch(onError)}
                    >
                      <Text style={styles.buttonText}>Capture Photo</Text>
                    </Pressable>
                    {podPhotoUris[order.id] ? (
                      <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => clearPodPhoto(order.id)}>
                        <Text style={styles.buttonGhostText}>Clear Photo</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.row}>
                    <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => setSignatureOrderId(order.id)}>
                      <Text style={styles.buttonText}>
                        {podSignatureData[order.id] ? "Re-Capture Signature" : "Capture Signature"}
                      </Text>
                    </Pressable>
                    {podSignatureData[order.id] ? (
                      <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => clearPodSignature(order.id)}>
                        <Text style={styles.buttonGhostText}>Clear Signature</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Text style={styles.metaText}>
                    {podSignatureData[order.id] ? "Signature captured." : "No signature captured."}
                  </Text>
                  <TextInput
                    style={styles.input}
                    value={podNotes[order.id] || ""}
                    onChangeText={(value) => setPodNotes((current) => ({ ...current, [order.id]: value }))}
                    placeholder="Delivery notes"
                    placeholderTextColor="#6f8d98"
                    multiline
                  />
                  <Pressable
                    style={[styles.button, styles.buttonPrimary]}
                    onPress={() => submitPod(order).catch(onError)}
                    disabled={!!podSubmitting[order.id]}
                  >
                    <Text style={styles.buttonText}>
                      {podSubmitting[order.id] ? "Submitting POD..." : "Submit POD + Mark Delivered"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {inboxOrders.length === 0 ? <Text style={styles.metaText}>No assigned orders.</Text> : null}
          </View>
        )}

        <Modal visible={!!signatureOrderId} transparent animationType="slide" onRequestClose={() => setSignatureOrderId(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.sectionTitle}>Capture Signature</Text>
              <View style={styles.signatureWrap}>
                <SignatureScreen
                  onOK={onSignatureSaved}
                  onEmpty={() => setMessage("Draw a signature before saving.")}
                  clearText="Clear"
                  confirmText="Save"
                  descriptionText="Sign below"
                  autoClear
                  webStyle={`
                    .m-signature-pad--footer { background: #0d2832; }
                    .m-signature-pad--body { border: 1px solid #2e5664; }
                    .button { background: #27c8d7; color: #04232b; border-radius: 8px; }
                  `}
                />
              </View>
              <Pressable style={[styles.button, styles.buttonGhost]} onPress={() => setSignatureOrderId(null)}>
                <Text style={styles.buttonGhostText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

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
  driverCardSelected: {
    borderColor: "#ffb347",
    backgroundColor: "#1a3c49",
  },
  driverTitle: {
    color: "#f1fbff",
    fontWeight: "700",
  },
  mapView: {
    width: "100%",
    height: 220,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2f5967",
    backgroundColor: "#102731",
  },
  routeContextCard: {
    borderWidth: 1,
    borderColor: "#2f5967",
    borderRadius: 10,
    padding: 10,
    gap: 8,
    backgroundColor: "#123440",
  },
  routeStopCard: {
    borderWidth: 1,
    borderColor: "#355f6d",
    borderRadius: 8,
    padding: 8,
    backgroundColor: "#173948",
  },
  routeStopTitle: {
    color: "#dff4ff",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
  },
  podSection: {
    borderTopWidth: 1,
    borderTopColor: "#2f5967",
    paddingTop: 8,
    gap: 8,
  },
  podTitle: {
    color: "#d2eaf5",
    fontSize: 13,
    fontWeight: "700",
  },
  podPhotoPreview: {
    width: "100%",
    height: 160,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2f5967",
    backgroundColor: "#0e2630",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(4, 16, 24, 0.85)",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    backgroundColor: "#0d2832",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2f5967",
    padding: 12,
    gap: 10,
    maxHeight: "85%",
  },
  signatureWrap: {
    height: 280,
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#2f5967",
    backgroundColor: "#f7fcff",
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
  validationText: {
    color: "#ffb347",
    fontSize: 12,
    fontWeight: "600",
  },
});
