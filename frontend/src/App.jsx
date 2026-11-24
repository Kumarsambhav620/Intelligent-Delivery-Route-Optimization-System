import { useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, Bike, Check, ChevronDown,
  CircleHelp, Clock3, Coffee, Command, Compass, Download, Factory, Fuel, Gauge, IndianRupee,
  Layers3, LocateFixed, MapPinned, Menu, MoreHorizontal, PackageCheck,
  PackageOpen, RefreshCw, Route, Search, Settings2, ShieldCheck, SlidersHorizontal, Navigation,
  Store, Truck, Utensils, WalletCards, X,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { divIcon } from "leaflet";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip as MapTooltip, useMap } from "react-leaflet";

const navigation = [
  { label: "Overview", icon: Gauge },
  { label: "Rider app", icon: Bike },
  { label: "Live operations", icon: MapPinned },
  { label: "Orders", icon: PackageOpen },
  { label: "Restaurants", icon: Store },
  { label: "Delivery agents", icon: Bike },
  { label: "Route optimization", icon: Route },
  { label: "Analytics", icon: Activity },
];

const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value || 0);
const titleCase = (value = "") => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

async function api(path, options) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.detail || "Request failed");
  return data;
}

function MapPanel({ restaurants, agents, orders, result, large = false, animateRoute = false, animationKey = "preview" }) {
  const routes = result?.routes || [];
  const routePoints = routes.flatMap((route) => route.geometry?.length
    ? route.geometry
    : route.stops.map((stop) => [stop.location.latitude, stop.location.longitude]));
  const mapPoints = routePoints.length ? routePoints : [
    ...agents.map((agent) => [agent.latitude, agent.longitude]),
    ...restaurants.map((restaurant) => [restaurant.latitude, restaurant.longitude]),
    ...orders.map((order) => [order.customer_latitude, order.customer_longitude]),
  ];
  const mapKey = mapPoints.length ? `${mapPoints.length}-${mapPoints[0].join(",")}-${mapPoints.at(-1).join(",")}` : "empty-map";
  return (
    <div className={`map-frame ${large ? "map-frame-large" : ""}`}>
      <MapContainer key={mapKey} center={[28.474, 77.505]} zoom={13} scrollWheelZoom className="dispatch-map">
        <MapAutoFit points={mapPoints} mapKey={mapKey} />
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {routes.map((route, routeIndex) => {
          const positions = route.geometry?.length
            ? route.geometry.map(([latitude, longitude]) => [latitude, longitude])
            : route.stops.map((stop) => [stop.location.latitude, stop.location.longitude]);
          const simulated = result.routing_source?.startsWith("simulated-");
          return positions.length > 1 && (route.geometry?.length || simulated)
            ? <Polyline key={route.agent_id} positions={positions} pathOptions={{ color: ["#168b68", "#e29a32", "#5476c8", "#ce5d51", "#805bb4"][routeIndex % 5], weight: 4, dashArray: simulated ? "7 8" : undefined, opacity: 0.86 }} />
            : null;
        })}
        {animateRoute && routes.map((route) => route.geometry?.length > 1
          ? <AnimatedRouteMarker key={`${animationKey}-${route.agent_id}`} route={route} routeKey={`${animationKey}-${route.agent_id}`} />
          : null)}
          {routes.flatMap((route, routeIndex) => route.stops.map((stop) => <Marker key={`${route.agent_id}-${stop.sequence}`} position={[stop.location.latitude, stop.location.longitude]} icon={divIcon({ className: `route-stop-marker route-stop-${routeIndex % 5}`, html: String(stop.sequence), iconSize: [25, 25], iconAnchor: [12, 12] })}><MapTooltip>{stop.type === "pickup" ? "Pickup" : "Drop-off"} {stop.sequence} · {stop.order_id}</MapTooltip></Marker>))}
        {restaurants.map((restaurant) => <CircleMarker key={restaurant.id} center={[restaurant.latitude, restaurant.longitude]} radius={7} pathOptions={{ color: "#a35b36", fillColor: "#eab485", fillOpacity: 1 }}><MapTooltip>{restaurant.name}</MapTooltip></CircleMarker>)}
        {agents.map((agent) => <CircleMarker key={agent.id} center={[agent.latitude, agent.longitude]} radius={7} pathOptions={{ color: "#155f4c", fillColor: agent.available ? "#24a37d" : "#e0a13c", fillOpacity: 1 }}><MapTooltip>{agent.name} · {agent.available ? "Available" : "On delivery"}</MapTooltip></CircleMarker>)}
        {orders.filter((order) => !["delivered", "cancelled"].includes(order.status)).map((order) => <CircleMarker key={order.id} center={[order.customer_latitude, order.customer_longitude]} radius={5} pathOptions={{ color: "#b54742", fillColor: "#e98276", fillOpacity: 0.8 }}><MapTooltip>{order.id} · {titleCase(order.status)}</MapTooltip></CircleMarker>)}
      </MapContainer>
      <div className="map-controls"><button title="Refresh map" onClick={() => window.dispatchEvent(new Event("refresh-data"))}><RefreshCw size={15} /></button><button title="Map layers"><Layers3 size={15} /></button></div>
      <div className="map-legend"><span><i className="legend-dot agent-dot" />Agents</span><span><i className="legend-dot restaurant-dot" />Restaurants</span><span><i className="legend-dot order-dot" />Orders</span></div>
    </div>
  );
}

function MapAutoFit({ points, mapKey }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points, { padding: [28, 28], maxZoom: 15 });
    else if (points.length === 1) map.setView(points[0], 14);
  }, [map, mapKey]);
  return null;
}

