// AdminScreen.tsx — Dispatcher / admin dashboard with map, stats, order management
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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

type AdminTab = "dispatch" | "drivers" | "orders";

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
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [assignInputs, setAssignInputs] = useState<Record<string, string>>({});
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [bulkDriverId, setBulkDriverId] = useState("");

  // ── Create order modal ─────────────────────────────────────────────────────
  const [createVisible, setCreateVisible] = useState(false);
  const [createForm, setCreateForm] = useState<CreateOrderForm>(BLANK_FORM);
  const [createMsg, setCreateMsg] = useState("");

  // ── Edit order modal ───────────────────────────────────────────────────────
  const [editOrder, setEditOrder] = useState<OrderRecord | null>(null);
  const [editForm, setEditForm] = useState<CreateOrderForm>(BLANK_FORM);
  const [editMsg, setEditMsg] = useState("");

  // ── Inflight / audit ──────────────────────────────────────────────────────
  const [inflight, setInflight] = useState<OrderRecord[]>([]);
  const [inflightVisible, setInflightVisible] = useState(false);

  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<MapView | null>(null);

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
      for (const s of routePlan.ordered_stops) {
        pts.push({ latitude: s.lat, longitude: s.lng });
      }
      return pts;
    }
    // Fallback: delivery coords from assigned orders
    const driverOrders = orders.filter((o) => o.assigned_to === selectedDriverId);
    for (const o of driverOrders) {
      const addr = deliveryAddress(o);
      // Skip if no parseable coords — just show what we have
      void addr;
    }
    return pts;
  }, [selectedDriver, routePlan, orders, selectedDriverId]);

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

  // ── Unassigned queue (for dispatch tab) ───────────────────────────────────
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

        // Build map region from driver positions
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
          // Auto-select first driver if none selected
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

  // ── Auto-refresh ───────────────────────────────────────────────────────────
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

  // ── Optimise route for selected driver ────────────────────────────────────
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
    const driverId = (assignInputs[orderId] || selectedDriverId || "").trim();
    if (!driverId) { setStatusMsg("Select a driver or enter a driver ID."); return; }
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
    const driverId = bulkDriverId.trim() || selectedDriverId || "";
    if (!driverId) { setStatusMsg("Enter a driver ID for bulk assign."); return; }
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

  // ── Inflight ───────────────────────────────────────────────────────────────
  async function loadInflight() {
    setLoading(true);
    try {
      const data = await apiRequest<OrderRecord[]>(apiBase, "/inflight", { token });
      setInflight(data || []);
      setInflightVisible(true);
    } catch (e) {
      setStatusMsg(e instanceof Error ? e.message : "Inflight load failed.");
    } finally {
      setLoading(false);
    }
  }

  // ── Driver focus ──────────────────────────────────────────────────────────
  function focusDriver(driver: DriverLocationRecord) {
    setSelectedDriverId(driver.driver_id);
    setRoutePlan(null);
    mapRef.current?.animateToRegion({
      latitude: driver.lat,
      longitude: driver.lng,
      latitudeDelta: 0.05,
      longitudeDelta: 0.05,
    }, 600);
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
            <Pressable style={styles.signOutBtn} onPress={onSignOut}>
              <Text style={styles.signOutText}>Sign Out</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Stats strip ────────────────────────────────────────── */}
        <View style={styles.statsStrip}>
          <StatChip label="Orders" value={stats.total} />
          <StatChip label="Assigned" value={stats.assigned} />
          <StatChip label="Unassigned" value={stats.unassigned} accent={stats.unassigned > 0} />
          <StatChip label="Drivers" value={stats.active_drivers} />
          {stats.due_soon > 0 ? <StatChip label="Due Soon" value={stats.due_soon} accent /> : null}
        </View>

        {/* ── Map ────────────────────────────────────────────────── */}
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
          {/* Map action buttons */}
          <View style={styles.mapActions} pointerEvents="box-none">
            <Pressable style={styles.mapBtn} onPress={() => loadData().catch(() => undefined)}>
              <Text style={styles.mapBtnText}>↻ Refresh</Text>
            </Pressable>
            <Pressable style={styles.mapBtn} onPress={() => optimiseRoute().catch(() => undefined)}>
              <Text style={styles.mapBtnText}>⚡ Optimise</Text>
            </Pressable>
            <Pressable style={styles.mapBtn} onPress={() => loadInflight().catch(() => undefined)}>
              <Text style={styles.mapBtnText}>✈ In Flight</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Status message ──────────────────────────────────────── */}
        {statusMsg ? (
          <Text style={styles.statusMsg} numberOfLines={1}>{statusMsg}</Text>
        ) : null}

        {/* ── Tab bar ────────────────────────────────────────────── */}
        <View style={styles.tabBar}>
          {(["dispatch", "drivers", "orders"] as AdminTab[]).map((tab) => (
            <Pressable
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === "dispatch" ? "Dispatch" : tab === "drivers" ? "Drivers" : "Orders"}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* ── Tab content ────────────────────────────────────────── */}
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

          {/* DISPATCH TAB */}
          {activeTab === "dispatch" ? (
            <DispatchTab
              unassignedOrders={unassignedOrders}
              assignedOrders={assignedOrders}
              selectedDriverId={selectedDriverId}
              drivers={drivers}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              assignInputs={assignInputs}
              setAssignInputs={setAssignInputs}
              selectedOrderIds={selectedOrderIds}
              setSelectedOrderIds={setSelectedOrderIds}
              bulkDriverId={bulkDriverId}
              setBulkDriverId={setBulkDriverId}
              onAssign={assignOrder}
              onUnassign={unassignOrder}
              onBulkAssign={bulkAssign}
              onUpdateStatus={updateStatus}
              routePlan={routePlan}
            />
          ) : null}

          {/* DRIVERS TAB */}
          {activeTab === "drivers" ? (
            <DriversTab
              drivers={drivers}
              selectedDriverId={selectedDriverId}
              orders={orders}
              onSelectDriver={focusDriver}
              onOptimise={optimiseRoute}
              routePlan={routePlan}
            />
          ) : null}

          {/* ORDERS TAB */}
          {activeTab === "orders" ? (
            <OrdersTab
              orders={filteredOrders}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              onEdit={openEditOrder}
              onUpdateStatus={updateStatus}
              onAssign={assignOrder}
              onUnassign={unassignOrder}
              assignInputs={assignInputs}
              setAssignInputs={setAssignInputs}
              onCreateNew={() => { setCreateForm(BLANK_FORM); setCreateMsg(""); setCreateVisible(true); }}
            />
          ) : null}

        </ScrollView>
      </SafeAreaView>

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

      {/* ── In-flight modal ──────────────────────────────────────── */}
      <Modal visible={inflightVisible} animationType="slide" transparent onRequestClose={() => setInflightVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>In Flight ({inflight.length})</Text>
              <Pressable onPress={() => setInflightVisible(false)}><Text style={styles.modalClose}>✕</Text></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ gap: 8 }}>
              {inflight.length === 0 ? <Text style={styles.metaText}>No in-flight orders.</Text> : null}
              {inflight.map((o) => (
                <View key={o.id} style={styles.orderCard}>
                  <Text style={styles.orderTitle}>{o.customer_name}</Text>
                  <Text style={styles.orderMeta}>#{orderReference(o)} · {o.status} · {o.assigned_to || "Unassigned"}</Text>
                  <Text style={styles.orderMeta}>Delivery: {deliveryAddress(o) || "-"}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function StatChip({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <View style={[styles.statChip, accent && styles.statChipAccent]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

type DispatchTabProps = {
  unassignedOrders: OrderRecord[];
  assignedOrders: OrderRecord[];
  selectedDriverId: string | null;
  drivers: DriverLocationRecord[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  assignInputs: Record<string, string>;
  setAssignInputs: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  selectedOrderIds: Set<string>;
  setSelectedOrderIds: (fn: (prev: Set<string>) => Set<string>) => void;
  bulkDriverId: string;
  setBulkDriverId: (v: string) => void;
  onAssign: (id: string) => void;
  onUnassign: (id: string) => void;
  onBulkAssign: () => void;
  onUpdateStatus: (id: string, status: string) => void;
  routePlan: RouteOptimizeResponse | null;
};

function DispatchTab({
  unassignedOrders,
  assignedOrders,
  selectedDriverId,
  drivers,
  searchQuery,
  setSearchQuery,
  assignInputs,
  setAssignInputs,
  selectedOrderIds,
  setSelectedOrderIds,
  bulkDriverId,
  setBulkDriverId,
  onAssign,
  onUnassign,
  onBulkAssign,
  onUpdateStatus,
  routePlan,
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
      <TextInput
        style={styles.searchInput}
        value={searchQuery}
        onChangeText={setSearchQuery}
        placeholder="Search orders…"
        placeholderTextColor="#4A3F60"
        autoCapitalize="none"
        autoCorrect={false}
      />

      {selectedDriverId ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Selected Driver: {selectedDriverId}</Text>
          {routePlan ? (
            <Text style={styles.metaText}>
              Route: {formatDistanceMiles(routePlan.total_distance_meters)} · {formatDurationShort(routePlan.total_duration_seconds)}
            </Text>
          ) : null}
          {assignedOrders.length > 0 ? (
            <Text style={styles.metaText}>{assignedOrders.length} order(s) assigned</Text>
          ) : (
            <Text style={styles.metaText}>No orders assigned</Text>
          )}
        </View>
      ) : null}

      {/* Bulk assign */}
      {selectedOrderIds.size > 0 ? (
        <View style={styles.sectionCard}>
          <Text style={styles.sectionSubtitle}>Bulk Assign ({selectedOrderIds.size} selected)</Text>
          <TextInput
            style={styles.input}
            value={bulkDriverId}
            onChangeText={setBulkDriverId}
            placeholder={selectedDriverId ? `Driver: ${selectedDriverId}` : "Driver ID"}
            placeholderTextColor="#4A3F60"
            autoCapitalize="none"
          />
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onBulkAssign}>
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
          <TextInput
            style={[styles.input, { marginTop: 6 }]}
            value={assignInputs[order.id] ?? ""}
            placeholder={selectedDriverId ? `Driver: ${selectedDriverId}` : "Driver ID"}
            placeholderTextColor="#4A3F60"
            onChangeText={(v) => setAssignInputs((p) => ({ ...p, [order.id]: v }))}
            autoCapitalize="none"
          />
          <Pressable style={[styles.btn, styles.btnPrimary, { marginTop: 4 }]} onPress={() => onAssign(order.id)}>
            <Text style={styles.btnText}>Assign</Text>
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

type DriversTabProps = {
  drivers: DriverLocationRecord[];
  selectedDriverId: string | null;
  orders: OrderRecord[];
  onSelectDriver: (d: DriverLocationRecord) => void;
  onOptimise: () => void;
  routePlan: RouteOptimizeResponse | null;
};

function DriversTab({ drivers, selectedDriverId, orders, onSelectDriver, onOptimise, routePlan }: DriversTabProps) {
  return (
    <>
      {drivers.length === 0 ? (
        <Text style={styles.metaText}>No active drivers found.</Text>
      ) : null}
      {drivers.map((driver) => {
        const driverOrders = orders.filter((o) => o.assigned_to === driver.driver_id);
        const isSelected = driver.driver_id === selectedDriverId;
        return (
          <Pressable
            key={driver.driver_id}
            style={[styles.driverCard, isSelected && styles.driverCardSelected]}
            onPress={() => onSelectDriver(driver)}
          >
            <View style={styles.driverCardRow}>
              <View style={[styles.driverDot, { backgroundColor: isSelected ? "#C8973A" : "#0e7aa6" }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.driverTitle}>{driver.driver_id}</Text>
                <Text style={styles.metaText}>
                  {driver.lat.toFixed(4)}, {driver.lng.toFixed(4)} · {formatTime(driver.timestamp)}
                </Text>
                <Text style={styles.metaText}>{driverOrders.length} order(s) assigned</Text>
              </View>
            </View>
            {isSelected && routePlan ? (
              <View style={styles.routePlanCard}>
                <Text style={styles.routePlanTitle}>
                  Optimised: {formatDistanceMiles(routePlan.total_distance_meters)} · {formatDurationShort(routePlan.total_duration_seconds)}
                </Text>
                {routePlan.ordered_stops.map((stop, i) => (
                  <Text key={stop.order_id} style={styles.routeStop}>
                    {i + 1}. {stop.address || `${stop.lat.toFixed(4)}, ${stop.lng.toFixed(4)}`} — {formatDistanceMiles(stop.distance_from_previous_meters)}
                  </Text>
                ))}
              </View>
            ) : isSelected ? (
              <Pressable style={[styles.btn, styles.btnPrimary, { marginTop: 8 }]} onPress={onOptimise}>
                <Text style={styles.btnText}>⚡ Optimise Route</Text>
              </Pressable>
            ) : null}
          </Pressable>
        );
      })}
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
  assignInputs: Record<string, string>;
  setAssignInputs: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  onCreateNew: () => void;
};

function OrdersTab({ orders, searchQuery, setSearchQuery, onEdit, onUpdateStatus, onAssign, onUnassign, assignInputs, setAssignInputs, onCreateNew }: OrdersTabProps) {
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
          {/* Status buttons */}
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
          {/* Assign input */}
          <TextInput
            style={[styles.input, { marginTop: 6 }]}
            value={assignInputs[order.id] ?? order.assigned_to ?? ""}
            placeholder="Driver ID"
            placeholderTextColor="#4A3F60"
            onChangeText={(v) => setAssignInputs((p) => ({ ...p, [order.id]: v }))}
            autoCapitalize="none"
          />
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => onAssign(order.id)}>
              <Text style={styles.btnText}>Assign</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => onUnassign(order.id)}>
              <Text style={styles.btnGhostText}>Unassign</Text>
            </Pressable>
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
  function field(key: keyof CreateOrderForm, label: string, opts?: { multiline?: boolean; keyboardType?: "default" | "numeric" | "email-address" | "phone-pad" }) {
    return (
      <>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          style={[styles.input, opts?.multiline && { minHeight: 64, textAlignVertical: "top" }]}
          value={form[key]}
          onChangeText={(v) => setForm((p) => ({ ...p, [key]: v }))}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={opts?.multiline}
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

  // Stats strip
  statsStrip: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
  },
  statChip: {
    flex: 1,
    backgroundColor: "#1A1526",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 6,
    paddingVertical: 5,
    alignItems: "center",
  },
  statChipAccent: { borderColor: "#C8973A", backgroundColor: "#2A1E10" },
  statValue: { color: "#EDE0C4", fontWeight: "700", fontSize: 15 },
  statLabel: { color: "#968AA8", fontSize: 9, fontWeight: "600", textTransform: "uppercase" },

  // Map
  mapWrap: { height: 200, position: "relative" },
  mapActions: {
    position: "absolute",
    top: 8,
    right: 8,
    gap: 6,
  },
  mapBtn: {
    backgroundColor: "rgba(19,15,26,0.9)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A2F50",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  mapBtnText: { color: "#C8973A", fontWeight: "700", fontSize: 11 },
  statusMsg: {
    color: "#968AA8",
    fontSize: 11,
    paddingHorizontal: 16,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#1A1526",
  },

  // Tab bar
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#3A2F50",
    backgroundColor: "#0B0910",
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: "center" },
  tabActive: { borderBottomWidth: 2, borderBottomColor: "#C8973A" },
  tabText: { color: "#968AA8", fontWeight: "600", fontSize: 13 },
  tabTextActive: { color: "#C8973A" },

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

  driverCard: {
    backgroundColor: "#1A1526",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 12,
  },
  driverCardSelected: { borderColor: "#C8973A", backgroundColor: "#2A1E10" },
  driverCardRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  driverDot: { width: 12, height: 12, borderRadius: 6, marginTop: 3 },
  driverTitle: { color: "#EDE0C4", fontWeight: "700", fontSize: 14 },
  routePlanCard: {
    backgroundColor: "#130F1A",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3A2F50",
    padding: 8,
    marginTop: 8,
    gap: 3,
  },
  routePlanTitle: { color: "#C8973A", fontWeight: "700", fontSize: 12 },
  routeStop: { color: "#968AA8", fontSize: 11 },

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
