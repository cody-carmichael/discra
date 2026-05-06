// AdminScreen.tsx — Dispatcher / admin dashboard with map, stats, order management
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  ActivityIndicator,
  Dimensions,
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
import {
  AuditLogRecord,
  DriverLocationRecord,
  OrderRecord,
  RouteOptimizeResponse,
  apiRequest,
  deliveryAddress,
  formatDistanceMiles,
  formatDurationShort,
  formatTime,
  orderReference,
  pickupAddress,
} from "../lib";

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 15_000;
const DUE_SOON_MINUTES = 120;
const ADMIN_STATUS = ["Assigned", "PickedUp", "EnRoute", "Delivered", "Failed"] as const;
const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const DISPATCH_PANEL_HEIGHT = Math.round(SCREEN_HEIGHT * 0.38);

type AdminTab = "dispatch" | "orders" | "admin";
type OrdersSubTab = "list" | "inflight" | "history";

type EmailStatus = { connected: boolean; email: string; last_poll_at: string; last_error: string };
type BillingSeatState = { total: number; used: number; pending: number; available: number };
type BillingSummary = {
  plan_name: string;
  status: string;
  dispatcher_seats: BillingSeatState;
  driver_seats: BillingSeatState;
};
type BillingInvitation = {
  invitation_id: string;
  user_id: string;
  email?: string | null;
  role: string;
  status: string;
  created_at: string;
};

type Props = {
  token: string;
  apiBase: string;
  onSignOut: () => void;
};

type CreateOrderForm = {
  customer_name: string;
  pick_up_address: string;
  delivery: string;
  dimensions: string;
  weight: string;
  time_window_start: string;
  time_window_end: string;
};