function AnimatedRouteMarker({ route, routeKey }) {
  const [position, setPosition] = useState(route.geometry?.[0] || null);

  useEffect(() => {
    const points = route.geometry || [];
    if (points.length < 2) return undefined;

    const segmentLengths = points.slice(1).map(([latitude, longitude], index) => {
      const [previousLatitude, previousLongitude] = points[index];
      const radians = (degrees) => degrees * Math.PI / 180;
      const latitudeDelta = radians(latitude - previousLatitude);
      const longitudeDelta = radians(longitude - previousLongitude);
      const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(radians(previousLatitude)) * Math.cos(radians(latitude)) * Math.sin(longitudeDelta / 2) ** 2;
      return 2 * 6_371_000 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    });
    const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
    const durationMs = Math.max(20_000, Math.min(90_000, (route.estimated_driving_minutes || 30) * 1_000));
    let startedAt;
    let lastUpdatedAt = 0;
    let frameId;

    const animate = (timestamp) => {
      startedAt ??= timestamp;
      if (timestamp - lastUpdatedAt >= 80) {
        const progress = ((timestamp - startedAt) % durationMs) / durationMs;
        let distanceAlongRoute = progress * totalLength;
        let segmentIndex = 0;
        while (segmentIndex < segmentLengths.length - 1 && distanceAlongRoute > segmentLengths[segmentIndex]) {
          distanceAlongRoute -= segmentLengths[segmentIndex];
          segmentIndex += 1;
        }
        const segmentLength = segmentLengths[segmentIndex] || 1;
        const segmentProgress = Math.min(1, distanceAlongRoute / segmentLength);
        const [startLatitude, startLongitude] = points[segmentIndex];
        const [endLatitude, endLongitude] = points[segmentIndex + 1];
        setPosition([
          startLatitude + (endLatitude - startLatitude) * segmentProgress,
          startLongitude + (endLongitude - startLongitude) * segmentProgress,
        ]);
        lastUpdatedAt = timestamp;
      }
      frameId = requestAnimationFrame(animate);
    };

    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [routeKey]);

  if (!position) return null;
  return <Marker position={position} icon={divIcon({ className: "animated-rider-marker", html: "<span></span>", iconSize: [26, 26], iconAnchor: [13, 13] })}>
    <MapTooltip>Animated demo rider · route simulation, not live GPS</MapTooltip>
  </Marker>;
}

function App() {
  const [page, setPage] = useState(() => localStorage.getItem("dispatch-page") || "Rider app");
  const [overview, setOverview] = useState(null);
  const [orders, setOrders] = useState([]);
  const [restaurants, setRestaurants] = useState([]);
  const [agents, setAgents] = useState([]);
  const [result, setResult] = useState(null);
  const [strategy, setStrategy] = useState("balanced");
  const [loading, setLoading] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");

  useEffect(() => { localStorage.setItem("dispatch-page", page); }, [page]);

  async function loadData() {
    try {
      const [nextOverview, nextOrders, nextRestaurants, nextAgents] = await Promise.all([
        api("/overview"), api("/orders"), api("/restaurants"), api("/agents"),
      ]);
      setOverview(nextOverview);
      setOrders(nextOrders);
      setRestaurants(nextRestaurants);
      setAgents(nextAgents);
      setError("");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const timer = window.setInterval(loadData, 20_000);
    const refresh = () => loadData();
    window.addEventListener("refresh-data", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("refresh-data", refresh); };
  }, []);

  async function runOptimization() {
    setOptimizing(true);
    setError("");
    try {
      const nextResult = await api("/optimization/run", { method: "POST", body: JSON.stringify({ strategy }) });
      setResult(nextResult);
      setToast("Route proposal calculated");
      window.setTimeout(() => setToast(""), 2800);
    } catch (runError) {
      setError(runError.message);
    } finally {
      setOptimizing(false);
    }
  }

  async function applyRoute() {
    if (!result?.id) return;
    try {
      const response = await api(`/optimization/${result.id}/apply`, { method: "POST" });
      setToast(`${response.assignedOrders} orders assigned`);
      setResult(null);
      await loadData();
    } catch (applyError) { setError(applyError.message); }
    window.setTimeout(() => setToast(""), 2800);
  }

  async function updateStatus(order, status) {
    try {
      await api(`/orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadData();
    } catch (statusError) { setError(statusError.message); }
  }

  async function resetDemo() {
    if (!window.confirm("Reset all demo orders, routes and agent assignments?")) return;
    try {
      await api("/admin/reset-demo", { method: "POST" });
      setResult(null);
      await loadData();
      setToast("Demo data reset");
      window.setTimeout(() => setToast(""), 2800);
    } catch (resetError) { setError(resetError.message); }
  }

  const filteredOrders = useMemo(() => orders.filter((order) => `${order.id} ${order.customer_name} ${order.restaurant_name} ${order.status}`.toLowerCase().includes(query.toLowerCase())), [orders, query]);
  const inProgress = (overview?.counts?.assigned || 0) + (overview?.counts?.picked_up || 0);
  const chartData = [
    { day: "Mon", orders: 18 }, { day: "Tue", orders: 23 }, { day: "Wed", orders: 21 },
    { day: "Thu", orders: 30 }, { day: "Fri", orders: 27 }, { day: "Sat", orders: 36 }, { day: "Today", orders: overview?.counts ? Object.values(overview.counts).reduce((sum, count) => sum + count, 0) : 0 },
  ];

  const activeOrders = filteredOrders.filter((order) => !["delivered", "cancelled"].includes(order.status));
  const heading = page === "Live operations" ? "Live operations" : page;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Route size={19} /></div><div><strong>dispatch</strong><small>FLEET CONTROL</small></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>{navigation.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${page === label ? "selected" : ""}`} onClick={() => setPage(label)}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{label === "Orders" && <em>{overview?.counts?.pending || 0}</em>}</button>)}</nav>
        <div className="sidebar-bottom">
          <div className="system-status"><span className="status-pulse" /><div><strong>All systems operational</strong><small>API · database · routing</small></div></div>
          <button className="profile"><div className="avatar">AS</div><div><strong>Aditi Sharma</strong><small>Dispatcher</small></div><MoreHorizontal size={18} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Operations</span><span className="crumb-slash">/</span><strong>{heading}</strong></div>
          <div className="top-actions"><label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search orders, agents..." /><kbd>⌘ K</kbd></label><span className="live-indicator"><i /> LIVE</span><button className="icon-button" title="Notifications"><Bell size={17} /><b /></button><div className="top-avatar">AD</div></div>
        </header>

        <div className="content-wrap">
          {error && <div className="error-banner"><CircleHelp size={17} /><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
          {loading && <div className="loading-line"><span /> Connecting to operations API...</div>}

          {page === "Overview" && <>
            <section className="page-heading"><div><div className="eyebrow">TUESDAY, 24 NOVEMBER 2026 <span>·</span> GREATER NOIDA</div><h1>Namaste, Aditi</h1><p>Your delivery network at a glance.</p></div><button className="button secondary" onClick={loadData}><RefreshCw size={15} /> Refresh</button></section>
            <section className="metric-grid">
              <Metric label="Total orders" value={sumCounts(overview?.counts)} note="Across all statuses" icon={PackageCheck} />
              <Metric label="Available agents" value={overview?.activeAgents ?? "—"} note="Ready for assignment" icon={Bike} />
              <Metric label="In progress" value={inProgress} note="Assigned and picked up" icon={Truck} />
              <Metric label="Completed today" value={overview?.counts?.delivered ?? "—"} note="Delivered successfully" icon={Check} accent="green" />
              <Metric label="Revenue captured" value={money(overview?.revenue)} note="Completed orders only" icon={ArrowUpRight} />
            </section>
            <section className="overview-grid">
              <div className="panel map-panel"><PanelHeading title="Fleet map" subtitle="Greater Noida · live positions" trailing={<button className="text-action" onClick={() => setPage("Live operations")}>Full map <ArrowUpRight size={14} /></button>} /><MapPanel restaurants={restaurants} agents={agents} orders={activeOrders} result={result} /></div>
              <div className="panel trend-panel"><PanelHeading title="Order volume" subtitle="Last 7 days" trailing={<button className="icon-button small" title="Chart options"><MoreHorizontal size={17} /></button>} /><div className="chart-total"><strong>{sumCounts(overview?.counts)}</strong><span>orders in demo dataset</span></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 10, right: 4, left: -22, bottom: 0 }}><defs><linearGradient id="orderFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#178663" stopOpacity={0.19} /><stop offset="100%" stopColor="#178663" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#edf0eb" vertical={false} /><XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#929a94", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "#929a94", fontSize: 11 }} /><Tooltip contentStyle={{ border: "1px solid #e8ebe6", borderRadius: 8, fontSize: 12 }} /><Area type="monotone" dataKey="orders" stroke="#178663" strokeWidth={2.5} fill="url(#orderFill)" /></AreaChart></ResponsiveContainer></div><div className="simulated-note"><span /> Demo dataset · historical values are illustrative</div></div>
            </section>
            <section className="panel recent-panel"><PanelHeading title="Recent orders" subtitle="Latest activity across the fleet" trailing={<button className="text-action" onClick={() => setPage("Orders")}>View all <ArrowUpRight size={14} /></button>} /><OrderTable orders={filteredOrders.slice(0, 6)} onUpdate={updateStatus} compact /></section>
          </>}

          {page === "Live operations" && <>
            <section className="page-heading"><div><div className="eyebrow">FLEET MONITOR <span>·</span> {agents.length} AGENTS</div><h1>Live operations</h1><p>Current agent positions, open orders and restaurant locations.</p></div><button className="button secondary" onClick={loadData}><LocateFixed size={15} /> Recenter & refresh</button></section>
            <div className="live-layout"><div className="panel live-map-panel"><MapPanel large restaurants={restaurants} agents={agents} orders={activeOrders} result={result} /></div><aside className="panel live-side"><PanelHeading title="Fleet status" subtitle={`${agents.filter((agent) => agent.available).length} available`} /><div className="agent-list">{agents.map((agent) => <div className="agent-row" key={agent.id}><div className={`agent-avatar ${agent.available ? "online" : "busy"}`}>{agent.name.slice(0, 1)}</div><div className="agent-copy"><strong>{agent.name}</strong><small>{agent.active_orders} active orders · {agent.id}</small></div><span className={`tiny-status ${agent.available ? "good" : "warn"}`}>{agent.available ? "Available" : "Busy"}</span></div>)}</div><div className="live-key"><span><i className="legend-dot agent-dot" />Delivery agents</span><span><i className="legend-dot restaurant-dot" />Restaurants</span><span><i className="legend-dot order-dot" />Open orders</span></div></aside></div>
          </>}

          {page === "Orders" && <>
            <section className="page-heading"><div><div className="eyebrow">ORDER MANAGEMENT <span>·</span> {orders.length} RECORDS</div><h1>Orders</h1><p>Track order progress and update operational status.</p></div><button className="button secondary" onClick={loadData}><RefreshCw size={15} /> Refresh</button></section>
            <div className="panel orders-panel"><div className="table-toolbar"><div className="filter-tabs"><button className="active">All orders <b>{orders.length}</b></button><button onClick={() => setQuery("pending")}>Pending</button><button onClick={() => setQuery("picked_up")}>On route</button><button onClick={() => setQuery("delivered")}>Delivered</button></div><button className="button secondary small-button"><SlidersHorizontal size={15} /> Filters</button></div><OrderTable orders={filteredOrders} onUpdate={updateStatus} /></div>
          </>}

          {page === "Restaurants" && <><section className="page-heading"><div><div className="eyebrow">MERCHANT NETWORK</div><h1>Restaurants</h1><p>Five demo kitchens serving Knowledge Park and nearby areas.</p></div></section><div className="entity-grid">{restaurants.map((restaurant, index) => <div className="panel entity-card" key={restaurant.id}><div className="entity-top"><div className="entity-icon"><Utensils size={19} /></div><span className="tiny-status good">Accepting orders</span></div><h3>{restaurant.name}</h3><p>{restaurant.cuisine}</p><div className="entity-meta"><span><MapPinned size={14} /> {restaurant.latitude.toFixed(3)}, {restaurant.longitude.toFixed(3)}</span><span><PackageOpen size={14} /> {orders.filter((order) => order.restaurant_id === restaurant.id).length} orders</span></div></div>)}</div></>}

          {page === "Delivery agents" && <><section className="page-heading"><div><div className="eyebrow">COURIER NETWORK <span>·</span> {agents.length} PROFILES</div><h1>Delivery agents</h1><p>Availability and current workload across the service area.</p></div></section><div className="panel orders-panel"><div className="agent-table-head"><span>AGENT</span><span>AVAILABILITY</span><span>ACTIVE ORDERS</span><span>CAPACITY</span><span>LAST POSITION</span></div>{agents.map((agent) => <div className="agent-table-row" key={agent.id}><div className="agent-name-cell"><div className={`agent-avatar ${agent.available ? "online" : "busy"}`}>{agent.name.slice(0, 1)}</div><div><strong>{agent.name}</strong><small>{agent.id}</small></div></div><span className={`tiny-status ${agent.available ? "good" : "warn"}`}>{agent.available ? "Available" : "Unavailable"}</span><span>{agent.active_orders}</span><span>{agent.capacity} packages</span><span className="coordinates">{agent.latitude.toFixed(4)}, {agent.longitude.toFixed(4)}</span></div>)}</div></>}

          {page === "Rider app" && <RiderWorkspace agents={agents} restaurants={restaurants} orders={orders} onRefresh={loadData} onStatusUpdate={updateStatus} setError={setError} setToast={setToast} />}

          {page === "Route optimization" && <>
            <section className="page-heading"><div><div className="eyebrow">OR-TOOLS ROUTE SOLVER <span>·</span> {overview?.counts?.pending || 0} PENDING</div><h1>Route optimization</h1><p>Generate a pickup-and-delivery proposal with capacity and time-window constraints.</p></div></section>
            <section className="optimization-toolbar panel"><div className="strategy-control"><label htmlFor="strategy">OBJECTIVE STRATEGY</label><div className="select-wrap"><Settings2 size={16} /><select id="strategy" value={strategy} onChange={(event) => setStrategy(event.target.value)}><option value="balanced">Balanced recommendation</option><option value="distance">Minimum distance</option><option value="time">Minimum delivery time</option><option value="profit">Estimated profit</option></select><ChevronDown size={15} /></div></div><div className="optimization-context"><span><PackageOpen size={15} /> {overview?.counts?.pending || 0} pending orders</span><span><Bike size={15} /> {agents.filter((agent) => agent.available).length} available agents</span><span><Store size={15} /> {restaurants.length} restaurants</span></div><button className="button primary" onClick={runOptimization} disabled={optimizing || !overview?.counts?.pending}>{optimizing ? <><span className="spinner" /> Solving routes...</> : <><Route size={16} /> Optimize routes</>}</button></section>
            {result ? <>
              <section className="result-banner"><div className="result-check"><Check size={18} /></div><div><strong>Proposal ready</strong><span>{titleCase(result.strategy)} · {result.routing_source.startsWith("simulated-") ? "simulated distance fallback" : "OSRM road matrix"}</span></div><button className="button secondary" onClick={runOptimization} disabled={optimizing}><RefreshCw size={14} /> Recalculate</button><button className="button primary" onClick={applyRoute}><Check size={15} /> Apply proposal</button></section>
              <section className="result-metrics"><ResultMetric label="Orders assigned" value={`${result.totals.orders} / ${result.totals.orders + result.unassigned_order_ids.length}`} /><ResultMetric label="Total distance" value={`${result.totals.distance_km} km`} /><ResultMetric label="Driving time" value={`${result.totals.driving_minutes} min`} /><ResultMetric label="Est. net profit" value={money(result.totals.estimated_profit)} /><ResultMetric label="Workload deviation" value={`${result.totals.workload_std_dev} pts`} /></section>
              {result.unassigned_order_ids.length > 0 && <div className="warning-banner">{result.unassigned_order_ids.length} orders could not be assigned: {result.unassigned_order_ids.join(", ")}</div>}
              <div className="optimization-result-layout"><div className="panel result-map"><PanelHeading title="Proposed routes" subtitle="Dotted paths indicate simulated fallback, not road geometry" /><MapPanel large restaurants={restaurants} agents={agents} orders={activeOrders} result={result} /></div><div className="route-list">{result.routes.map((route, index) => <div className="panel route-card" key={route.agent_id}><div className="route-card-head"><div className={`route-color color-${index % 5}`} /><div><strong>{agents.find((agent) => agent.id === route.agent_id)?.name || route.agent_id}</strong><small>{route.order_ids.length} orders · {route.total_stops} stops</small></div><button className="icon-button small" title="Route details"><MoreHorizontal size={17} /></button></div><div className="route-stats"><span><Route size={14} /> {route.total_distance_km} km</span><span><Clock3 size={14} /> {route.estimated_driving_minutes} min</span><span><Gauge size={14} /> {route.workload_points} pts</span></div><div className="route-sequence">{route.stops.map((stop) => <div key={`${route.agent_id}-${stop.sequence}`} className="stop-row"><span className={`stop-number ${stop.type}`}>{stop.sequence}</span><div><strong>{stop.type === "pickup" ? restaurants.find((item) => item.id === orders.find((order) => order.id === stop.order_id)?.restaurant_id)?.name || "Restaurant pickup" : `Customer · ${stop.order_id}`}</strong><small>{titleCase(stop.type)} · {stop.estimated_arrival_minutes} min</small></div></div>)}</div></div>)}</div></div>
            </> : <div className="optimization-empty panel"><div className="empty-illustration"><Route size={30} /></div><h2>Ready to plan the fleet</h2><p>Choose an objective and run the OR-Tools solver against pending demo orders. Your proposal stays separate until applied.</p><button className="button primary" onClick={runOptimization} disabled={optimizing || !overview?.counts?.pending}>{optimizing ? "Solving..." : "Run optimization"}</button></div>}
          </>}

          {page === "Analytics" && <><section className="page-heading"><div><div className="eyebrow">OPERATIONS INTELLIGENCE</div><h1>Analytics</h1><p>Metrics from the persistent demo database. Simulated records are labeled.</p></div><button className="button secondary" onClick={() => window.print()}><Download size={15} /> Export report</button></section><section className="metric-grid analytics-metrics"><Metric label="Completed orders" value={overview?.counts?.delivered || 0} note="Persisted order records" icon={PackageCheck} accent="green" /><Metric label="Revenue captured" value={money(overview?.revenue)} note="Delivered order revenue" icon={ArrowUpRight} /><Metric label="In progress" value={inProgress} note="Active delivery states" icon={Truck} /><Metric label="Fleet availability" value={`${agents.filter((agent) => agent.available).length} / ${agents.length}`} note="Available right now" icon={Bike} /></section><section className="panel analytics-chart"><PanelHeading title="Orders by day" subtitle="Illustrative demo trend; live totals come from SQLite" /><div className="chart-wrap large-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 14, right: 18, left: -18, bottom: 0 }}><defs><linearGradient id="analyticsFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#178663" stopOpacity={0.22} /><stop offset="100%" stopColor="#178663" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="#edf0eb" vertical={false} /><XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#929a94", fontSize: 12 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "#929a94", fontSize: 12 }} /><Tooltip /><Area type="monotone" dataKey="orders" stroke="#178663" strokeWidth={2.5} fill="url(#analyticsFill)" /></AreaChart></ResponsiveContainer></div></section><section className="panel recent-panel"><PanelHeading title="Order status mix" subtitle="Current database counts" />{Object.entries(overview?.counts || {}).map(([status, count]) => <div className="distribution-row" key={status}><span>{titleCase(status)}</span><div className="distribution-track"><i style={{ width: `${Math.max(3, count / Math.max(1, orders.length) * 100)}%` }} /></div><strong>{count}</strong></div>)}</section></>}

          {page === "Settings" && <><section className="page-heading"><div><div className="eyebrow">WORKSPACE CONFIGURATION</div><h1>Settings</h1><p>Demo environment, data source and operational controls.</p></div></section><div className="panel settings-panel"><div className="settings-row"><div className="settings-icon"><ShieldCheck size={18} /></div><div><strong>Demo environment</strong><p>Greater Noida seed data · SQLite persistent database · OSRM optional</p></div><span className="tiny-status good">Connected</span></div><div className="settings-row"><div className="settings-icon"><Compass size={18} /></div><div><strong>Routing provider</strong><p>Configure OSRM with the <code>OSRM_BASE_URL</code> environment variable. Fallback routes are labeled simulated.</p></div><span className="tiny-status warn">Fallback enabled</span></div><div className="settings-row"><div className="settings-icon"><RefreshCw size={18} /></div><div><strong>Reset demonstration data</strong><p>Restore seeded restaurants, agents and 30 sample orders.</p></div><button className="button danger" onClick={resetDemo}>Reset demo</button></div></div></>}
        </div>
      </main>
      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </div>
  );
}

