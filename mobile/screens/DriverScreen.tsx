// DriverScreen.tsx — Full-screen map + bottom sheet driver experience
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
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
import {
  OrderRecord,
  OsrmResult,
  PodPresignUpload,
  ProfilePhotoPresignResponse,
  RouteStep,
  UserProfile,
  apiRequest,
  deliveryAddress,
  fetchOsrmRoute,
  formatDistanceMiles,
  formatDurationShort,
  formatTime,
  geocodeAddress,
  haversineDistance,
  orderReference,
  pickupAddress,
} from "../lib";

// ─── Constants ────────────────────────────────────────────────────────────────

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const PEEK_HEIGHT = 160;
const SHEET_HEIGHT = Math.round(SCREEN_HEIGHT * 0.72);
const SHEET_OPEN_Y = 0;
const SHEET_CLOSED_Y = SHEET_HEIGHT - PEEK_HEIGHT;
const DRIVER_STATUS = ["PickedUp", "EnRoute", "Failed", "Delivered"] as const;
const AUSTIN_REGION: Region = {
  latitude: 30.2672,
  longitude: -97.7431,
  latitudeDelta: 8,
  longitudeDelta: 8,
};

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "stops" | "directions";

type PodState = {
  photoUri: string | null;
  signatureData: string | null;
  notes: string;
  submitting: boolean;
};