const BLANK_FORM: CreateOrderForm = {
  customer_name: "",
  pick_up_address: "",
  delivery: "",
  dimensions: "",
  weight: "",
  time_window_start: "",
  time_window_end: "",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminScreen({ token, apiBase, onSignOut }: Props) {
  // ── Core data ──────────────────────────────────────────────────────────────
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [drivers, setDrivers] = useState<DriverLocationRecord[]>([]);
  const [mapRegion, setMapRegion] = useState<Region>({
    latitude: 39.8,
    longitude: -98.5,
    latitudeDelta: 30,
    longitudeDelta: 30,
  });

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [routePlan, setRoutePlan] = useState<RouteOptimizeResponse | null>(null);

  // ── UI ─────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<AdminTab>("dispatch");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());

  // ── Create order modal ─────────────────────────────────────────────────────
  const [createVisible, setCreateVisible] = useState(false);
  const [createForm, setCreateForm] = useState<CreateOrderForm>(BLANK_FORM);
  const [createMsg, setCreateMsg] = useState("");

  // ── Edit order modal ───────────────────────────────────────────────────────
  const [editOrder, setEditOrder] = useState<OrderRecord | null>(null);
  const [editForm, setEditForm] = useState<CreateOrderForm>(BLANK_FORM);
  const [editMsg, setEditMsg] = useState("");

  // ── Orders sub-tab ────────────────────────────────────────────────────────
  const [ordersSubTab, setOrdersSubTab] = useState<OrdersSubTab>("list");


  // ── Admin tab data ─────────────────────────────────────────────────────────
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [invitations, setInvitations] = useState<BillingInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("Driver");
  const [inviteMsg, setInviteMsg] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);

  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView | null>(null);

  // ── Animations ────────────────────────────────────────────────────────────
  const DRAWER_WIDTH = 240;
  const drawerAnim = useRef(new Animated.Value(DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const tabFadeAnim = useRef(new Animated.Value(1)).current;

  function openMenu() {
    setMenuOpen(true);
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 1,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start();
  }

  function closeMenu() {
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: DRAWER_WIDTH,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => setMenuOpen(false));
  }

  function switchTab(tab: AdminTab) {
    Animated.timing(tabFadeAnim, {
      toValue: 0,
      duration: 110,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      setActiveTab(tab);
      closeMenu();
      Animated.timing(tabFadeAnim, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const now = Date.now();
    const total = orders.length;
    const assigned = orders.filter((o) => !!o.assigned_to).length;
    const unassigned = total - assigned;
    const active_drivers = drivers.length;
    const due_soon = orders.filter((o) => {
      if (!o.time_window_end) return false;
      const end = new Date(o.time_window_end).getTime();
      return end > now && end - now <= DUE_SOON_MINUTES * 60_000;
    }).length;
    return { total, assigned, unassigned, active_drivers, due_soon };
  }, [orders, drivers]);

  // ── Selected driver ────────────────────────────────────────────────────────
  const selectedDriver = useMemo(
    () => drivers.find((d) => d.driver_id === selectedDriverId) ?? null,
    [drivers, selectedDriverId]
  );

  // ── Route points ──────────────────────────────────────────────────────────
  const routePoints = useMemo(() => {
    if (!selectedDriver) return [];
    const pts: { latitude: number; longitude: number }[] = [
      { latitude: selectedDriver.lat, longitude: selectedDriver.lng },
    ];
    if (routePlan?.ordered_stops?.length) {
      for (const s of routePlan.ordered_stops) pts.push({ latitude: s.lat, longitude: s.lng });
      return pts;
    }
    return pts;
  }, [selectedDriver, routePlan]);

  // ── Filtered orders ────────────────────────────────────────────────────────
  const filteredOrders = useMemo(() => {
    if (!searchQuery.trim()) return orders;
    const q = searchQuery.toLowerCase();
    return orders.filter(
      (o) =>
        o.customer_name.toLowerCase().includes(q) ||
        orderReference(o).toLowerCase().includes(q) ||
        (pickupAddress(o) || "").toLowerCase().includes(q) ||
        (deliveryAddress(o) || "").toLowerCase().includes(q) ||
        (o.status || "").toLowerCase().includes(q)
    );
  }, [orders, searchQuery]);

  const unassignedOrders = useMemo(
    () => filteredOrders.filter((o) => !o.assigned_to),
    [filteredOrders]
  );

  const assignedOrders = useMemo(
    () =>
      selectedDriverId
        ? filteredOrders.filter((o) => o.assigned_to === selectedDriverId)
        : filteredOrders.filter((o) => !!o.assigned_to),
    [filteredOrders, selectedDriverId]
  );

  const inflightOrders = useMemo(
    () => orders.filter((o) => o.status === "PickedUp" || o.status === "EnRoute"),
    [orders]
  );

  const orderHistory = useMemo(
    () => orders.filter((o) => o.status === "Delivered" || o.status === "Failed"),
    [orders]
  );

  // ── Load data ──────────────────────────────────────────────────────────────
  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [ordersData, driversData] = await Promise.all([
          apiRequest<OrderRecord[]>(apiBase, "/orders/", { token }),
          apiRequest<DriverLocationRecord[]>(apiBase, "/drivers?active_minutes=120", { token }),
        ]);
        setOrders(ordersData || []);
        setDrivers(driversData || []);

        if (driversData?.length) {
          const lats = driversData.map((d) => d.lat);
          const lngs = driversData.map((d) => d.lng);
          const minLat = Math.min(...lats);
          const maxLat = Math.max(...lats);
          const minLng = Math.min(...lngs);
          const maxLng = Math.max(...lngs);
          if (driversData.length === 1) {
            setMapRegion({ latitude: lats[0], longitude: lngs[0], latitudeDelta: 0.1, longitudeDelta: 0.1 });
          } else {
            setMapRegion({
              latitude: (minLat + maxLat) / 2,
              longitude: (minLng + maxLng) / 2,
              latitudeDelta: Math.max((maxLat - minLat) * 1.5, 0.05),
              longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.05),
            });
          }
          if (!selectedDriverId && driversData.length) {
            setSelectedDriverId(driversData[0].driver_id);
          }
        }

        if (!silent) setStatusMsg(`${ordersData?.length ?? 0} orders · ${driversData?.length ?? 0} drivers`);
      } catch (e) {
        if (!silent) setStatusMsg(e instanceof Error ? e.message : "Load failed.");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [apiBase, token, selectedDriverId]
  );

  useEffect(() => {
    loadData().catch(() => undefined);
    refreshTimer.current = setInterval(() => {
      loadData(true).catch(() => undefined);
    }, REFRESH_INTERVAL_MS);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-optimise route whenever the selected driver changes
  useEffect(() => {
    if (!selectedDriverId) return;
    optimiseRoute().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDriverId]);

  // ── Optimise route ────────────────────────────────────────────────────────
  async function optimiseRoute() {
    if (!selectedDriverId) { setStatusMsg("Select a driver first."); return; }
    setLoading(true);
    try {
      const plan = await apiRequest<RouteOptimizeResponse>(apiBase, "/routes/optimize", {
        method: "POST",
        token,
        json: { driver_id: selectedDriverId },
      });
      setRoutePlan(plan);
      setStatusMsg(
        `Route optimised: ${formatDistanceMiles(plan.total_distance_meters)} · ${formatDurationShort(plan.total_duration_seconds)}`
      );
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Optimise failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Assign / unassign ─────────────────────────────────────────────────────
  async function assignOrder(orderId: string) {
    const driverId = (selectedDriverId || "").trim();
    if (!driverId) { setStatusMsg("Select a driver first."); return; }
    setLoading(true);
    try {
      await apiRequest(apiBase, `/orders/${orderId}/assign`, {
        method: "POST",
        token,
        json: { driver_id: driverId },
      });
      await loadData(true);
      setStatusMsg("Assigned.");
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Assign failed.");
    } finally {
      setLoading(false);
    }
  }

  async function unassignOrder(orderId: string) {
    setLoading(true);
    try {
      await apiRequest(apiBase, `/orders/${orderId}/unassign`, { method: "POST", token });
      await loadData(true);
      setStatusMsg("Unassigned.");
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Unassign failed.");
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(orderId: string, status: string) {
    setLoading(true);
    try {
      await apiRequest(apiBase, `/orders/${orderId}/status`, {
        method: "POST",
        token,
        json: { status },
      });
      await loadData(true);
      setStatusMsg(`Status → ${status}`);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Status update failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Bulk assign ────────────────────────────────────────────────────────────
  async function bulkAssign() {
    const driverId = selectedDriverId || "";
    if (!driverId) { setStatusMsg("Select a driver first."); return; }
    if (!selectedOrderIds.size) { setStatusMsg("Select orders to assign."); return; }
    setLoading(true);
    let ok = 0;
    for (const id of selectedOrderIds) {
      try {
        await apiRequest(apiBase, `/orders/${id}/assign`, { method: "POST", token, json: { driver_id: driverId } });
        ok++;
      } catch { /* skip */ }
    }
    setSelectedOrderIds(new Set());
    await loadData(true);
    setStatusMsg(`Assigned ${ok} order(s).`);
    setLoading(false);
  }

  // ── Create order ───────────────────────────────────────────────────────────
  async function createOrder() {
    if (!createForm.customer_name.trim()) { setCreateMsg("Customer name is required."); return; }
    setLoading(true);
    try {
      await apiRequest(apiBase, "/orders/", {
        method: "POST",
        token,
        json: {
          customer_name: createForm.customer_name.trim(),
          pick_up_address: createForm.pick_up_address.trim() || null,
          delivery: createForm.delivery.trim() || null,
          dimensions: createForm.dimensions.trim() || null,
          weight: createForm.weight ? Number(createForm.weight) : null,
          time_window_start: createForm.time_window_start.trim() || null,
          time_window_end: createForm.time_window_end.trim() || null,
        },
      });
      setCreateForm(BLANK_FORM);
      setCreateMsg("Order created.");
      setCreateVisible(false);
      await loadData(true);
    } catch (e) {
      setCreateMsg(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Edit order ─────────────────────────────────────────────────────────────
  function openEditOrder(order: OrderRecord) {
    setEditOrder(order);
    setEditForm({
      customer_name: order.customer_name,
      pick_up_address: pickupAddress(order),
      delivery: deliveryAddress(order),
      dimensions: order.dimensions || "",
      weight: order.weight != null ? String(order.weight) : "",
      time_window_start: order.time_window_start || "",
      time_window_end: order.time_window_end || "",
    });
    setEditMsg("");
  }

  async function saveEditOrder() {
    if (!editOrder) return;
    setLoading(true);
    try {
      await apiRequest(apiBase, `/orders/${editOrder.id}`, {
        method: "PUT",
        token,
        json: {
          customer_name: editForm.customer_name.trim(),
          pick_up_address: editForm.pick_up_address.trim() || null,
          delivery: editForm.delivery.trim() || null,
          dimensions: editForm.dimensions.trim() || null,
          weight: editForm.weight ? Number(editForm.weight) : null,
          time_window_start: editForm.time_window_start.trim() || null,
          time_window_end: editForm.time_window_end.trim() || null,
        },
      });
      setEditOrder(null);
      setStatusMsg("Order updated.");
      await loadData(true);
    } catch (e) {
      setEditMsg(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Admin tab data loaders ─────────────────────────────────────────────────
  async function loadAdminData() {
    setAdminLoading(true);
    try {
      const [auditData, emailData, billingData, invitationsData] = await Promise.allSettled([
        apiRequest<AuditLogRecord[]>(apiBase, "/audit/logs?limit=50", { token }),
        apiRequest<EmailStatus>(apiBase, "/email/status", { token }),
        apiRequest<BillingSummary>(apiBase, "/billing/summary", { token }),
        apiRequest<BillingInvitation[]>(apiBase, "/billing/invitations", { token }),
      ]);
      if (auditData.status === "fulfilled") setAuditLogs(auditData.value || []);
      if (emailData.status === "fulfilled") setEmailStatus(emailData.value);
      if (billingData.status === "fulfilled") setBillingSummary(billingData.value);
      if (invitationsData.status === "fulfilled") setInvitations(invitationsData.value || []);
    } finally {
      setAdminLoading(false);
    }
  }

  async function sendInvitation() {
    if (!inviteEmail.trim()) { setInviteMsg("Email is required."); return; }
    setAdminLoading(true);
    setInviteMsg("");
    try {
      await apiRequest(apiBase, "/billing/invitations", {
        method: "POST",
        token,
        json: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteEmail("");
      setInviteMsg("Invitation sent.");
      const data = await apiRequest<BillingInvitation[]>(apiBase, "/billing/invitations", { token });
      setInvitations(data || []);
    } catch (e) {
      setInviteMsg(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setAdminLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "admin") loadAdminData().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ── Driver focus ──────────────────────────────────────────────────────────
  function focusDriver(driver: DriverLocationRecord) {
    setSelectedDriverId(driver.driver_id);
    setRoutePlan(null);
    mapRef.current?.animateToRegion(
      { latitude: driver.lat, longitude: driver.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 },
      600
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea}>

        {/* ── Header ─────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>D</Text>
            </View>
            <Text style={styles.brandName}>Discra Dispatch</Text>
          </View>
          <View style={styles.headerRight}>
            {loading ? <ActivityIndicator size="small" color="#C8973A" /> : null}
            <Pressable style={styles.hamburgerBtn} onPress={openMenu}>
              <Text style={styles.hamburgerIcon}>☰</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Tab content (animated crossfade on switch) ──────────── */}
        <Animated.View style={[{ flex: 1 }, { opacity: tabFadeAnim }]}>

        {/* ── Dispatch tab: full-height map + bottom panel ────────── */}
        {activeTab === "dispatch" ? (
          <View style={styles.dispatchLayout}>

            {/* Map with floating overlays */}
            <View style={styles.mapWrap}>
              <MapView
                ref={mapRef}
                style={StyleSheet.absoluteFillObject}
                region={mapRegion}
                onRegionChangeComplete={setMapRegion}
                showsUserLocation={false}
              >
                {drivers.map((driver) => (
                  <Marker
                    key={`drv-${driver.driver_id}`}
                    coordinate={{ latitude: driver.lat, longitude: driver.lng }}
                    pinColor={driver.driver_id === selectedDriverId ? "#C8973A" : "#0e7aa6"}
                    title={driver.driver_id}
                    description={formatTime(driver.timestamp)}
                    onPress={() => focusDriver(driver)}
                  />
                ))}
                {routePoints.length > 1 ? (
                  <Polyline coordinates={routePoints} strokeColor="#C8973A" strokeWidth={3} />
                ) : null}
              </MapView>

              {/* Stats chips overlay (top-left) */}
              <View style={styles.mapStatsOverlay} pointerEvents="none">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mapStatsRow}>
                  <StatChip label="Orders" value={stats.total} />
                  <StatChip label="Assigned" value={stats.assigned} />
                  <StatChip label="Unassigned" value={stats.unassigned} accent={stats.unassigned > 0} />
                  <StatChip label="Drivers" value={stats.active_drivers} />
                  {stats.due_soon > 0 ? <StatChip label="Due Soon" value={stats.due_soon} accent /> : null}
                  {routePlan ? (
                    <StatChip
                      label="Route"
                      value={0}
                      label2={`${formatDistanceMiles(routePlan.total_distance_meters)} · ${formatDurationShort(routePlan.total_duration_seconds)}`}
                    />
                  ) : null}
                </ScrollView>
              </View>

            </View>

            {/* Bottom dispatch panel */}
            <View style={styles.dispatchPanel}>
              <View style={styles.sheetHandle} />
              {statusMsg ? (
                <Text style={styles.statusMsg} numberOfLines={1}>{statusMsg}</Text>
              ) : null}
              <ScrollView
                style={styles.dispatchScroll}
                contentContainerStyle={styles.dispatchScrollContent}
                keyboardShouldPersistTaps="handled"
              >
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search orders…"
                  placeholderTextColor="#4A3F60"
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <DispatchTab
                  unassignedOrders={unassignedOrders}
                  assignedOrders={assignedOrders}
                  selectedDriverId={selectedDriverId}
                  drivers={drivers}
                  selectedOrderIds={selectedOrderIds}
                  setSelectedOrderIds={setSelectedOrderIds}
                  onAssign={assignOrder}
                  onUnassign={unassignOrder}
                  onBulkAssign={bulkAssign}
                  onSelectDriver={focusDriver}
                  onOptimise={optimiseRoute}
                  routePlan={routePlan}
                  orders={orders}
                />
              </ScrollView>
            </View>
          </View>
        ) : null}

        {/* ── Orders tab ─────────────────────────────────────────── */}
        {activeTab === "orders" ? (
          <View style={styles.tabContent}>
            {/* Sub-tab bar */}
            <View style={styles.subTabBar}>
              {(["list", "inflight", "history"] as OrdersSubTab[]).map((sub) => (
                <Pressable
                  key={sub}
                  style={[styles.subTab, ordersSubTab === sub && styles.subTabActive]}
                  onPress={() => setOrdersSubTab(sub)}
                >
                  <Text style={[styles.subTabText, ordersSubTab === sub && styles.subTabTextActive]}>
                    {sub === "list" ? "Orders" : sub === "inflight" ? "In Flight" : "Order History"}
                  </Text>
                </Pressable>
              ))}
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
              {ordersSubTab === "list" ? (
                <OrdersTab
                  orders={filteredOrders}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  onEdit={openEditOrder}
                  onUpdateStatus={updateStatus}
                  onAssign={assignOrder}
                  onUnassign={unassignOrder}
                  onCreateNew={() => { setCreateForm(BLANK_FORM); setCreateMsg(""); setCreateVisible(true); }}
                />
              ) : ordersSubTab === "inflight" ? (
                <>
                  <Text style={styles.sectionSubtitle}>In Flight ({inflightOrders.length})</Text>
                  {inflightOrders.length === 0 ? (
                    <Text style={styles.metaText}>No active shipments.</Text>
                  ) : null}
                  {inflightOrders.map((o) => (
                    <View key={o.id} style={styles.orderCard}>
                      <Text style={styles.orderTitle}>{o.customer_name}</Text>
                      <Text style={styles.orderMeta}>#{orderReference(o)} · {o.status} · {o.assigned_to || "Unassigned"}</Text>
                      <Text style={styles.orderMeta} numberOfLines={1}>Pick up: {pickupAddress(o) || "-"}</Text>
                      <Text style={styles.orderMeta} numberOfLines={1}>Deliver: {deliveryAddress(o) || "-"}</Text>
                    </View>
                  ))}
                </>
              ) : (
                <>
                  <Text style={styles.sectionSubtitle}>Order History ({orderHistory.length})</Text>
                  {orderHistory.length === 0 ? (
                    <Text style={styles.metaText}>No completed orders.</Text>
                  ) : null}
                  {orderHistory.map((o) => (
                    <View key={o.id} style={styles.orderCard}>
                      <View style={styles.orderCardHeader}>
                        <Text style={styles.orderTitle}>{o.customer_name}</Text>
                        <View style={[styles.statusBadge, o.status === "Delivered" ? styles.statusBadgeSuccess : styles.statusBadgeFail]}>
                          <Text style={styles.statusBadgeText}>{o.status}</Text>
                        </View>
                      </View>
                      <Text style={styles.orderMeta}>#{orderReference(o)} · {o.assigned_to || "—"}</Text>
                      <Text style={styles.orderMeta} numberOfLines={1}>Pick up: {pickupAddress(o) || "-"}</Text>
                      <Text style={styles.orderMeta} numberOfLines={1}>Deliver: {deliveryAddress(o) || "-"}</Text>
                    </View>
                  ))}
                </>
              )}
            </ScrollView>
          </View>
        ) : null}

        {/* ── Admin tab ─────────────────────────────────────────── */}
        {activeTab === "admin" ? (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {/* Refresh all */}
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => loadAdminData().catch(() => undefined)}>
                {adminLoading
                  ? <ActivityIndicator size="small" color="#C8973A" />
                  : <Text style={styles.btnGhostText}>↻ Refresh All</Text>}
              </Pressable>
            </View>

            {/* Email Integration */}
            <View style={styles.adminSection}>
              <Text style={styles.adminSectionTitle}>Email Integration</Text>
              <Text style={styles.metaText}>Connect a Gmail inbox to automatically receive and create orders from dispatch emails.</Text>
              {emailStatus ? (
                emailStatus.connected ? (
                  <View style={{ gap: 4, marginTop: 8 }}>
                    <View style={styles.adminStatRow}>
                      <Text style={styles.adminStatLabel}>Connected Email</Text>
                      <Text style={styles.adminStatValue}>{emailStatus.email}</Text>
                    </View>
                    <View style={styles.adminStatRow}>
                      <Text style={styles.adminStatLabel}>Last Poll</Text>
                      <Text style={styles.adminStatValue}>{formatTime(emailStatus.last_poll_at) || "—"}</Text>
                    </View>
                    <View style={styles.adminStatRow}>
                      <Text style={styles.adminStatLabel}>Status</Text>
                      <Text style={[styles.adminStatValue, { color: emailStatus.last_error ? "#F0C060" : "#6ABF7B" }]}>
                        {emailStatus.last_error ? emailStatus.last_error : "OK"}
                      </Text>
                    </View>
                  </View>
                ) : (
                  <Text style={[styles.metaText, { marginTop: 8 }]}>No email connected.</Text>
                )
              ) : (
                <Text style={[styles.metaText, { marginTop: 8 }]}>Loading…</Text>
              )}
            </View>

            {/* Billing & Seats */}
            <View style={styles.adminSection}>
              <Text style={styles.adminSectionTitle}>Billing & Seats</Text>
              <Text style={styles.metaText}>Your free tier includes 1 admin/dispatcher seat and 1 driver seat.</Text>
              {billingSummary ? (
                <View style={styles.seatGrid}>
                  <SeatCard
                    label="Admin / Dispatcher"
                    used={billingSummary.dispatcher_seats.used}
                    total={billingSummary.dispatcher_seats.total}
                    pending={billingSummary.dispatcher_seats.pending}
                  />
                  <SeatCard
                    label="Driver Seats"
                    used={billingSummary.driver_seats.used}
                    total={billingSummary.driver_seats.total}
                    pending={billingSummary.driver_seats.pending}
                  />
                  <SeatCard
                    label="Available"
                    used={billingSummary.dispatcher_seats.available + billingSummary.driver_seats.available}
                    total={billingSummary.dispatcher_seats.total + billingSummary.driver_seats.total}
                    pending={0}
                  />
                </View>
              ) : (
                <Text style={[styles.metaText, { marginTop: 8 }]}>Loading…</Text>
              )}
            </View>

            {/* Invite a Team Member */}
            <View style={styles.adminSection}>
              <Text style={styles.adminSectionTitle}>Invite a Team Member</Text>
              <Text style={styles.metaText}>Send an invitation to assign one of your available seats.</Text>
              <View style={{ gap: 6, marginTop: 10 }}>
                <Text style={styles.label}>Email Address</Text>
                <TextInput
                  style={styles.input}
                  value={inviteEmail}
                  onChangeText={setInviteEmail}
                  placeholder="colleague@example.com"
                  placeholderTextColor="#4A3F60"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.label}>Role</Text>
                <View style={styles.roleRow}>
                  {["Admin", "Dispatcher", "Driver"].map((r) => (
                    <Pressable
                      key={r}
                      style={[styles.roleBtn, inviteRole === r && styles.roleBtnActive]}
                      onPress={() => setInviteRole(r)}
                    >
                      <Text style={[styles.roleBtnText, inviteRole === r && styles.roleBtnTextActive]}>{r}</Text>
                    </Pressable>
                  ))}
                </View>
                {inviteMsg ? <Text style={[styles.metaText, { color: inviteMsg.includes("sent") ? "#6ABF7B" : "#F0C060" }]}>{inviteMsg}</Text> : null}
                <Pressable style={[styles.btn, styles.btnPrimary, { alignSelf: "flex-start" }]} onPress={() => sendInvitation().catch(() => undefined)}>
                  <Text style={styles.btnText}>Send Invitation</Text>
                </Pressable>
              </View>
            </View>

            {/* Invitations */}
            {invitations.length > 0 ? (
              <View style={styles.adminSection}>
                <Text style={styles.adminSectionTitle}>Invitations</Text>
                {invitations.map((inv) => (
                  <View key={inv.invitation_id} style={styles.invitationRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.orderTitle}>{inv.email || inv.user_id}</Text>
                      <Text style={styles.metaText}>{inv.role} · {inv.status} · {formatTime(inv.created_at)}</Text>
                    </View>
                    <View style={[styles.statusBadge, inv.status === "Accepted" ? styles.statusBadgeSuccess : inv.status === "Cancelled" ? styles.statusBadgeFail : {}]}>
                      <Text style={styles.statusBadgeText}>{inv.status}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Audit Logs */}
            <View style={styles.adminSection}>
              <Text style={styles.adminSectionTitle}>Audit Logs</Text>
              {auditLogs.length === 0 ? (
                <Text style={styles.metaText}>No audit logs.</Text>
              ) : null}
              {auditLogs.map((log) => (
                <View key={log.event_id} style={styles.auditRow}>
                  <Text style={styles.auditAction}>{log.action}</Text>
                  <Text style={styles.metaText}>{log.actor_id} · {formatTime(log.created_at)}</Text>
                  {log.target_id ? <Text style={styles.metaText}>Target: {log.target_id}</Text> : null}
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}

        </Animated.View>
      </SafeAreaView>

      {/* ── Hamburger drawer ───────────────────────────────────── */}
      {menuOpen ? (
        <>
          <Animated.View
            style={[styles.menuOverlay, { opacity: overlayAnim }]}
            pointerEvents="auto"
          >
            <Pressable style={{ flex: 1 }} onPress={closeMenu} />
          </Animated.View>
          <Animated.View style={[styles.menuDrawer, { transform: [{ translateX: drawerAnim }] }]}>
            <View style={styles.menuDrawerHeader}>
              <Text style={styles.menuDrawerTitle}>Menu</Text>
              <Pressable onPress={closeMenu}>
                <Text style={styles.menuDrawerClose}>✕</Text>
              </Pressable>
            </View>
            {([
              { id: "dispatch", icon: "🗺", label: "Dispatch" },
              { id: "orders",   icon: "📋", label: "Orders"   },
              { id: "admin",    icon: "⚙",  label: "Admin"    },
            ] as { id: AdminTab; icon: string; label: string }[]).map(({ id, icon, label }) => (
              <Pressable
                key={id}
                style={[styles.menuItem, activeTab === id && styles.menuItemActive]}
                onPress={() => switchTab(id)}
              >
                <Text style={styles.menuItemIcon}>{icon}</Text>
                <Text style={[styles.menuItemText, activeTab === id && styles.menuItemTextActive]}>
                  {label}
                </Text>
                {activeTab === id ? <View style={styles.menuItemDot} /> : null}
              </Pressable>
            ))}
            <View style={styles.menuDivider} />
            <Pressable style={styles.menuItem} onPress={onSignOut}>
              <Text style={styles.menuItemIcon}>↩</Text>
              <Text style={styles.menuItemText}>Sign Out</Text>
            </Pressable>
          </Animated.View>
        </>
      ) : null}

      {/* ── Create order modal ──────────────────────────────────── */}
      <Modal visible={createVisible} animationType="slide" transparent onRequestClose={() => setCreateVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Order</Text>
              <Pressable onPress={() => setCreateVisible(false)}><Text style={styles.modalClose}>✕</Text></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              <OrderFormFields form={createForm} setForm={setCreateForm} />
              {createMsg ? <Text style={styles.errorText}>{createMsg}</Text> : null}
              <View style={styles.row}>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => createOrder().catch(() => undefined)}>
                  <Text style={styles.btnText}>Create Order</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setCreateVisible(false)}>
                  <Text style={styles.btnGhostText}>Cancel</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Edit order modal ────────────────────────────────────── */}
      <Modal visible={!!editOrder} animationType="slide" transparent onRequestClose={() => setEditOrder(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Edit Order</Text>
              <Pressable onPress={() => setEditOrder(null)}><Text style={styles.modalClose}>✕</Text></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              <OrderFormFields form={editForm} setForm={setEditForm} />
              {editMsg ? <Text style={styles.errorText}>{editMsg}</Text> : null}
              <View style={styles.row}>
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => saveEditOrder().catch(() => undefined)}>
                  <Text style={styles.btnText}>Save Changes</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setEditOrder(null)}>
                  <Text style={styles.btnGhostText}>Cancel</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

    </View>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function SeatCard({ label, used, total, pending }: { label: string; used: number; total: number; pending: number }) {
  return (
    <View style={styles.seatCard}>
      <Text style={styles.seatCardLabel}>{label}</Text>
      <Text style={styles.seatCardValue}>{used} / {total}</Text>
      {pending > 0 ? <Text style={styles.metaText}>{pending} pending</Text> : null}
    </View>
  );
}

function StatChip({ label, value, accent, label2 }: { label: string; value: number; accent?: boolean; label2?: string }) {
  return (
    <View style={[styles.statChip, accent && styles.statChipAccent]}>
      {label2 ? (
        <Text style={styles.statValue}>{label2}</Text>
      ) : (
        <Text style={styles.statValue}>{value}</Text>
      )}
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

type DispatchTabProps = {
  unassignedOrders: OrderRecord[];
  assignedOrders: OrderRecord[];
  selectedDriverId: string | null;
  drivers: DriverLocationRecord[];
  selectedOrderIds: Set<string>;
  setSelectedOrderIds: (fn: (prev: Set<string>) => Set<string>) => void;
  onAssign: (id: string) => void;
  onUnassign: (id: string) => void;
  onBulkAssign: () => void;
  onSelectDriver: (d: DriverLocationRecord) => void;
  onOptimise: () => void;
  routePlan: RouteOptimizeResponse | null;
  orders: OrderRecord[];
};

function DispatchTab({
  unassignedOrders,
  assignedOrders,
  selectedDriverId,
  drivers,
  selectedOrderIds,
  setSelectedOrderIds,
  onAssign,
  onUnassign,
  onBulkAssign,
  onSelectDriver,
  onOptimise,
  routePlan,
  orders,
}: DispatchTabProps) {
  function toggleSelect(id: string) {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      {/* ── Drivers section ─────────────────────────────────── */}
      <Text style={styles.sectionSubtitle}>Drivers ({drivers.length})</Text>
      {drivers.length === 0 ? (
        <Text style={styles.metaText}>No active drivers.</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
          {drivers.map((driver) => {
            const isSelected = driver.driver_id === selectedDriverId;
            const driverOrderCount = orders.filter((o) => o.assigned_to === driver.driver_id).length;
            return (
              <Pressable
                key={driver.driver_id}
                style={[styles.driverPill, isSelected && styles.driverPillSelected]}
                onPress={() => onSelectDriver(driver)}
              >
                <View style={[styles.driverDot, { backgroundColor: isSelected ? "#C8973A" : "#0e7aa6" }]} />
                <View>
                  <Text style={[styles.driverPillName, isSelected && { color: "#C8973A" }]} numberOfLines={1}>
                    {driver.driver_id}
                  </Text>
                  <Text style={styles.metaText}>{driverOrderCount} order{driverOrderCount !== 1 ? "s" : ""}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Selected driver detail */}
      {selectedDriverId ? (
        <View style={styles.sectionCard}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={styles.sectionTitle} numberOfLines={1}>{selectedDriverId}</Text>
            <Pressable style={[styles.btn, styles.btnGhost, { paddingHorizontal: 10, paddingVertical: 5 }]} onPress={onOptimise}>
              <Text style={styles.btnGhostText}>⚡ Optimise</Text>
            </Pressable>
          </View>
          {routePlan ? (
            <>
              <Text style={styles.metaText}>
                Route: {formatDistanceMiles(routePlan.total_distance_meters)} · {formatDurationShort(routePlan.total_duration_seconds)}
              </Text>
              {routePlan.ordered_stops.map((stop, i) => (
                <Text key={stop.order_id} style={styles.routeStop}>
                  {i + 1}. {stop.address || `${stop.lat.toFixed(3)}, ${stop.lng.toFixed(3)}`} — {formatDistanceMiles(stop.distance_from_previous_meters)}
                </Text>
              ))}
            </>
          ) : (
            <Text style={styles.metaText}>{assignedOrders.length} order(s) assigned</Text>
          )}
        </View>
      ) : null}

      {/* Bulk assign */}
      {selectedOrderIds.size > 0 ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionSubtitle}>Bulk Assign ({selectedOrderIds.size} selected)</Text>
          {selectedDriverId ? (
            <Text style={styles.metaText}>Assign to: {selectedDriverId}</Text>
          ) : (
            <Text style={[styles.metaText, { color: "#C8973A" }]}>Tap a driver above to select them first</Text>
          )}
          <View style={styles.row}>
            <Pressable
              style={[styles.btn, styles.btnPrimary, !selectedDriverId && { opacity: 0.4 }]}
              onPress={onBulkAssign}
              disabled={!selectedDriverId}
            >
              <Text style={styles.btnText}>Assign Selected</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setSelectedOrderIds(() => new Set())}>
              <Text style={styles.btnGhostText}>Clear</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Unassigned queue */}
      <Text style={styles.sectionSubtitle}>Unassigned ({unassignedOrders.length})</Text>
      {unassignedOrders.length === 0 ? (
        <Text style={styles.metaText}>All orders assigned ✓</Text>
      ) : null}
      {unassignedOrders.map((order) => (
        <View key={order.id} style={[styles.orderCard, selectedOrderIds.has(order.id) && styles.orderCardSelected]}>
          <Pressable onPress={() => toggleSelect(order.id)} style={styles.orderCheckRow}>
            <View style={[styles.checkbox, selectedOrderIds.has(order.id) && styles.checkboxChecked]}>
              {selectedOrderIds.has(order.id) ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderTitle}>{order.customer_name}</Text>
              <Text style={styles.orderMeta}>#{orderReference(order)} · {order.status}</Text>
              <Text style={styles.orderMeta} numberOfLines={1}>Pick up: {pickupAddress(order) || "-"}</Text>
              <Text style={styles.orderMeta} numberOfLines={1}>Deliver: {deliveryAddress(order) || "-"}</Text>
              {order.time_window_end ? (
                <Text style={styles.orderMeta}>Due: {formatTime(order.time_window_end)}</Text>
              ) : null}
            </View>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnPrimary, { marginTop: 8 }, !selectedDriverId && { opacity: 0.4 }]}
            onPress={() => onAssign(order.id)}
            disabled={!selectedDriverId}
          >
            <Text style={styles.btnText}>
              {selectedDriverId ? `Assign to ${selectedDriverId}` : "Select a driver first"}
            </Text>
          </Pressable>
        </View>
      ))}

      {/* Assigned orders for selected driver */}
      {selectedDriverId && assignedOrders.length > 0 ? (
        <>
          <Text style={styles.sectionSubtitle}>Assigned to {selectedDriverId}</Text>
          {assignedOrders.map((order) => (
            <View key={order.id} style={styles.orderCard}>
              <Text style={styles.orderTitle}>{order.customer_name}</Text>
              <Text style={styles.orderMeta}>#{orderReference(order)} · {order.status}</Text>
              <Text style={styles.orderMeta} numberOfLines={1}>Deliver: {deliveryAddress(order) || "-"}</Text>
              <View style={styles.row}>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => onUnassign(order.id)}>
                  <Text style={styles.btnGhostText}>Unassign</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

type OrdersTabProps = {
  orders: OrderRecord[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onEdit: (o: OrderRecord) => void;
  onUpdateStatus: (id: string, status: string) => void;
  onAssign: (id: string) => void;
  onUnassign: (id: string) => void;
  onCreateNew: () => void;
};

function OrdersTab({ orders, searchQuery, setSearchQuery, onEdit, onUpdateStatus, onAssign, onUnassign, onCreateNew }: OrdersTabProps) {
  return (
    <>
      <View style={styles.row}>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onCreateNew}>
          <Text style={styles.btnText}>+ New Order</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.searchInput}
        value={searchQuery}
        onChangeText={setSearchQuery}
        placeholder="Search orders…"
        placeholderTextColor="#4A3F60"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {orders.length === 0 ? <Text style={styles.metaText}>No orders found.</Text> : null}
      {orders.map((order) => (
        <View key={order.id} style={styles.orderCard}>
          <View style={styles.orderCardHeader}>
            <Text style={styles.orderTitle}>{order.customer_name}</Text>
            <Pressable style={styles.editBtn} onPress={() => onEdit(order)}>
              <Text style={styles.editBtnText}>Edit</Text>
            </Pressable>
          </View>
          <Text style={styles.orderMeta}>#{orderReference(order)} · Assigned: {order.assigned_to || "—"}</Text>
          <Text style={styles.orderMeta} numberOfLines={1}>Pick up: {pickupAddress(order) || "-"}</Text>
          <Text style={styles.orderMeta} numberOfLines={1}>Deliver: {deliveryAddress(order) || "-"}</Text>
          {order.time_window_start ? (
            <Text style={styles.orderMeta}>Window: {formatTime(order.time_window_start)} – {formatTime(order.time_window_end)}</Text>
          ) : null}
          <View style={styles.statusWrap}>
            {ADMIN_STATUS.map((s) => (
              <Pressable
                key={s}
                style={[styles.statusBtn, order.status === s && styles.statusBtnActive]}
                onPress={() => onUpdateStatus(order.id, s)}
              >
                <Text style={styles.statusBtnText}>{s}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            {!order.assigned_to ? (
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => onAssign(order.id)}>
                <Text style={styles.btnText}>Assign</Text>
              </Pressable>
            ) : (
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => onUnassign(order.id)}>
                <Text style={styles.btnGhostText}>Unassign</Text>
              </Pressable>
            )}
          </View>
        </View>
      ))}
    </>
  );
}

function OrderFormFields({
  form,
  setForm,
}: {
  form: CreateOrderForm;
  setForm: React.Dispatch<React.SetStateAction<CreateOrderForm>>;
}) {
  function field(key: keyof CreateOrderForm, label: string, opts?: { keyboardType?: "default" | "numeric" }) {
    return (
      <>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          style={styles.input}
          value={form[key]}
          onChangeText={(v) => setForm((p) => ({ ...p, [key]: v }))}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={opts?.keyboardType ?? "default"}
          placeholderTextColor="#4A3F60"
        />
      </>
    );
  }
  return (
    <>
      {field("customer_name", "Customer Name")}
      {field("pick_up_address", "Pick Up Address")}
      {field("delivery", "Delivery Address")}
      {field("dimensions", "Dimensions")}
      {field("weight", "Weight (lbs)", { keyboardType: "numeric" })}
      {field("time_window_start", "Window Start (ISO)")}
      {field("time_window_end", "Window End (ISO)")}
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0910" },
  safeArea: { flex: 1 },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brandMark: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: "#C8973A",
    alignItems: "center",
    justifyContent: "center",
  },
  brandMarkText: { color: "#0B0910", fontWeight: "800", fontSize: 16 },
  brandName: { color: "#F5D98B", fontSize: 16, fontWeight: "700" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  signOutBtn: {
    borderWidth: 1,
    borderColor: "#6B4F2A",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  signOutText: { color: "#C8973A", fontWeight: "700", fontSize: 12 },

  // Dispatch layout
  dispatchLayout: { flex: 1 },
  mapWrap: { flex: 3, position: "relative", minHeight: 200 },

  // Stats overlay on map
  mapStatsOverlay: {
    position: "absolute",
    top: 10,
    left: 10,
    right: 70,
  },
  mapStatsRow: { gap: 6, paddingRight: 4 },
  statChip: {
    backgroundColor: "rgba(19,15,26,0.88)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 8,
    paddingVertical: 5,
    alignItems: "center",
    minWidth: 52,
  },
  statChipAccent: { borderColor: "#C8973A", backgroundColor: "rgba(42,30,16,0.92)" },
  statValue: { color: "#EDE0C4", fontWeight: "700", fontSize: 14 },
  statLabel: { color: "#968AA8", fontSize: 9, fontWeight: "600", textTransform: "uppercase" },

  // Dispatch bottom panel
  dispatchPanel: {
    flex: 2,
    backgroundColor: "#0F0C16",
    borderTopWidth: 1,
    borderTopColor: "#3A2F50",
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#3A2F50",
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 4,
  },
  dispatchScroll: { flex: 1 },
  dispatchScrollContent: { padding: 12, gap: 8, paddingBottom: 16 },

  statusMsg: {
    color: "#968AA8",
    fontSize: 11,
    paddingHorizontal: 12,
    paddingVertical: 3,
  },

  // Tab bar (now at bottom)
  hamburgerBtn: { padding: 8 },
  hamburgerIcon: { color: "#EDE0C4", fontSize: 22, lineHeight: 26 },

  menuOverlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    zIndex: 100,
    flex: 1,
  },
  menuDrawer: {
    position: "absolute", top: 0, right: 0, bottom: 0,
    width: 240,
    backgroundColor: "#130F1E",
    zIndex: 101,
    borderLeftWidth: 1,
    borderLeftColor: "#3A2F50",
    paddingTop: 16,
  },
  menuDrawerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
    marginBottom: 8,
  },
  menuDrawerTitle: { color: "#EDE0C4", fontSize: 16, fontWeight: "700" },
  menuDrawerClose: { color: "#968AA8", fontSize: 18, padding: 4 },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  menuItemActive: { backgroundColor: "#1E1830" },
  menuItemIcon: { fontSize: 18, width: 24, textAlign: "center" },
  menuItemText: { color: "#968AA8", fontSize: 15, fontWeight: "600", flex: 1 },
  menuItemTextActive: { color: "#C8973A" },
  menuItemDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: "#C8973A",
  },
  menuDivider: { height: 1, backgroundColor: "#3A2F50", marginVertical: 8, marginHorizontal: 20 },

  // Orders / Admin tab scroll
  scroll: { flex: 1 },
  scrollContent: { padding: 14, gap: 8, paddingBottom: 40 },

  searchInput: {
    borderWidth: 1,
    borderColor: "#3A2F50",
    borderRadius: 10,
    color: "#EDE0C4",
    backgroundColor: "#0F0C16",
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    marginBottom: 4,
  },

  sectionCard: {
    backgroundColor: "#1A1526",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 10,
    gap: 4,
  },
  sectionTitle: { color: "#F5D98B", fontSize: 14, fontWeight: "700" },
  sectionSubtitle: { color: "#EDE0C4", fontSize: 13, fontWeight: "600", marginTop: 4 },
  metaText: { color: "#968AA8", fontSize: 12 },

  // Driver pills (horizontal scroll in dispatch panel)
  driverPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#1A1526",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 120,
  },
  driverPillSelected: { borderColor: "#C8973A", backgroundColor: "#2A1E10" },
  driverPillName: { color: "#EDE0C4", fontWeight: "700", fontSize: 13, maxWidth: 140 },
  driverDot: { width: 10, height: 10, borderRadius: 5 },

  routeStop: { color: "#968AA8", fontSize: 11 },

  orderCard: {
    backgroundColor: "#1A1526",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 12,
    gap: 5,
  },
  orderCardSelected: { borderColor: "#C8973A", backgroundColor: "#2A1E10" },
  orderCardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  orderTitle: { color: "#EDE0C4", fontSize: 14, fontWeight: "700", flex: 1 },
  orderMeta: { color: "#968AA8", fontSize: 12 },
  orderCheckRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#3A2F50",
    backgroundColor: "#0F0C16",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  checkboxChecked: { backgroundColor: "#C8973A", borderColor: "#C8973A" },
  checkboxMark: { color: "#0B0910", fontWeight: "800", fontSize: 12 },
  editBtn: {
    borderWidth: 1,
    borderColor: "#3A2F50",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 6,
  },
  editBtnText: { color: "#968AA8", fontSize: 11, fontWeight: "600" },

  statusWrap: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 2 },
  statusBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusBtnActive: { backgroundColor: "#2A1E10", borderColor: "#C8973A" },
  statusBtnText: { color: "#EDE0C4", fontSize: 11, fontWeight: "600" },

  // Orders sub-tabs
  tabContent: { flex: 1 },
  subTabBar: {
    flexDirection: "row",
    backgroundColor: "#0B0910",
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
  },
  subTab: { flex: 1, paddingVertical: 10, alignItems: "center" },
  subTabActive: { borderBottomWidth: 2, borderBottomColor: "#C8973A" },
  subTabText: { color: "#968AA8", fontWeight: "600", fontSize: 12 },
  subTabTextActive: { color: "#C8973A" },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: "#2A2040",
    borderWidth: 1,
    borderColor: "#3A2F50",
  },
  statusBadgeSuccess: { backgroundColor: "#0E2A1A", borderColor: "#3A7A4A" },
  statusBadgeFail: { backgroundColor: "#2A1010", borderColor: "#7A3A3A" },
  statusBadgeText: { color: "#EDE0C4", fontSize: 11, fontWeight: "600" },

  // Admin tab
  adminSection: {
    backgroundColor: "#1A1526",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 14,
    gap: 4,
  },
  adminSectionTitle: { color: "#F5D98B", fontSize: 15, fontWeight: "700", marginBottom: 4 },
  adminStatRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: "#1F1A2E" },
  adminStatLabel: { color: "#968AA8", fontSize: 12 },
  adminStatValue: { color: "#EDE0C4", fontSize: 12, fontWeight: "600" },
  seatGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  seatCard: {
    flex: 1,
    minWidth: 100,
    backgroundColor: "#130F1A",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 10,
    gap: 2,
  },
  seatCardLabel: { color: "#968AA8", fontSize: 10, fontWeight: "600", textTransform: "uppercase" },
  seatCardValue: { color: "#EDE0C4", fontSize: 18, fontWeight: "700" },
  roleRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  roleBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  roleBtnActive: { backgroundColor: "#2A1E10", borderColor: "#C8973A" },
  roleBtnText: { color: "#968AA8", fontSize: 13, fontWeight: "600" },
  roleBtnTextActive: { color: "#C8973A" },
  invitationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#1F1A2E",
  },
  auditRow: {
    borderBottomWidth: 1,
    borderBottomColor: "#1F1A2E",
    paddingVertical: 6,
    gap: 2,
  },
  auditAction: { color: "#EDE0C4", fontSize: 13, fontWeight: "600" },

  // Modal
  modalBackdrop: { flex: 1, backgroundColor: "rgba(7,5,12,0.88)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: "#130F1A",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 16,
    maxHeight: "92%",
    gap: 8,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  modalTitle: { color: "#F5D98B", fontSize: 16, fontWeight: "700" },
  modalClose: { color: "#968AA8", fontSize: 18 },

  label: { color: "#968AA8", fontSize: 11, fontWeight: "600" },
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
  errorText: { color: "#F0C060", fontSize: 12, fontWeight: "600" },

  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  btn: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: "#C8973A" },
  btnGhost: { borderWidth: 1, borderColor: "#6B4F2A", backgroundColor: "#130F1A" },
  btnText: { color: "#0B0910", fontWeight: "700", fontSize: 13 },
  btnGhostText: { color: "#C8973A", fontWeight: "700", fontSize: 13 },
});