function sumCounts(counts) { return counts ? Object.values(counts).reduce((sum, count) => sum + count, 0) : "—"; }
function Metric({ label, value, note, icon: Icon, accent }) { return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={16} /></div><strong className={accent || ""}>{value}</strong><small>{note}</small></div>; }
function PanelHeading({ title, subtitle, trailing }) { return <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{trailing}</div>; }
function ResultMetric({ label, value }) { return <div className="result-metric"><span>{label}</span><strong>{value}</strong></div>; }
function RiderStat({ icon: Icon, label, value, note }) { return <article className="rider-stat"><div><span>{label}</span><Icon size={15} /></div><strong>{value}</strong><small>{note}</small></article>; }
function RoadDirections({ directions, stops }) {
  const groupedSteps = new Map();
  directions.forEach((step) => {
    const legIndex = step.leg_index ?? 0;
    groupedSteps.set(legIndex, [...(groupedSteps.get(legIndex) || []), step]);
  });
  return <details className="road-directions" open>
    <summary><Navigation size={15} /><strong>Turn-by-turn directions</strong><span>{directions.length} road steps · OSRM</span></summary>
    <div className="road-direction-legs">{[...groupedSteps.entries()].map(([legIndex, steps]) => {
      const stop = stops[legIndex];
      const destination = stop ? `${stop.type === "pickup" ? "To pickup" : "To customer"} · stop ${stop.sequence}` : "Return to rider start";
      return <section key={legIndex}><h3>{destination}</h3><ol>{steps.map((step, index) => <li key={`${legIndex}-${index}`}><span>{step.instruction}</span><small>{step.distance_m >= 1000 ? `${(step.distance_m / 1000).toFixed(1)} km` : `${step.distance_m} m`} · {Math.max(1, Math.round(step.duration_s / 60))} min</small></li>)}</ol></section>;
    })}</div>
  </details>;
}

