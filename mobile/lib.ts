// lib.ts — Shared types, utilities, and API helpers for Discra Mobile
"use strict";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderRecord = {
  id: string;
  customer_name: string;
  // Reference: backend may use reference_number (int) or reference_id (string)
  reference_number?: number | null;
  reference_id?: string | null;
  // Structured address fields (desktop app / newer backend format)
  pick_up_street?: string | null;
  pick_up_city?: string | null;
  pick_up_state?: string | null;
  pick_up_zip?: string | null;
  delivery_street?: string | null;
  delivery_city?: string | null;
  delivery_state?: string | null;
  delivery_zip?: string | null;
  // Legacy combined address fields (older format)
  pick_up_address?: string | null;
  delivery?: string | null;
  // Common order fields
  dimensions?: string | null;
  weight?: number | null;
  time_window_start?: string | null;
  time_window_end?: string | null;
  status: string;
  assigned_to?: string | null;
  phone?: string | null;
  notes?: string | null;
};

export type DriverLocationRecord = {
  driver_id: string;
  lat: number;
  lng: number;
  timestamp: string;
};

export type RouteStep = {
  instruction: string;
  distance_meters: number;
  duration_seconds: number;
};

export type OsrmResult = {
  /** [lat, lng] pairs for the polyline */
  coords: Array<{ latitude: number; longitude: number }>;
  steps: RouteStep[];
  distance_meters: number;
  duration_seconds: number;
};

export type UserProfile = {
  sub?: string;
  email?: string;
  phone?: string | null;
  photo_url?: string | null;
  tsa_certified?: boolean | null;
};

export type PodPresignUpload = {
  artifact_type: "photo" | "signature";
  key: string;
  url: string;
  fields: Record<string, string>;
};

export type RouteOptimizedStop = {
  sequence: number;
  order_id: string;
  lat: number;
  lng: number;
  address?: string | null;
  distance_from_previous_meters: number;
  duration_from_previous_seconds: number;
};

export type RouteOptimizeResponse = {
  matrix_source: string;
  total_distance_meters: number;
  total_duration_seconds: number;
  ordered_stops: RouteOptimizedStop[];
};

export type AdminStats = {
  total: number;
  assigned: number;
  unassigned: number;
  active_drivers: number;
  due_soon: number;
};

// ─── Address helpers ──────────────────────────────────────────────────────────

export function pickupAddress(order: OrderRecord): string {
  const structured = [
    order.pick_up_street,
    order.pick_up_city,
    order.pick_up_state,
    order.pick_up_zip,
  ]
    .filter(Boolean)
    .join(", ");
  return structured || order.pick_up_address || "";
}

export function deliveryAddress(order: OrderRecord): string {
  const structured = [
    order.delivery_street,
    order.delivery_city,
    order.delivery_state,
    order.delivery_zip,
  ]
    .filter(Boolean)
    .join(", ");
  return structured || order.delivery || "";
}

export function orderReference(order: OrderRecord): string {
  if (order.reference_id) return order.reference_id;
  if (order.reference_number != null) return String(order.reference_number);
  return order.id.slice(0, 8);
}

// ─── Haversine distance (metres) ─────────────────────────────────────────────

export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatTime(value?: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export function formatDistanceMiles(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "-";
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

export function formatDurationShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = (token || "").split(".");
  if (parts.length < 2 || !parts[1] || typeof globalThis.atob !== "function") return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractTokenGroups(token: string): string[] {
  const payload = decodeJwtPayload(token);
  if (!payload) return [];
  const groups = payload["cognito:groups"] ?? payload.groups;
  if (Array.isArray(groups)) return groups.map((g) => String(g));
  if (groups) return [String(groups)];
  return [];
}

// ─── API ─────────────────────────────────────────────────────────────────────

export function normalizeApiBase(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

export function endpointUrl(apiBase: string, path: string): string {
  const base = normalizeApiBase(apiBase);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

type ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token: string;
  json?: unknown;
};

export async function apiRequest<T>(
  apiBase: string,
  path: string,
  options: ApiRequestOptions
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
  };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(endpointUrl(apiBase, path), {
    method: options.method ?? "GET",
    headers,
    body,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
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

// ─── Geocoding ────────────────────────────────────────────────────────────────

type GeocodeCache = Map<string, { lat: number; lng: number }>;

export async function geocodeAddress(
  address: string,
  cache: GeocodeCache
): Promise<{ lat: number; lng: number } | null> {
  const key = address.trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const resp = await fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1`
    );
    const data = (await resp.json()) as { features?: Array<{ geometry: { coordinates: [number, number] } }> };
    if (!data.features?.length) return null;
    const [lng, lat] = data.features[0].geometry.coordinates;
    const result = { lat, lng };
    cache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

// ─── OSRM Routing ─────────────────────────────────────────────────────────────

function _buildOsrmInstruction(maneuver: {
  type?: string;
  modifier?: string;
  exit?: number;
}, name?: string): string {
  const parts: string[] = [];
  const mod = maneuver.modifier || "";
  const mtype = maneuver.type || "";
  if (mtype === "depart") parts.push(`Head ${mod || "north"}`);
  else if (mtype === "arrive") parts.push("Arrive at destination");
  else if (mtype === "turn") parts.push(`Turn ${mod}`);
  else if (mtype === "new name" || mtype === "continue") parts.push(`Continue${mod ? " " + mod : ""}`);
  else if (mtype === "merge") parts.push(`Merge ${mod}`);
  else if (mtype === "fork") parts.push(`Take the ${mod} fork`);
  else if (mtype === "roundabout" || mtype === "rotary") parts.push(`Enter roundabout, exit ${maneuver.exit ?? ""}`);
  else parts.push(`${mtype} ${mod}`.trim());
  if (name) parts.push(`onto ${name}`);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function fetchOsrmRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<OsrmResult | null> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fromLng},${fromLat};${toLng},${toLat}` +
      `?overview=full&geometries=geojson&steps=true`;
    const resp = await fetch(url);
    const data = (await resp.json()) as {
      code?: string;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry: { coordinates: Array<[number, number]> };
        legs: Array<{
          steps: Array<{
            distance: number;
            duration: number;
            name?: string;
            maneuver: { type?: string; modifier?: string; exit?: number };
          }>;
        }>;
      }>;
    };
    if (data.code !== "Ok" || !data.routes?.length) {
      // Fallback: straight line
      return {
        coords: [
          { latitude: fromLat, longitude: fromLng },
          { latitude: toLat, longitude: toLng },
        ],
        steps: [{ instruction: "Head to destination", distance_meters: haversineDistance(fromLat, fromLng, toLat, toLng), duration_seconds: 0 }],
        distance_meters: haversineDistance(fromLat, fromLng, toLat, toLng),
        duration_seconds: 0,
      };
    }
    const route = data.routes[0];
    const coords = route.geometry.coordinates.map(([lng, lat]) => ({
      latitude: lat,
      longitude: lng,
    }));
    const steps: RouteStep[] = [];
    for (const leg of route.legs) {
      for (const step of leg.steps) {
        steps.push({
          instruction: _buildOsrmInstruction(step.maneuver, step.name),
          distance_meters: step.distance,
          duration_seconds: step.duration,
        });
      }
    }
    return {
      coords,
      steps,
      distance_meters: route.distance,
      duration_seconds: route.duration,
    };
  } catch {
    return null;
  }
}