type Props = {
  token: string;
  apiBase: string;
  onSignOut: () => void;
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function DriverScreen({ token, apiBase, onSignOut }: Props) {
  // ── Map state ──────────────────────────────────────────────────────────────
  const [mapRegion, setMapRegion] = useState<Region>(AUSTIN_REGION);
  const [driverLoc, setDriverLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [routeResult, setRouteResult] = useState<OsrmResult | null>(null);

  // ── Order state ────────────────────────────────────────────────────────────
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [orderCoords, setOrderCoords] = useState<Map<string, { lat: number; lng: number }>>(new Map());
  const geocacheRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>("stops");
  const [selectedOrder, setSelectedOrder] = useState<OrderRecord | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [signatureOrderId, setSignatureOrderId] = useState<string | null>(null);
  const [podState, setPodState] = useState<Map<string, PodState>>(new Map());
  const [profileVisible, setProfileVisible] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profilePhone, setProfilePhone] = useState("");
  const [profileEmail, setProfileEmail] = useState("");
  const [profileTsa, setProfileTsa] = useState(false);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [statusMsg, setStatusMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [locationActive, setLocationActive] = useState(false);
  const locationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView | null>(null);

  // ── Bottom sheet animation ─────────────────────────────────────────────────
  const sheetAnim = useRef(new Animated.Value(SHEET_CLOSED_Y)).current;
  const sheetCurrentY = useRef(SHEET_CLOSED_Y);
  const isSheetOpen = useRef(false);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture after a clear vertical move — lets taps and
        // horizontal swipes pass through to buttons and the scroll view.
        onMoveShouldSetPanResponder: (_, gs) =>
          Math.abs(gs.dy) > 6 && Math.abs(gs.dy) > Math.abs(gs.dx),
        onPanResponderGrant: () => {
          // Stop any in-flight spring and latch the real current position so
          // the sheet doesn't jump when the user grabs it mid-animation.
          sheetAnim.stopAnimation((currentValue) => {
            sheetCurrentY.current = currentValue;
          });
        },
        onPanResponderMove: (_, gs) => {
          const next = Math.max(
            SHEET_OPEN_Y,
            Math.min(SHEET_CLOSED_Y, sheetCurrentY.current + gs.dy)
          );
          sheetAnim.setValue(next);
        },
        onPanResponderRelease: (_, gs) => {
          const shouldOpen =
            gs.vy < -0.3 || sheetCurrentY.current + gs.dy < SHEET_CLOSED_Y * 0.5;
          animateSheet(shouldOpen);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  function animateSheet(open: boolean) {
    isSheetOpen.current = open;
    const toValue = open ? SHEET_OPEN_Y : SHEET_CLOSED_Y;
    Animated.spring(sheetAnim, {
      toValue,
      useNativeDriver: true,
      bounciness: 4,
    }).start(() => {
      // Update only after the spring settles so intermediate drags read the
      // correct resting position.
      sheetCurrentY.current = toValue;
    });
  }

  // ── Sorted orders by distance ──────────────────────────────────────────────
  const sortedOrders = useMemo(() => {
    if (!driverLoc || !orders.length) return orders;
    return [...orders].sort((a, b) => {
      const ca = orderCoords.get(a.id);
      const cb = orderCoords.get(b.id);
      const da = ca ? haversineDistance(driverLoc.lat, driverLoc.lng, ca.lat, ca.lng) : Infinity;
      const db = cb ? haversineDistance(driverLoc.lat, driverLoc.lng, cb.lat, cb.lng) : Infinity;
      return da - db;
    });
  }, [orders, orderCoords, driverLoc]);

  // ── Stop pin colour ────────────────────────────────────────────────────────
  function stopPinColor(order: OrderRecord): string {
    const s = (order.status || "").toLowerCase();
    if (s === "pickedup" || s === "enroute") return "#4A9E5C";
    return "#C8973A";
  }

  // ── Geocode all stops ──────────────────────────────────────────────────────
  const geocodeOrders = useCallback(
    async (list: OrderRecord[]) => {
      for (const order of list) {
        const status = (order.status || "").toLowerCase();
        const isDelivery = status === "pickedup" || status === "enroute";
        const address = isDelivery ? deliveryAddress(order) : pickupAddress(order);
        if (!address) continue;
        const coords = await geocodeAddress(address, geocacheRef.current);
        if (coords) {
          setOrderCoords((prev) => {
            const next = new Map(prev);
            next.set(order.id, coords);
            return next;
          });
        }
      }
    },
    []
  );

  // ── Location sharing ───────────────────────────────────────────────────────
  const sendLocation = useCallback(async () => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setStatusMsg("Location permission denied — enable it in Settings.");
        // Stop the repeating timer; no point hammering the permission API.
        if (locationTimerRef.current) {
          clearInterval(locationTimerRef.current);
          locationTimerRef.current = null;
        }
        setLocationActive(false);
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const lat = loc.coords.latitude;
      const lng = loc.coords.longitude;
      const heading =
        typeof loc.coords.heading === "number" && Number.isFinite(loc.coords.heading)
          ? loc.coords.heading
          : null;
      setDriverLoc({ lat, lng });
      setMapRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.04, longitudeDelta: 0.04 });
      await apiRequest(apiBase, "/drivers/location", {
        method: "POST",
        token,
        json: { lat, lng, heading },
      });
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Could not get location.");
    }
  }, [apiBase, token]);

  function startAutoLocation() {
    if (locationTimerRef.current) return;
    sendLocation().catch(() => undefined);
    locationTimerRef.current = setInterval(() => {
      sendLocation().catch(() => undefined);
    }, 30_000);
    setLocationActive(true);
  }

  function stopAutoLocation() {
    if (locationTimerRef.current) {
      clearInterval(locationTimerRef.current);
      locationTimerRef.current = null;
    }
    setLocationActive(false);
  }

  // ── Load inbox ─────────────────────────────────────────────────────────────
  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<OrderRecord[]>(apiBase, "/orders/driver/inbox", { token });
      const list = data || [];
      setOrders(list);
      setStatusMsg(`${list.length} assigned stop${list.length === 1 ? "" : "s"}`);
      geocodeOrders(list).catch(() => undefined);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Failed to load inbox.");
    } finally {
      setLoading(false);
    }
  }, [apiBase, token, geocodeOrders]);

  // ── Update order status ────────────────────────────────────────────────────
  async function updateStatus(orderId: string, status: string) {
    setLoading(true);
    try {
      await apiRequest(apiBase, `/orders/${orderId}/status`, {
        method: "POST",
        token,
        json: { status },
      });
      await loadInbox();
      setStatusMsg(`Status updated: ${status}`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Status update failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Navigate to an order ───────────────────────────────────────────────────
  async function navigateTo(order: OrderRecord) {
    if (!driverLoc) {
      setStatusMsg("Waiting for your location…");
      return;
    }
    const status = (order.status || "").toLowerCase();
    const isDelivery = status === "pickedup" || status === "enroute";
    const address = isDelivery ? deliveryAddress(order) : pickupAddress(order);
    let dest = orderCoords.get(order.id);
    if (!dest && address) {
      dest = (await geocodeAddress(address, geocacheRef.current)) ?? undefined;
    }
    if (!dest) {
      setStatusMsg("Could not geocode destination.");
      return;
    }
    setLoading(true);
    try {
      const result = await fetchOsrmRoute(driverLoc.lat, driverLoc.lng, dest.lat, dest.lng);
      if (result) {
        setRouteResult(result);
        setActiveTab("directions");
        animateSheet(true);
        const miles = formatDistanceMiles(result.distance_meters);
        const dur = formatDurationShort(result.duration_seconds);
        setStatusMsg(`Route: ${miles} · ${dur}`);
        // Fit map to route bounds
        if (result.coords.length > 1 && mapRef.current) {
          mapRef.current.fitToCoordinates(result.coords, {
            edgePadding: { top: 80, right: 40, bottom: PEEK_HEIGHT + 60, left: 40 },
            animated: true,
          });
        }
      }
    } catch (e) {
      setStatusMsg("Navigation error.");
    } finally {
      setLoading(false);
    }
  }

  // ── Select order ───────────────────────────────────────────────────────────
  function selectOrder(order: OrderRecord) {
    setSelectedOrder(order);
    setDetailVisible(true);
    navigateTo(order).catch(() => undefined);
    // Fly to stop pin
    const coord = orderCoords.get(order.id);
    if (coord && mapRef.current) {
      mapRef.current.animateToRegion(
        { latitude: coord.lat, longitude: coord.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 },
        600
      );
    }
  }

  // ── POD helpers ────────────────────────────────────────────────────────────
  function getPodState(orderId: string): PodState {
    return (
      podState.get(orderId) ?? {
        photoUri: null,
        signatureData: null,
        notes: "",
        submitting: false,
      }
    );
  }

  function setPodField<K extends keyof PodState>(orderId: string, key: K, value: PodState[K]) {
    setPodState((prev) => {
      const next = new Map(prev);
      next.set(orderId, { ...getPodState(orderId), [key]: value });
      return next;
    });
  }

  async function capturePodPhoto(orderId: string) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setStatusMsg("Camera permission required."); return; }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (result.canceled || !result.assets.length) return;
    const uri = result.assets[0].uri;
    if (uri) setPodField(orderId, "photoUri", uri);
  }

  function onSignatureSaved(dataUrl: string) {
    if (!signatureOrderId) return;
    setPodField(signatureOrderId, "signatureData", dataUrl);
    setSignatureOrderId(null);
    setStatusMsg("Signature saved.");
  }

  async function submitPod(order: OrderRecord) {
    const pod = getPodState(order.id);
    if (!pod.photoUri && !pod.signatureData) {
      setStatusMsg("Capture a photo or signature before submitting.");
      return;
    }
    setPodField(order.id, "submitting", true);
    const cleanupTasks: Array<() => Promise<void>> = [];
    try {
      const artifacts: Array<{
        artifact_type: "photo" | "signature";
        content_type: string;
        file_size_bytes: number;
        file_name: string;
        uri: string;
      }> = [];

      if (pod.photoUri) {
        const info = await FileSystem.getInfoAsync(pod.photoUri, { size: true });
        if (!info.exists) throw new Error("Photo file unavailable.");
        artifacts.push({
          artifact_type: "photo",
          content_type: pod.photoUri.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
          file_size_bytes: typeof info.size === "number" ? info.size : 1,
          file_name: `photo-${Date.now()}.jpg`,
          uri: pod.photoUri,
        });
      }

      if (pod.signatureData) {
        const marker = "base64,";
        const idx = pod.signatureData.indexOf(marker);
        if (idx < 0) throw new Error("Invalid signature data.");
        const b64 = pod.signatureData.slice(idx + marker.length);
        const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
        if (!dir) throw new Error("No cache directory available.");
        const sigUri = `${dir}sig-${order.id}-${Date.now()}.png`;
        await FileSystem.writeAsStringAsync(sigUri, b64, { encoding: FileSystem.EncodingType.Base64 });
        const sigInfo = await FileSystem.getInfoAsync(sigUri, { size: true });
        cleanupTasks.push(async () => { await FileSystem.deleteAsync(sigUri, { idempotent: true }); });
        artifacts.push({
          artifact_type: "signature",
          content_type: "image/png",
          file_size_bytes: sigInfo.exists && typeof sigInfo.size === "number" ? sigInfo.size : 1,
          file_name: `sig-${Date.now()}.png`,
          uri: sigUri,
        });
      }

      const presign = await apiRequest<{ uploads: PodPresignUpload[] }>(apiBase, "/pod/presign", {
        method: "POST",
        token,
        json: {
          order_id: order.id,
          artifacts: artifacts.map((a) => ({
            artifact_type: a.artifact_type,
            content_type: a.content_type,
            file_size_bytes: Math.max(a.file_size_bytes, 1),
            file_name: a.file_name,
          })),
        },
      });

      const photoKeys: string[] = [];
      const signatureKeys: string[] = [];
      for (let i = 0; i < presign.uploads.length; i++) {
        const upload = presign.uploads[i];
        const artifact = artifacts[i];
        if (!artifact) continue;
        const form = new FormData();
        Object.entries(upload.fields || {}).forEach(([k, v]) => form.append(k, v));
        form.append("file", { uri: artifact.uri, name: artifact.file_name, type: artifact.content_type } as any);
        const uploadResp = await fetch(upload.url, { method: "POST", body: form });
        if (!uploadResp.ok) throw new Error(`Upload failed (${uploadResp.status})`);
        if (upload.artifact_type === "photo") photoKeys.push(upload.key);
        else signatureKeys.push(upload.key);
      }

      // Get location for POD metadata
      let podLocation: { lat: number; lng: number; heading: number | null } | null = null;
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.granted) {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          podLocation = {
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            heading: typeof loc.coords.heading === "number" ? loc.coords.heading : null,
          };
        }
      } catch { /* ok */ }

      await apiRequest(apiBase, "/pod/metadata", {
        method: "POST",
        token,
        json: {
          order_id: order.id,
          photo_keys: photoKeys,
          signature_keys: signatureKeys,
          notes: pod.notes || null,
          location: podLocation,
        },
      });

      await updateStatus(order.id, "Delivered");
      // Clear POD state for this order
      setPodState((prev) => {
        const next = new Map(prev);
        next.delete(order.id);
        return next;
      });
      setDetailVisible(false);
      setSelectedOrder(null);
      setStatusMsg("POD submitted. Delivery marked complete.");
    } finally {
      for (const cleanup of cleanupTasks) {
        try { await cleanup(); } catch { /* ok */ }
      }
      setPodField(order.id, "submitting", false);
    }
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  async function loadProfile() {
    try {
      const data = await apiRequest<UserProfile>(apiBase, "/users/me", { token });
      setProfile(data);
      setProfilePhone(formatPhoneNumber(data.phone || ""));
      setProfileEmail(data.email || "");
      setProfileTsa(!!data.tsa_certified);
      // Only replace the locally-picked photo if the server has a real HTTP URL.
      // A null/missing server value must never wipe a photo the user picked
      // this session (data: / file: URI).
      setProfilePhotoUrl((prev) => {
        const serverUrl = data.photo_url || "";
        return serverUrl.startsWith("http") ? serverUrl : prev;
      });
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : "Failed to load profile.");
    }
  }

  async function pickProfilePhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setProfileMsg("Photo library permission required."); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets.length) return;
    const asset = result.assets[0];
    if (!asset.uri) return;

    // Show local preview immediately while the upload is in flight.
    setProfilePhotoUrl(asset.uri);
    setProfileMsg("Uploading photo…");
    try {
      const filename = asset.uri.split("/").pop() || "photo.jpg";
      const ext = (filename.split(".").pop() || "jpg").toLowerCase();
      const mimeType =
        asset.mimeType ||
        (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg");
      const form = new FormData();
      if (Platform.OS === "web") {
        // On web, {uri,name,type} serialises as "[object Object]". Fetch the
        // data: URI to get a real Blob, then wrap in a File before appending.
        const blobResp = await fetch(asset.uri);
        const blob = await blobResp.blob();
        form.append("file", new File([blob], filename, { type: mimeType }));
      } else {
        form.append("file", { uri: asset.uri, name: filename, type: mimeType } as any);
      }
      // Single-request direct upload — backend handles dev (filesystem) vs prod (S3).
      const resp = await fetch(
        `${apiBase.replace(/\/+$/, "")}/users/me/photo`,
        { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Upload failed (${resp.status})`);
      }
      const body = await resp.json() as { photo_url?: string };
      if (body.photo_url) {
        // Replace the temporary local URI with the persisted HTTP URL.
        setProfilePhotoUrl(body.photo_url);
        setProfile((prev) => prev ? { ...prev, photo_url: body.photo_url } : prev);
        setProfileMsg("Photo saved.");
      }
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : "Photo upload failed.");
      // Leave the local URI as the preview even if upload fails.
    }
  }

  async function saveProfile() {
    setLoading(true);
    try {
      await apiRequest(apiBase, "/users/me", {
        method: "PUT",
        token,
        json: {
          phone: profilePhone || null,
          tsa_certified: profileTsa,
          // Only persist URLs the backend can actually store and share.
          // Local file:// and data: URIs from the image picker are display-only
          // for the current session; a proper S3 upload is needed for full persistence.
          photo_url:
            profilePhotoUrl && profilePhotoUrl.startsWith("http")
              ? profilePhotoUrl
              : undefined,
        },
      });
      setProfileMsg("Profile saved.");
      // Optimistic update — reflect the just-saved values immediately without
      // issuing another GET (which could race and return stale data).
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              phone: profilePhone || undefined,
              tsa_certified: profileTsa,
              // Always reflect the picked photo locally (for top-bar avatar)
              // even if we couldn't persist a data:/file: URI to the backend.
              photo_url: profilePhotoUrl || prev.photo_url,
            }
          : prev
      );
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    loadInbox().catch(() => undefined);
    loadProfile().catch(() => undefined);
    startAutoLocation();
    return () => {
      stopAutoLocation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  const pod = selectedOrder ? getPodState(selectedOrder.id) : null;

  return (
    <View style={styles.root}>
      {/* ── Full-screen map ───────────────────────────────────────── */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        region={mapRegion}
        onRegionChangeComplete={setMapRegion}
        showsUserLocation={true}
      >
        {/* Driver marker */}
        {driverLoc ? (
          <Marker
            coordinate={{ latitude: driverLoc.lat, longitude: driverLoc.lng }}
            pinColor="#F0C060"
            title="Your Location"
          />
        ) : null}

        {/* Stop markers */}
        {Array.from(orderCoords.entries()).map(([orderId, coord]) => {
          const order = orders.find((o) => o.id === orderId);
          if (!order) return null;
          return (
            <Marker
              key={`stop-${orderId}`}
              coordinate={{ latitude: coord.lat, longitude: coord.lng }}
              pinColor={stopPinColor(order)}
              title={order.customer_name}
              description={`${orderReference(order)} · ${order.status}`}
              onPress={() => selectOrder(order)}
            />
          );
        })}

        {/* Route polyline */}
        {routeResult && routeResult.coords.length > 1 ? (
          <Polyline coordinates={routeResult.coords} strokeColor="#C8973A" strokeWidth={5} />
        ) : null}
      </MapView>

      {/* ── Top bar ────────────────────────────────────────────────── */}
      <SafeAreaView pointerEvents="box-none" style={styles.topBar}>
        <View style={styles.topBarInner} pointerEvents="box-none">
          <View style={styles.locationPill}>
            <View style={[styles.locationDot, { backgroundColor: locationActive ? "#4A9E5C" : "#9B3A3A" }]} />
            <Text style={styles.locationPillText}>
              {locationActive ? "Sharing location" : "Location off"}
            </Text>
          </View>
          <View style={styles.topBarRight}>
            {loading ? <ActivityIndicator size="small" color="#C8973A" style={{ marginRight: 8 }} /> : null}
            <Pressable
              style={styles.profileBtn}
              onPress={() => {
                setProfileMsg("");
                loadProfile().catch(() => undefined);
                setProfileVisible(true);
              }}
            >
              {(profilePhotoUrl || profile?.photo_url) ? (
                <Image
                  source={{ uri: profilePhotoUrl || profile!.photo_url! }}
                  style={styles.profileAvatar}
                />
              ) : (
                <Text style={styles.profileBtnText}>👤</Text>
              )}
            </Pressable>
          </View>
        </View>
      </SafeAreaView>

      {/* ── Status bar (floats above sheet) ────────────────────────── */}
      {statusMsg ? (
        <View style={styles.statusBadge} pointerEvents="none">
          <Text style={styles.statusBadgeText} numberOfLines={1}>{statusMsg}</Text>
        </View>
      ) : null}

      {/* ── Bottom sheet ──────────────────────────────────────────── */}
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY: sheetAnim }] }]}
      >
        {/* Drag handle */}
        <View {...panResponder.panHandlers} style={styles.handleArea}>
          <View style={styles.handle} />
          <View style={styles.tabBar}>
            <Pressable
              style={[styles.tab, activeTab === "stops" && styles.tabActive]}
              onPress={() => setActiveTab("stops")}
            >
              <Text style={[styles.tabText, activeTab === "stops" && styles.tabTextActive]}>
                My Stops ({orders.length})
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tab, activeTab === "directions" && styles.tabActive]}
              onPress={() => setActiveTab("directions")}
            >
              <Text style={[styles.tabText, activeTab === "directions" && styles.tabTextActive]}>
                Directions
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Tab content */}
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
        >
          {activeTab === "stops" ? (
            <>
              {sortedOrders.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyIcon}>📦</Text>
                  <Text style={styles.emptyText}>No assigned stops</Text>
                  <Pressable
                    style={[styles.btn, styles.btnPrimary, { marginTop: 12 }]}
                    onPress={() => loadInbox().catch(() => undefined)}
                  >
                    <Text style={styles.btnText}>Refresh</Text>
                  </Pressable>
                </View>
              ) : null}
              {sortedOrders.map((order, idx) => {
                const coord = orderCoords.get(order.id);
                const dist =
                  driverLoc && coord
                    ? formatDistanceMiles(
                        haversineDistance(driverLoc.lat, driverLoc.lng, coord.lat, coord.lng)
                      )
                    : null;
                const statusLow = (order.status || "").toLowerCase();
                const isDelivery = statusLow === "pickedup" || statusLow === "enroute";
                return (
                  <Pressable
                    key={order.id}
                    style={[styles.stopCard, selectedOrder?.id === order.id && styles.stopCardSelected]}
                    onPress={() => selectOrder(order)}
                  >
                    <View style={styles.stopSeq}>
                      <Text style={styles.stopSeqText}>{idx + 1}</Text>
                    </View>
                    <View style={styles.stopInfo}>
                      <Text style={styles.stopName}>{order.customer_name}</Text>
                      <Text style={styles.stopAddr} numberOfLines={1}>
                        {isDelivery ? deliveryAddress(order) : pickupAddress(order)}
                      </Text>
                      {dist ? <Text style={styles.stopDist}>{dist} away</Text> : null}
                    </View>
                    <View style={[styles.statusPill, { backgroundColor: statusBg(order.status) }]}>
                      <Text style={styles.statusPillText}>{order.status}</Text>
                    </View>
                  </Pressable>
                );
              })}
              <View style={styles.sheetActions}>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => loadInbox().catch(() => undefined)}>
                  <Text style={styles.btnText}>Refresh</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={onSignOut}>
                  <Text style={styles.btnGhostText}>Sign Out</Text>
                </Pressable>
              </View>
            </>
          ) : (
            /* Directions tab */
            <DirectionsTab routeResult={routeResult} />
          )}
        </ScrollView>
      </Animated.View>

      {/* ── Order detail panel ────────────────────────────────────── */}
      <Modal
        visible={detailVisible && !!selectedOrder}
        animationType="slide"
        transparent
        onRequestClose={() => { setDetailVisible(false); setSelectedOrder(null); }}
      >
        <KeyboardAvoidingView
          style={styles.detailBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.detailPanel}>
            <SafeAreaView>
              <View style={styles.detailHeader}>
                <Text style={styles.detailTitle} numberOfLines={1}>
                  {selectedOrder?.customer_name ?? "Order"}
                </Text>
                <Pressable onPress={() => { setDetailVisible(false); setSelectedOrder(null); }}>
                  <Text style={styles.detailClose}>✕</Text>
                </Pressable>
              </View>
            </SafeAreaView>
            {selectedOrder && pod ? (
              <ScrollView contentContainerStyle={styles.detailContent} keyboardShouldPersistTaps="handled">
                {/* Status + ref */}
                <View style={styles.detailRow}>
                  <View style={[styles.statusPill, { backgroundColor: statusBg(selectedOrder.status) }]}>
                    <Text style={styles.statusPillText}>{selectedOrder.status}</Text>
                  </View>
                  <Text style={styles.detailMeta}>Ref {orderReference(selectedOrder)}</Text>
                </View>

                {selectedOrder.phone ? (
                  <View style={styles.detailSection}>
                    <Text style={styles.detailLabel}>PHONE</Text>
                    <Text style={styles.detailLink}>{selectedOrder.phone}</Text>
                  </View>
                ) : null}

                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>PICKUP</Text>
                  <Text style={styles.detailValue}>{pickupAddress(selectedOrder) || "-"}</Text>
                </View>
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>DELIVERY</Text>
                  <Text style={styles.detailValue}>{deliveryAddress(selectedOrder) || "-"}</Text>
                </View>
                {selectedOrder.time_window_start ? (
                  <View style={styles.detailSection}>
                    <Text style={styles.detailLabel}>WINDOW</Text>
                    <Text style={styles.detailValue}>
                      {formatTime(selectedOrder.time_window_start)} – {formatTime(selectedOrder.time_window_end)}
                    </Text>
                  </View>
                ) : null}
                {selectedOrder.notes ? (
                  <View style={styles.detailSection}>
                    <Text style={styles.detailLabel}>NOTES</Text>
                    <Text style={styles.detailValue}>{selectedOrder.notes}</Text>
                  </View>
                ) : null}

                {/* Status actions */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>ACTIONS</Text>
                  <View style={styles.statusActions}>
                    {DRIVER_STATUS.map((s) => (
                      <Pressable
                        key={s}
                        style={[
                          styles.actionBtn,
                          selectedOrder.status === s && styles.actionBtnActive,
                          s === "Failed" && styles.actionBtnDanger,
                          s === "Delivered" && styles.actionBtnGreen,
                        ]}
                        onPress={() => updateStatus(selectedOrder.id, s).catch(() => undefined)}
                      >
                        <Text style={styles.actionBtnText}>{s}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                {/* POD section */}
                <View style={styles.podSection}>
                  <Text style={styles.podTitle}>PROOF OF DELIVERY</Text>

                  {/* Photo */}
                  {pod.photoUri ? (
                    <Image source={{ uri: pod.photoUri }} style={styles.podPhoto} />
                  ) : null}
                  <View style={styles.row}>
                    <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => capturePodPhoto(selectedOrder.id).catch(() => undefined)}>
                      <Text style={styles.btnText}>📷 {pod.photoUri ? "Retake" : "Photo"}</Text>
                    </Pressable>
                    {pod.photoUri ? (
                      <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setPodField(selectedOrder.id, "photoUri", null)}>
                        <Text style={styles.btnGhostText}>Clear</Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {/* Signature */}
                  <View style={styles.row}>
                    <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => setSignatureOrderId(selectedOrder.id)}>
                      <Text style={styles.btnText}>✍️ {pod.signatureData ? "Re-sign" : "Signature"}</Text>
                    </Pressable>
                    {pod.signatureData ? (
                      <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setPodField(selectedOrder.id, "signatureData", null)}>
                        <Text style={styles.btnGhostText}>Clear</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {pod.signatureData ? <Text style={styles.podCaptured}>✓ Signature captured</Text> : null}

                  {/* Notes */}
                  <TextInput
                    style={styles.input}
                    value={pod.notes}
                    onChangeText={(v) => setPodField(selectedOrder.id, "notes", v)}
                    placeholder="Delivery notes…"
                    placeholderTextColor="#4A3F60"
                    multiline
                  />

                  {/* Submit */}
                  <Pressable
                    style={[styles.btn, styles.btnGreen, { width: "100%" }]}
                    onPress={() => submitPod(selectedOrder).catch((e) => setStatusMsg(e instanceof Error ? e.message : "Submit failed."))}
                    disabled={pod.submitting}
                  >
                    <Text style={styles.btnText}>
                      {pod.submitting ? "Submitting…" : "Submit POD & Mark Delivered"}
                    </Text>
                  </Pressable>
                </View>
              </ScrollView>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Signature modal ───────────────────────────────────────── */}
      <Modal
        visible={!!signatureOrderId}
        transparent
        animationType="slide"
        onRequestClose={() => setSignatureOrderId(null)}
      >
        <View style={styles.sigBackdrop}>
          <View style={styles.sigCard}>
            <Text style={styles.sigTitle}>Capture Signature</Text>
            <View style={styles.sigWrap}>
              <SignatureScreen
                onOK={onSignatureSaved}
                onEmpty={() => setStatusMsg("Draw a signature first.")}
                clearText="Clear"
                confirmText="Save"
                descriptionText="Sign below"
                autoClear
                webStyle={`
                  .m-signature-pad--footer { background: #1A1526; }
                  .m-signature-pad--body { border: 1px solid #3A2F50; }
                  .button { background: #C8973A; color: #0B0910; border-radius: 8px; }
                `}
              />
            </View>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setSignatureOrderId(null)}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Profile modal ─────────────────────────────────────────── */}
      <Modal
        visible={profileVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setProfileVisible(false)}
      >
        <View style={styles.sigBackdrop}>
          <SafeAreaView style={{ flex: 1, justifyContent: "flex-end" }}>
            <View style={styles.profileCard}>
              <View style={styles.detailHeader}>
                <Text style={styles.detailTitle}>My Profile</Text>
                <Pressable onPress={() => setProfileVisible(false)}>
                  <Text style={styles.detailClose}>✕</Text>
                </Pressable>
              </View>
              <Pressable
                style={styles.avatarPickerBtn}
                onPress={() => pickProfilePhoto().catch(() => undefined)}
              >
                {profilePhotoUrl ? (
                  <Image source={{ uri: profilePhotoUrl }} style={styles.profileAvatarLarge} />
                ) : (
                  <View style={[styles.profileAvatarLarge, styles.avatarPlaceholder]}>
                    <Text style={styles.avatarPlaceholderText}>📷</Text>
                  </View>
                )}
                <Text style={styles.avatarPickerLabel}>Change Photo</Text>
              </Pressable>
              <Text style={styles.detailLabel}>EMAIL</Text>
              <Text style={styles.detailValue}>{profile?.email || profileEmail || "-"}</Text>
              <Text style={styles.detailLabel}>PHONE</Text>
              <TextInput
                style={styles.input}
                value={profilePhone}
                onChangeText={(v) => setProfilePhone(formatPhoneNumber(v))}
                placeholder="(555) 555-5555"
                placeholderTextColor="#4A3F60"
                keyboardType="phone-pad"
                maxLength={14}
              />
              <View style={styles.row}>
                <Text style={styles.detailLabel}>TSA CERTIFIED</Text>
                <Pressable
                  style={[styles.toggleChip, profileTsa && styles.toggleChipActive]}
                  onPress={() => setProfileTsa((v) => !v)}
                >
                  <Text style={[styles.toggleChipText, profileTsa && styles.toggleChipTextActive]}>
                    {profileTsa ? "Yes" : "No"}
                  </Text>
                </Pressable>
              </View>
              {profileMsg ? <Text style={styles.profileMsg}>{profileMsg}</Text> : null}
              <View style={styles.row}>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => saveProfile().catch(() => undefined)}>
                  <Text style={styles.btnText}>Save</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={onSignOut}>
                  <Text style={styles.btnGhostText}>Sign Out</Text>
                </Pressable>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

// ─── Directions sub-component ─────────────────────────────────────────────────

function DirectionsTab({ routeResult }: { routeResult: OsrmResult | null }) {
  if (!routeResult) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>🧭</Text>
        <Text style={styles.emptyText}>Tap a stop to get directions</Text>
      </View>
    );
  }
  return (
    <View>
      <View style={styles.routeSummary}>
        <Text style={styles.routeSummaryText}>
          {formatDistanceMiles(routeResult.distance_meters)} · {formatDurationShort(routeResult.duration_seconds)}
        </Text>
      </View>
      {routeResult.steps.map((step, i) => (
        <View key={i} style={styles.stepRow}>
          <View style={styles.stepBullet} />
          <View style={styles.stepInfo}>
            <Text style={styles.stepInstruction}>{step.instruction}</Text>
            <Text style={styles.stepMeta}>
              {formatDistanceMiles(step.distance_meters)} · {formatDurationShort(step.duration_seconds)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats a raw string into US (XXX) XXX-XXXX mask as the user types. */
function formatPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length === 0) return "";
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function statusBg(status: string): string {
  const s = (status || "").toLowerCase();
  if (s === "assigned") return "#2A3A5C";
  if (s === "pickedup") return "#1A3A28";
  if (s === "enroute") return "#2A4A2A";
  if (s === "delivered") return "#1A4A3A";
  if (s === "failed") return "#4A1A1A";
  return "#2A2040";
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0B0910",
  },
  // Top bar
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  topBarInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
  },
  locationPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(11,9,16,0.82)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    borderWidth: 1,
    borderColor: "#3A2F50",
  },
  locationDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  locationPillText: {
    color: "#EDE0C4",
    fontSize: 12,
    fontWeight: "600",
  },
  profileBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(11,9,16,0.82)",
    borderWidth: 1,
    borderColor: "#C8973A",
    alignItems: "center",
    justifyContent: "center",
  },
  profileBtnText: {
    fontSize: 18,
  },
  profileAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  profileAvatarLarge: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignSelf: "center",
    marginBottom: 12,
    borderWidth: 2,
    borderColor: "#C8973A",
  },
  // Status badge
  statusBadge: {
    position: "absolute",
    bottom: PEEK_HEIGHT + 16,
    left: 16,
    right: 16,
    backgroundColor: "rgba(11,9,16,0.88)",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 14,
    paddingVertical: 7,
    alignItems: "center",
    zIndex: 5,
  },
  statusBadgeText: {
    color: "#C8973A",
    fontSize: 12,
    fontWeight: "600",
  },
  // Bottom sheet
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: SHEET_HEIGHT,
    backgroundColor: "#130F1A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "#3A2F50",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 20,
    zIndex: 20,
  },
  handleArea: {
    paddingBottom: 4,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: "#3A2F50",
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 8,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
    marginHorizontal: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: "#C8973A",
  },
  tabText: {
    color: "#968AA8",
    fontWeight: "600",
    fontSize: 13,
  },
  tabTextActive: {
    color: "#C8973A",
  },
  sheetScroll: {
    flex: 1,
  },
  sheetContent: {
    padding: 16,
    paddingBottom: 32,
  },
  sheetActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 16,
  },
  // Stop cards
  stopCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1A1526",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 12,
    marginBottom: 8,
    gap: 10,
  },
  stopCardSelected: {
    borderColor: "#C8973A",
    backgroundColor: "#2A1E10",
  },
  stopSeq: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#C8973A",
    alignItems: "center",
    justifyContent: "center",
  },
  stopSeqText: {
    color: "#0B0910",
    fontWeight: "800",
    fontSize: 13,
  },
  stopInfo: {
    flex: 1,
  },
  stopName: {
    color: "#EDE0C4",
    fontWeight: "700",
    fontSize: 14,
  },
  stopAddr: {
    color: "#968AA8",
    fontSize: 12,
    marginTop: 2,
  },
  stopDist: {
    color: "#C8973A",
    fontSize: 11,
    marginTop: 2,
  },
  // Status pill
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusPillText: {
    color: "#EDE0C4",
    fontSize: 11,
    fontWeight: "700",
  },
  // Empty state
  emptyState: {
    alignItems: "center",
    paddingVertical: 32,
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 8,
  },
  emptyText: {
    color: "#968AA8",
    fontSize: 14,
  },
  // Directions
  routeSummary: {
    backgroundColor: "#1A1526",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#3A2F50",
  },
  routeSummaryText: {
    color: "#C8973A",
    fontWeight: "700",
    fontSize: 15,
    textAlign: "center",
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 10,
    gap: 10,
  },
  stepBullet: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#C8973A",
    marginTop: 4,
  },
  stepInfo: {
    flex: 1,
  },
  stepInstruction: {
    color: "#EDE0C4",
    fontSize: 13,
    fontWeight: "600",
  },
  stepMeta: {
    color: "#968AA8",
    fontSize: 11,
    marginTop: 2,
  },
  // Detail panel
  detailBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(7,5,12,0.6)",
  },
  detailPanel: {
    backgroundColor: "#130F1A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "#3A2F50",
    maxHeight: "92%",
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
  },
  detailTitle: {
    color: "#F5D98B",
    fontSize: 17,
    fontWeight: "700",
    flex: 1,
  },
  detailClose: {
    color: "#968AA8",
    fontSize: 18,
    paddingLeft: 12,
  },
  detailContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 40,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  detailSection: {
    gap: 4,
  },
  detailLabel: {
    color: "#968AA8",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
  },
  detailValue: {
    color: "#EDE0C4",
    fontSize: 14,
  },
  detailLink: {
    color: "#C8973A",
    fontSize: 14,
  },
  detailMeta: {
    color: "#968AA8",
    fontSize: 12,
  },
  // Status actions
  statusActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  actionBtn: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: "#1A1526",
    borderWidth: 1,
    borderColor: "#3A2F50",
  },
  actionBtnActive: {
    backgroundColor: "#2A1E10",
    borderColor: "#C8973A",
  },
  actionBtnDanger: {
    borderColor: "#9B3A3A",
  },
  actionBtnGreen: {
    borderColor: "#1A5C3A",
  },
  actionBtnText: {
    color: "#EDE0C4",
    fontWeight: "700",
    fontSize: 12,
  },
  // POD
  podSection: {
    borderTopWidth: 1,
    borderTopColor: "#3A2F50",
    paddingTop: 14,
    gap: 10,
  },
  podTitle: {
    color: "#968AA8",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
  },
  podPhoto: {
    width: "100%",
    height: 160,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#0F0C16",
  },
  podCaptured: {
    color: "#4A9E5C",
    fontSize: 12,
    fontWeight: "600",
  },
  // Inputs
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
  // Buttons
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
  btn: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
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
  btnGreen: {
    backgroundColor: "#1A5C3A",
  },
  btnText: {
    color: "#0B0910",
    fontWeight: "700",
    fontSize: 13,
  },
  btnGhostText: {
    color: "#C8973A",
    fontWeight: "700",
    fontSize: 13,
  },
  // Signature
  sigBackdrop: {
    flex: 1,
    backgroundColor: "rgba(7,5,12,0.88)",
    justifyContent: "flex-end",
  },
  sigCard: {
    backgroundColor: "#130F1A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 16,
    gap: 12,
  },
  sigTitle: {
    color: "#F5D98B",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  sigWrap: {
    height: 260,
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#0F0C16",
  },
  // Profile
  profileCard: {
    backgroundColor: "#130F1A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 16,
    gap: 10,
  },
  profileMsg: {
    color: "#C8973A",
    fontSize: 12,
    fontWeight: "600",
  },
  // Toggle chip
  toggleChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#1A1526",
  },
  toggleChipActive: {
    backgroundColor: "#1A5C3A",
    borderColor: "#4A9E5C",
  },
  toggleChipText: {
    color: "#968AA8",
    fontWeight: "700",
    fontSize: 12,
  },
  toggleChipTextActive: {
    color: "#EDE0C4",
  },
  // Profile photo picker
  avatarPickerBtn: {
    alignSelf: "center",
    alignItems: "center",
    gap: 4,
  },
  avatarPlaceholder: {
    backgroundColor: "#1A1526",
    borderColor: "#3A2F50",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPlaceholderText: {
    fontSize: 32,
  },
  avatarPickerLabel: {
    color: "#C8973A",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
});