function OrderTable({ orders, onUpdate, compact = false }) {
  const nextStatus = { pending: "preparing", preparing: "ready", ready: "assigned", assigned: "picked_up", picked_up: "delivered" };
  if (!orders.length) return <div className="empty-table">No orders match this search.</div>;
  return <div className="table-scroll"><table><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>RESTAURANT</th><th>STATUS</th><th>PRIORITY</th><th>AMOUNT</th><th>{compact ? "" : "ACTION"}</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><strong className="order-id">{order.id}</strong></td><td><span className="customer-cell">{order.customer_name}</span></td><td>{order.restaurant_name}</td><td><span className={`status-pill status-${order.status}`}>{titleCase(order.status)}</span></td><td><span className={`priority priority-${order.priority >= 4 ? "high" : order.priority >= 3 ? "medium" : "normal"}`}><i /> {order.priority >= 4 ? "Urgent" : order.priority >= 3 ? "Priority" : "Standard"}</span></td><td>{money(order.revenue)}</td><td>{nextStatus[order.status] ? <button className="row-action" title={`Mark ${titleCase(nextStatus[order.status])}`} onClick={() => onUpdate(order, nextStatus[order.status])}><Check size={15} /> <span>{titleCase(nextStatus[order.status])}</span></button> : <span className="muted-dash">—</span>}</td></tr>)}</tbody></table></div>;
}

function RiderWorkspace({ agents, restaurants, orders, onRefresh, onStatusUpdate, setError, setToast }) {
  const [riderId, setRiderId] = useState(() => localStorage.getItem("demo-rider-id") || "");
  const [riderDashboard, setRiderDashboard] = useState(null);
  const [offerData, setOfferData] = useState({ offers: [] });
  const [activeRoute, setActiveRoute] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [preview, setPreview] = useState(null);
  const [working, setWorking] = useState(false);
  const [deliveryToConfirm, setDeliveryToConfirm] = useState(null);
  const [routeOrderStatuses, setRouteOrderStatuses] = useState({});

  useEffect(() => {
    if (!riderId && agents.length) setRiderId(agents.find((agent) => agent.available)?.id || agents[0].id);
  }, [agents, riderId]);
  useEffect(() => { if (riderId) localStorage.setItem("demo-rider-id", riderId); }, [riderId]);

  async function reloadRider() {
    if (!riderId) return;
    try {
      const [nextOffers, nextRoute, nextDashboard] = await Promise.all([
        api(`/rider/${riderId}/available-orders`), api(`/rider/${riderId}/route`),
        api(`/rider/${riderId}/dashboard`),
      ]);
      setOfferData(nextOffers);
      setActiveRoute(nextRoute.routeResult ? nextRoute : null);
      setRiderDashboard(nextDashboard);
      setSelectedIds((current) => current.filter((id) => nextOffers.offers.some((offer) => offer.id === id)));
      setPreview(null);
      setError("");
    } catch (requestError) { setError(requestError.message); }
  }

  useEffect(() => { reloadRider(); }, [riderId, orders]);

  const rider = agents.find((agent) => agent.id === riderId);
  const selectedOffers = offerData.offers.filter((offer) => selectedIds.includes(offer.id));
  const activeOrders = activeRoute?.orders || [];
  const routeResult = activeRoute?.routeResult || preview?.routeResult || null;
  const route = routeResult?.routes?.[0];
  const routeStops = route?.stops || [];
  const stopStatus = (stop) => {
    const order = activeRoute?.orders.find((item) => item.id === stop.order_id) || orders.find((item) => item.id === stop.order_id);
    return routeOrderStatuses[stop.order_id] || order?.status;
  };
  const nextPickup = routeStops.find((stop) => stop.type === "pickup" && stopStatus(stop) === "assigned");
  const nextStop = nextPickup || (routeResult?.phase === "delivery"
    ? routeStops.find((stop) => stop.type === "delivery" && stopStatus(stop) === "picked_up")
    : null);

  function toggleOrder(orderId) {
    setPreview(null);
    setSelectedIds((current) => current.includes(orderId)
      ? current.filter((id) => id !== orderId)
      : current.length < 4 ? [...current, orderId] : current);
  }

  async function previewRoute() {
    setWorking(true);
    try {
      const nextPreview = await api(`/rider/${riderId}/preview`, { method: "POST", body: JSON.stringify({ orderIds: selectedIds }) });
      setPreview(nextPreview);
      setToast("Route and estimated rider payout ready");
      window.setTimeout(() => setToast(""), 2800);
    } catch (previewError) { setError(previewError.message); }
    finally { setWorking(false); }
  }

  async function toggleShift() {
    if (!riderDashboard || riderDashboard.stats.activeDeliveries > 0) return;
    setWorking(true);
    try {
      await api(`/rider/${riderId}/availability`, {
        method: "POST",
        body: JSON.stringify({ online: !riderDashboard.rider.available }),
      });
      await onRefresh();
      await reloadRider();
    } catch (shiftError) { setError(shiftError.message); }
    finally { setWorking(false); }
  }

  async function acceptOffer() {
    if (!preview) return;
    setWorking(true);
    try {
      await api(`/rider/offers/${preview.id}/accept`, { method: "POST", body: "{}" });
      await onRefresh();
      await reloadRider();
      setToast("Orders accepted. Your route is ready.");
      window.setTimeout(() => setToast(""), 2800);
    } catch (acceptError) { setError(acceptError.message); }
    finally { setWorking(false); }
  }

  async function updateDelivery(order, status) {
    setWorking(true);
    try {
      const updatedOrder = await api(`/orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await onRefresh();
      await reloadRider();
      setRouteOrderStatuses((current) => ({ ...current, [order.id]: updatedOrder.status }));
      setToast(updatedOrder.riderRouteReplanned
        ? "All pickups confirmed. Route reordered from your last restaurant to the nearest customer."
        : "Pickup confirmed. Continue to the next restaurant pickup.");
      window.setTimeout(() => setToast(""), 2800);
    } catch (statusError) { setError(statusError.message); }
    finally { setWorking(false); }
  }

  async function confirmDelivery() {
    if (!deliveryToConfirm) return;
    setWorking(true);
    try {
      const confirmation = await api(`/rider/${riderId}/orders/${deliveryToConfirm.id}/confirm-delivery`, { method: "POST", body: "{}" });
      await onRefresh();
      await reloadRider();
      setRouteOrderStatuses((current) => ({ ...current, [deliveryToConfirm.id]: "delivered" }));
      setDeliveryToConfirm(null);
      setToast(confirmation.routeCompleted ? "All deliveries confirmed. Trip complete." : "Delivery confirmed. Remaining stops stay on your route.");
      window.setTimeout(() => setToast(""), 3000);
    } catch (confirmationError) { setError(confirmationError.message); }
    finally { setWorking(false); }
  }

  const remainingNavigationStops = routeStops.filter((stop) => stopStatus(stop) !== "delivered");
  const routeOrigin = route?.start_location || rider;
  const directionUrl = route && routeOrigin && remainingNavigationStops.length
    ? `https://www.google.com/maps/dir/?api=1&origin=${routeOrigin.latitude},${routeOrigin.longitude}&destination=${remainingNavigationStops.at(-1).location.latitude},${remainingNavigationStops.at(-1).location.longitude}&waypoints=${remainingNavigationStops.slice(0, -1).map((stop) => `${stop.location.latitude},${stop.location.longitude}`).join("%7C")}&travelmode=driving`
    : "#";

  return <>
    <section className="page-heading rider-heading"><div><div className="eyebrow">RIDER MODE <span>·</span> GREATER NOIDA</div><h1>Namaste{riderDashboard?.rider.name || rider?.name ? `, ${riderDashboard?.rider.name || rider.name}` : ""}</h1><p>Your shift, earnings, and deliveries at a glance.</p></div><div className="rider-profile-actions"><label className="rider-picker"><span>RIDER PROFILE</span><select value={riderId} onChange={(event) => { const nextRiderId = event.target.value; if (nextRiderId === riderId) return; setRiderId(nextRiderId); setRiderDashboard(null); setPreview(null); setSelectedIds([]); setRouteOrderStatuses({}); setDeliveryToConfirm(null); }}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.available ? "Online" : agent.active_orders > 0 ? "On delivery" : "Offline"}</option>)}</select></label><button className={`shift-toggle ${riderDashboard?.rider.available ? "shift-online" : "shift-offline"}`} onClick={toggleShift} disabled={working || (riderDashboard?.stats.activeDeliveries || 0) > 0}><span /><div><strong>{riderDashboard?.stats.activeDeliveries ? "On delivery" : riderDashboard?.rider.available ? "Online · Go offline" : "Offline · Go online"}</strong><small>{riderDashboard?.stats.activeDeliveries ? `${riderDashboard.stats.activeDeliveries} active orders` : "Your work hours are tracked per rider"}</small></div></button></div></section>

    {riderDashboard && <section className="rider-profile-stats"><RiderStat icon={Clock3} label="Working hours" value={`${Math.floor(riderDashboard.stats.workingMinutes / 60)}h ${riderDashboard.stats.workingMinutes % 60}m`} note={`${riderDashboard.stats.todayDeliveries} deliveries today`} /><RiderStat icon={IndianRupee} label="Earned" value={money(riderDashboard.stats.totalNetEarnings)} note={`${money(riderDashboard.stats.todayNetEarnings)} today · after fuel`} /><RiderStat icon={PackageCheck} label="Completed deliveries" value={riderDashboard.stats.completedDeliveries} note={`${riderDashboard.stats.activeDeliveries} currently active`} /><RiderStat icon={Route} label="Distance travelled" value={`${riderDashboard.stats.totalRouteKm} km`} note={`Fuel recorded ${money(riderDashboard.stats.totalFuelCost)}`} /><RiderStat icon={WalletCards} label="On this trip" value={money(riderDashboard.stats.pendingNetEarnings)} note={`${activeRoute?.orders.length || 0} assigned · pending confirmation`} /></section>}

    {!activeRoute && !preview && <section className="panel rider-overview-map"><PanelHeading title="Nearby orders and kitchens" subtitle="Select an order to preview its optimized route" /><MapPanel large restaurants={restaurants} agents={rider ? [rider] : []} orders={offerData.offers} result={null} /></section>}
    {preview && <section className="rider-calculation-strip"><span><small>PAY DISTANCE</small><strong>{preview.earnings.billableDistanceKm} km</strong></span><span><small>FULL TRIP + RETURN</small><strong>{preview.earnings.routeDistanceKm} km</strong></span><span><small>ROUTE TIME INCL. PREP</small><strong>{preview.earnings.estimatedCompletionMinutes} min</strong></span><span><small>EST. NET / HOUR</small><strong>{money(preview.earnings.estimatedNetPerHour)}</strong></span></section>}
    {route && (route.directions?.length
      ? <RoadDirections directions={route.directions} stops={route.stops} />
      : <section className="route-guidance-fallback"><MapPinned size={16} /><span>Turn-by-turn road steps are unavailable for this simulated route.</span><a href={directionUrl} target="_blank" rel="noreferrer"><Navigation size={14} /> Open in Maps</a></section>)}
    {activeRoute ? <>
      <section className="rider-active-summary"><div className="active-route-title"><span className="active-route-icon"><Navigation size={18} /></span><div><strong>Your accepted trip</strong><small>{activeOrders.length} order{activeOrders.length === 1 ? "" : "s"} · follow the stops in order</small></div></div><div className="rider-money"><span>EST. TAKE-HOME</span><strong>{money(activeRoute.earnings.estimatedNet)}</strong></div><a className="button primary" href={directionUrl} target="_blank" rel="noreferrer"><Navigation size={15} /> Open in Maps</a></section>
      <div className="rider-route-layout"><section className="panel rider-map-panel"><PanelHeading title="Your route" subtitle={routeResult.routing_source.startsWith("simulated-") ? "Simulated road-distance fallback · map path is approximate" : "Road route from OSRM · animated demo rider"} /><MapPanel large restaurants={restaurants} agents={rider ? [rider] : []} orders={activeOrders} result={routeResult} animateRoute animationKey={`${activeRoute.routeId}-${route?.order_ids.join("-")}`} /></section><section className="panel rider-stops-panel"><PanelHeading title="Pickup and delivery sequence" subtitle="Only your confirmed pickup/delivery advances the route" /><div className="rider-stop-list">{routeStops.map((stop) => {
        const order = orders.find((item) => item.id === stop.order_id);
        const isPickup = stop.type === "pickup";
        const isNextStop = nextStop?.sequence === stop.sequence;
        const status = routeOrderStatuses[stop.order_id] || order?.status;
        const canUpdate = isNextStop && (isPickup ? status === "assigned" : status === "picked_up");
        const nextStatus = isPickup ? "picked_up" : "delivered";
        const place = isPickup ? order?.restaurant_name || "Restaurant pickup" : `Customer · ${order?.customer_name || stop.order_id}`;
        return <div className={`rider-stop ${isPickup ? "pickup-stop" : "drop-stop"} ${isNextStop ? "next-rider-stop" : ""}`} key={`${stop.order_id}-${stop.type}`}><span className="rider-stop-index">{stop.sequence}</span><div className="rider-stop-copy"><span className="rider-stop-type">{isPickup ? "PICK UP" : "DELIVER TO"} · {stop.estimated_arrival_minutes} MIN</span><strong>{place}</strong><small>{stop.order_id}{status ? ` · ${titleCase(status)}` : " · Completed"}</small>{canUpdate && <button className="button secondary stop-confirm" disabled={working} onClick={() => isPickup ? updateDelivery(order, nextStatus) : setDeliveryToConfirm(order)}><Check size={14} /> {isPickup ? "Confirm pickup" : "Confirm delivered"}</button>}</div></div>;
      })}</div><div className="rider-route-foot"><span><Route size={14} /> {route?.total_distance_km} km</span><span><Clock3 size={14} /> about {route?.estimated_driving_minutes} min</span><span><Fuel size={14} /> fuel est. {money(activeRoute.earnings.estimatedFuelCost)}</span></div></section></div>
    </> : <>
      <section className="rider-intro-strip"><div><strong>Pick one order or build a bundle</strong><span>Compare solo estimates, select up to 4, then preview the optimized pickup/drop sequence before you accept.</span></div><span className="rider-capacity"><PackageOpen size={15} /> {rider?.capacity || 0} packages at a time</span></section>
      <div className="rider-offers-layout"><section className="rider-order-feed"><div className="rider-feed-head"><div><h2>Available deliveries</h2><p>{offerData.offers.length} orders · sorted by estimated solo take-home</p></div><button className="icon-button" title="Refresh orders" onClick={reloadRider}><RefreshCw size={15} /></button></div>
        {offerData.offers.length ? offerData.offers.map((offer, index) => <label className={`rider-order-card ${selectedIds.includes(offer.id) ? "chosen" : ""}`} key={offer.id}><input type="checkbox" checked={selectedIds.includes(offer.id)} onChange={() => toggleOrder(offer.id)} disabled={!rider?.available || (!selectedIds.includes(offer.id) && selectedIds.length >= 4)} /><div className="rider-order-main"><div className="rider-order-title"><strong>{offer.restaurant_name}</strong>{index === 0 && <span className="best-pick-tag">BEST SOLO EST.</span>}</div><span className="rider-order-destination"><MapPinned size={13} /> Drop near {offer.customer_latitude.toFixed(3)}, {offer.customer_longitude.toFixed(3)}</span><div className="rider-order-meta"><span><PackageOpen size={13} /> {offer.quantity} package{offer.quantity > 1 ? "s" : ""}</span><span><Clock3 size={13} /> Prep {offer.preparation_minutes} min</span><span className={`priority priority-${offer.priority >= 4 ? "high" : "normal"}`}><i /> {offer.priority >= 4 ? "Urgent" : "Standard"}</span></div></div><div className="rider-estimate"><strong>{money(offer.estimatedNet)}</strong><span>est. solo net</span><small>{offer.estimatedDistanceKm} km · simulated</small></div></label>) : <div className="rider-empty"><PackageCheck size={24} /><strong>No open deliveries right now</strong><span>Pull to refresh when new orders are available.</span></div>}
        <div className="rider-feed-note"><CircleHelp size={14} /> Solo amounts are estimates. Bundle payout and route distance are recalculated by the optimizer before acceptance.</div>
      </section>
      <section className="rider-preview-column">{preview ? <div className="panel rider-preview-panel"><PanelHeading title="Trip preview" subtitle={`${preview.orderIds.length} selected · not accepted yet`} trailing={<button className="icon-button" title="Clear preview" onClick={() => setPreview(null)}><X size={15} /></button>} /><div className="earnings-hero"><div><span>ESTIMATED TAKE-HOME</span><strong>{money(preview.earnings.estimatedNet)}</strong></div><span className="earnings-positive"><ArrowUpRight size={15} /> after fuel</span></div><div className="earnings-breakdown"><span>Delivery payout <strong>{money(preview.earnings.grossPayout)}</strong></span><span>Fuel estimate <strong>− {money(preview.earnings.estimatedFuelCost)}</strong></span></div><div className="earnings-assumption">{preview.earnings.label}. Formula: base + distance + drops + priority bonus, less estimated fuel.</div><div className="preview-route-facts"><span><Route size={14} /> {route?.total_distance_km} km</span><span><Clock3 size={14} /> {route?.estimated_driving_minutes} min</span><span><Store size={14} /> {new Set(routeStops.filter((stop) => stop.type === "pickup").map((stop) => stop.order_id)).size} pickup stops</span></div><div className="mini-route-map"><MapPanel restaurants={restaurants} agents={rider ? [rider] : []} orders={selectedOffers} result={preview.routeResult} /></div><div className="preview-stop-list">{routeStops.map((stop) => <div key={`${stop.order_id}-${stop.type}`}><span className={stop.type}>{stop.sequence}</span><strong>{stop.type === "pickup" ? selectedOffers.find((offer) => offer.id === stop.order_id)?.restaurant_name : `Customer · ${selectedOffers.find((offer) => offer.id === stop.order_id)?.customer_name}`}</strong><small>{stop.type === "pickup" ? "Pick up" : "Drop off"} · {stop.estimated_arrival_minutes} min</small></div>)}</div><button className="button primary accept-trip-button" onClick={acceptOffer} disabled={working || !rider?.available}><Check size={15} /> {working ? "Please wait..." : `Accept ${preview.orderIds.length} order${preview.orderIds.length === 1 ? "" : "s"}`}</button></div> : <div className="panel rider-preview-empty"><div className="rider-empty-map"><MapPinned size={22} /></div><h2>Your route, your call</h2><p>Select one delivery or combine nearby orders. We’ll calculate the pickup sequence, drop route and estimated take-home before you commit.</p><div className="preview-steps"><span><i>1</i> Choose order(s)</span><span><i>2</i> Preview route & pay</span><span><i>3</i> Accept when ready</span></div><button className="button primary preview-route-button" onClick={previewRoute} disabled={!selectedIds.length || working || !rider?.available}>{working ? <><span className="spinner" /> Calculating route...</> : <><Route size={15} /> Preview route & earnings</>}</button><small className="payout-disclaimer">Estimates use simulated road distance unless OSRM is configured.</small></div>}
      </section></div>
    </>}
    {deliveryToConfirm && <div className="delivery-confirm-overlay" role="presentation"><section className="delivery-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-confirm-title"><span className="confirm-dialog-icon"><PackageCheck size={20} /></span><button className="icon-button confirm-dialog-close" aria-label="Cancel delivery confirmation" onClick={() => setDeliveryToConfirm(null)}><X size={16} /></button><h2 id="delivery-confirm-title">Confirm this delivery?</h2><p>Mark <strong>{deliveryToConfirm.id}</strong> for <strong>{deliveryToConfirm.customer_name}</strong> as delivered? This only completes this order. The rest of your route will stay active.</p><div className="confirm-dialog-actions"><button className="button secondary" onClick={() => setDeliveryToConfirm(null)} disabled={working}>Not yet</button><button className="button primary" onClick={confirmDelivery} disabled={working}><Check size={15} /> {working ? "Updating..." : "Yes, delivered"}</button></div></section></div>}
  </>;
}

export default App;