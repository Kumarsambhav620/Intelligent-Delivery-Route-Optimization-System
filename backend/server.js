import express from "express";
import dotenv from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

dotenv.config({ path: resolve(import.meta.dirname, "../.env") });

const app = express();
const port = Number(process.env.API_PORT || 4000);
const databasePath = resolve(process.env.DATABASE_PATH || "data/delivery.sqlite");
const optimizerUrl = process.env.OPTIMIZER_URL || "http://127.0.0.1:8000";
const riderPayout = {
  base: Number(process.env.RIDER_BASE_FARE || 24),
  perKm: Number(process.env.RIDER_PAY_PER_BILLABLE_KM || 8),
  perDrop: Number(process.env.RIDER_DROP_BONUS || 12),
  priorityBonus: Number(process.env.RIDER_PRIORITY_BONUS || 8),
  fuelPerKm: Number(process.env.RIDER_FUEL_COST_PER_KM || 2.5),
};

mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cuisine TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, capacity INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS rider_work_sessions (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    completed_work_minutes INTEGER NOT NULL DEFAULT 0,
    session_started_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
    customer_latitude REAL NOT NULL, customer_longitude REAL NOT NULL,
    quantity INTEGER NOT NULL, revenue REAL NOT NULL, priority INTEGER NOT NULL,
    preparation_minutes INTEGER NOT NULL, window_end_minutes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','preparing','ready','assigned','picked_up','delivered','cancelled')),
    assigned_agent_id TEXT REFERENCES agents(id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS optimization_runs (
    id TEXT PRIMARY KEY, strategy TEXT NOT NULL, routing_source TEXT NOT NULL,
    result_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rider_offers (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), order_ids_json TEXT NOT NULL,
    route_json TEXT NOT NULL, earnings_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','expired')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rider_routes (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), offer_id TEXT NOT NULL REFERENCES rider_offers(id),
    route_json TEXT NOT NULL, earnings_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rider_earnings (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
    gross_payout REAL NOT NULL, fuel_cost REAL NOT NULL, net_earnings REAL NOT NULL,
    route_km REAL NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','earned')),
    created_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS demo_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
  CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(assigned_agent_id);
`);

const restaurants = [
  ["rest-1", "Pari Chowk Tandoor", "North Indian", 28.4744, 77.5040],
  ["rest-2", "Alpha Spice Kitchen", "North Indian", 28.4637, 77.5092],
  ["rest-3", "Knowledge Park Dhaba", "Punjabi", 28.4721, 77.5151],
  ["rest-4", "Beta Chaat Corner", "Street food", 28.4812, 77.4984],
  ["rest-5", "Ghar Ka Zaika", "Home-style", 28.4568, 77.5011],
];

const agentPoints = [
  [28.4760, 77.5020], [28.4684, 77.5120], [28.4815, 77.4963], [28.4592, 77.5068],
  [28.4706, 77.4974], [28.4850, 77.5088], [28.4524, 77.4990], [28.4778, 77.5160],
  [28.4641, 77.4934], [28.4882, 77.5013],
];

function seedDemoData() {
  const insertRestaurant = db.prepare("INSERT INTO restaurants VALUES (?, ?, ?, ?, ?)");
  const insertAgent = db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertWorkSession = db.prepare("INSERT INTO rider_work_sessions VALUES (?, ?, ?)");
  const insertOrder = db.prepare(`INSERT INTO orders
    (id, customer_name, restaurant_id, customer_latitude, customer_longitude, quantity,
     revenue, priority, preparation_minutes, window_end_minutes, status, assigned_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEarning = db.prepare("INSERT INTO rider_earnings VALUES (?, ?, ?, ?, ?, ?, ?, 'earned', ?, ?)");
  restaurants.forEach((row) => insertRestaurant.run(...row));
  const completedWorkMinutes = [3920, 4680, 3210, 5360, 2970, 4410, 5890, 3540, 6520, 4830];
  const activeShiftMinutes = [42, 87, 24, 115, 58, 103, 37, 76, 128, 64];
  agentPoints.forEach(([latitude, longitude], index) => {
    insertAgent.run(`agent-${index + 1}`, ["Aarav", "Meera", "Kabir", "Sana", "Ishaan", "Diya", "Vihaan", "Anaya", "Reyansh", "Tara"][index], `+91 98${String(10000000 + index * 1379).slice(0, 8)}`, latitude, longitude, index % 3 === 0 ? 2 : 3, index < 8 ? 1 : 0);
    insertWorkSession.run(`agent-${index + 1}`, completedWorkMinutes[index], new Date(Date.now() - activeShiftMinutes[index] * 60_000).toISOString());
  });
  for (let index = 0; index < 30; index += 1) {
    const restaurant = restaurants[index % restaurants.length];
    const status = index < 20 ? "pending" : index < 28 ? "delivered" : "cancelled";
    const assignedAgent = status === "delivered" ? `agent-${index - 19}` : null;
    const orderId = `ord-${String(index + 1).padStart(3, "0")}`;
    const customer = { latitude: 28.456 + ((index * 17) % 310) / 10000, longitude: 77.490 + ((index * 23) % 340) / 10000 };
    const restaurantLocation = { latitude: restaurant[3], longitude: restaurant[4] };
    insertOrder.run(
      orderId, ["Riya", "Arjun", "Zoya", "Dev", "Ira", "Neil"][index % 6], restaurant[0],
      customer.latitude, customer.longitude,
      index % 7 === 0 ? 2 : 1, 180 + (index % 9) * 35, index % 5 === 0 ? 5 : index % 3 + 1,
      5 + (index % 4) * 3, 110 + (index % 5) * 18, status, assignedAgent,
      new Date(Date.now() - index * 6 * 60_000).toISOString(),
    );
    if (status === "delivered" && assignedAgent) {
      const riderLocation = agentPoints[Number(assignedAgent.slice("agent-".length)) - 1];
      const routeKm = estimateRoadKm({ latitude: riderLocation[0], longitude: riderLocation[1] }, restaurantLocation)
        + estimateRoadKm(restaurantLocation, customer)
        + estimateRoadKm(customer, { latitude: riderLocation[0], longitude: riderLocation[1] });
      const earnings = calculateRiderEarnings(routeKm, estimateRoadKm(restaurantLocation, customer), [{ priority: index % 5 === 0 ? 5 : index % 3 + 1 }], 35);
      const completedAt = new Date(Date.now() - (30 - index) * 6 * 60_000).toISOString();
      insertEarning.run(randomUUID(), assignedAgent, orderId, earnings.grossPayout, earnings.estimatedFuelCost, earnings.estimatedNet, routeKm, completedAt, completedAt);
    }
  }
}

function backfillAvailableDemoOrders() {
  const migrationId = "available-deliveries-20";
  const insertOrder = db.prepare(`INSERT INTO orders
    (id, customer_name, restaurant_id, customer_latitude, customer_longitude, quantity,
     revenue, priority, preparation_minutes, window_end_minutes, status, assigned_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`);
  const customerNames = ["Riya", "Arjun", "Zoya", "Dev", "Ira", "Neil"];
  let inserted = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM demo_migrations WHERE id=?").get(migrationId)) {
      db.exec("COMMIT");
      return;
    }
    const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status='pending'").get().count;
    for (let index = 0; index < Math.max(0, 20 - pendingCount); index += 1) {
      const sampleIndex = index + 30;
      const restaurant = restaurants[sampleIndex % restaurants.length];
      let orderId = `ord-${String(sampleIndex + 1).padStart(3, "0")}`;
      while (db.prepare("SELECT 1 FROM orders WHERE id=?").get(orderId)) {
        orderId = `available-${randomUUID()}`;
      }
      const customer = {
        latitude: 28.456 + ((sampleIndex * 17) % 310) / 10000,
        longitude: 77.490 + ((sampleIndex * 23) % 340) / 10000,
      };
      insertOrder.run(
        orderId, customerNames[sampleIndex % customerNames.length], restaurant[0],
        customer.latitude, customer.longitude,
        sampleIndex % 7 === 0 ? 2 : 1, 180 + (sampleIndex % 9) * 35,
        sampleIndex % 5 === 0 ? 5 : sampleIndex % 3 + 1,
        5 + (sampleIndex % 4) * 3, 110 + (sampleIndex % 5) * 18,
        new Date(Date.now() - sampleIndex * 6 * 60_000).toISOString(),
      );
      inserted += 1;
    }
    db.prepare("INSERT INTO demo_migrations (id, applied_at) VALUES (?, ?)").run(migrationId, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (inserted > 0) console.info(`Added ${inserted} demo orders to reach 20 available deliveries.`);
}

if (db.prepare("SELECT COUNT(*) AS count FROM restaurants").get().count === 0) seedDemoData();
backfillAvailableDemoOrders();

const ensureWorkSession = db.prepare("INSERT OR IGNORE INTO rider_work_sessions (agent_id, completed_work_minutes, session_started_at) VALUES (?, 0, ?)");
for (const agent of db.prepare("SELECT * FROM agents").all()) {
  const active = db.prepare("SELECT 1 FROM orders WHERE assigned_agent_id=? AND status IN ('assigned','picked_up') LIMIT 1").get(agent.id);
  ensureWorkSession.run(agent.id, agent.available || active ? new Date(Date.now() - 45 * 60_000).toISOString() : "");
}

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.WEB_ORIGIN || "http://localhost:5173");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const orderSelect = `SELECT o.*, r.name AS restaurant_name, r.latitude AS restaurant_latitude,
  r.longitude AS restaurant_longitude, a.name AS agent_name
  FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
  LEFT JOIN agents a ON a.id = o.assigned_agent_id`;

function estimateRoadKm(start, end) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(end.latitude - start.latitude);
  const longitudeDelta = radians(end.longitude - start.longitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(start.latitude)) * Math.cos(radians(end.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.sqrt(value) * 2 * 6_371 * 1.35;
}

function calculateRiderEarnings(routeDistanceKm, billableDistanceKm, orders, completionMinutes) {
  const priorityBonus = orders.reduce((sum, order) => sum + (order.priority >= 4 ? riderPayout.priorityBonus : 0), 0);
  const gross = riderPayout.base + billableDistanceKm * riderPayout.perKm + orders.length * riderPayout.perDrop + priorityBonus;
  const fuel = routeDistanceKm * riderPayout.fuelPerKm;
  const net = gross - fuel;
  return {
    currency: "INR",
    grossPayout: Math.round(gross),
    estimatedFuelCost: Math.round(fuel),
    estimatedNet: Math.round(net),
    estimatedNetPerHour: completionMinutes > 0 ? Math.round(net * 60 / completionMinutes) : 0,
    estimatedCompletionMinutes: Math.round(completionMinutes),
    routeDistanceKm: Number(routeDistanceKm.toFixed(2)),
    billableDistanceKm: Number(billableDistanceKm.toFixed(2)),
    assumptions: riderPayout,
    label: "Demo estimate: payout per restaurant-to-customer km; fuel on every route km",
  };
}

function backfillRiderProfiles() {
  const agents = db.prepare("SELECT * FROM agents ORDER BY id").all();
  const deliveredWithoutRider = db.prepare("SELECT * FROM orders WHERE status='delivered' AND assigned_agent_id IS NULL ORDER BY created_at").all();
  const assignDeliveredOrder = db.prepare("UPDATE orders SET assigned_agent_id=? WHERE id=? AND assigned_agent_id IS NULL");
  deliveredWithoutRider.forEach((order, index) => assignDeliveredOrder.run(agents[index % agents.length].id, order.id));

  const historyByRider = db.prepare("SELECT COUNT(*) AS deliveries FROM orders WHERE assigned_agent_id=? AND status='delivered'");
  const updateWorkHistory = db.prepare("UPDATE rider_work_sessions SET completed_work_minutes=? WHERE agent_id=? AND completed_work_minutes=0");
  agents.forEach((agent, index) => {
    const deliveredCount = historyByRider.get(agent.id).deliveries;
    if (deliveredCount > 0) updateWorkHistory.run(deliveredCount * 38 + (index + 1) * 47, agent.id);
  });

  const deliveredOrders = db.prepare(`SELECT o.*, r.latitude AS restaurant_latitude, r.longitude AS restaurant_longitude,
      a.latitude AS agent_latitude, a.longitude AS agent_longitude
    FROM orders o JOIN restaurants r ON r.id=o.restaurant_id
    JOIN agents a ON a.id=o.assigned_agent_id
    LEFT JOIN rider_earnings e ON e.order_id=o.id
    WHERE o.status='delivered' AND e.id IS NULL`).all();
  const insertEarning = db.prepare(`INSERT OR IGNORE INTO rider_earnings
    (id, agent_id, order_id, gross_payout, fuel_cost, net_earnings, route_km, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'earned', ?, ?)`);
  for (const order of deliveredOrders) {
    const riderStart = { latitude: order.agent_latitude, longitude: order.agent_longitude };
    const restaurant = { latitude: order.restaurant_latitude, longitude: order.restaurant_longitude };
    const customer = { latitude: order.customer_latitude, longitude: order.customer_longitude };
    const routeKm = estimateRoadKm(riderStart, restaurant) + estimateRoadKm(restaurant, customer) + estimateRoadKm(customer, riderStart);
    const earnings = calculateRiderEarnings(routeKm, estimateRoadKm(restaurant, customer), [order], 38);
    const completedAt = order.created_at || new Date().toISOString();
    insertEarning.run(randomUUID(), order.assigned_agent_id, order.id, earnings.grossPayout, earnings.estimatedFuelCost, earnings.estimatedNet, routeKm, completedAt, completedAt);
  }

  const activeRoutes = db.prepare("SELECT * FROM rider_routes WHERE status='active'").all();
  const insertPendingEarning = db.prepare(`INSERT OR IGNORE INTO rider_earnings
    (id, agent_id, order_id, gross_payout, fuel_cost, net_earnings, route_km, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  for (const activeRoute of activeRoutes) {
    const routeResult = JSON.parse(activeRoute.route_json);
    const routeEarnings = JSON.parse(activeRoute.earnings_json);
    const orderIds = routeResult.routes.flatMap((route) => route.order_ids);
    const placeholders = orderIds.map(() => "?").join(",");
    const activeOrders = db.prepare(`SELECT id FROM orders WHERE id IN (${placeholders}) AND status IN ('assigned','picked_up')
      AND id NOT IN (SELECT order_id FROM rider_earnings)`).all(...orderIds);
    activeOrders.forEach((order, index) => {
      const share = (total) => Math.round((total / activeOrders.length) * 100) / 100;
      const finalShare = (total) => Number((total - share(total) * (activeOrders.length - 1)).toFixed(2));
      insertPendingEarning.run(
        randomUUID(), activeRoute.agent_id, order.id,
        index === activeOrders.length - 1 ? finalShare(routeEarnings.grossPayout) : share(routeEarnings.grossPayout),
        index === activeOrders.length - 1 ? finalShare(routeEarnings.estimatedFuelCost) : share(routeEarnings.estimatedFuelCost),
        index === activeOrders.length - 1 ? finalShare(routeEarnings.estimatedNet) : share(routeEarnings.estimatedNet),
        index === activeOrders.length - 1 ? finalShare(routeEarnings.routeDistanceKm) : share(routeEarnings.routeDistanceKm),
        activeRoute.created_at,
      );
    });
  }

  const activeOrdersWithoutLedger = db.prepare(`SELECT o.*, r.latitude AS restaurant_latitude, r.longitude AS restaurant_longitude,
      a.latitude AS agent_latitude, a.longitude AS agent_longitude
    FROM orders o JOIN restaurants r ON r.id=o.restaurant_id
    JOIN agents a ON a.id=o.assigned_agent_id
    LEFT JOIN rider_earnings e ON e.order_id=o.id
    WHERE o.status IN ('assigned','picked_up') AND e.id IS NULL`).all();
  for (const order of activeOrdersWithoutLedger) {
    const riderStart = { latitude: order.agent_latitude, longitude: order.agent_longitude };
    const restaurant = { latitude: order.restaurant_latitude, longitude: order.restaurant_longitude };
    const customer = { latitude: order.customer_latitude, longitude: order.customer_longitude };
    const billableKm = estimateRoadKm(restaurant, customer);
    const routeKm = estimateRoadKm(riderStart, restaurant) + billableKm + estimateRoadKm(customer, riderStart);
    const completionMinutes = Math.round(routeKm / 18 * 60 + order.preparation_minutes + 6);
    const earnings = calculateRiderEarnings(routeKm, billableKm, [order], completionMinutes);
    insertPendingEarning.run(randomUUID(), order.assigned_agent_id, order.id, earnings.grossPayout, earnings.estimatedFuelCost, earnings.estimatedNet, routeKm, order.created_at);
  }
}

backfillRiderProfiles();

app.get("/api/health", (_req, res) => res.json({ status: "ok", database: "sqlite", optimizer: optimizerUrl }));
app.get("/api/overview", (_req, res) => {
  const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status").all().map((row) => [row.status, row.count]));
  const delivered = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(revenue),0) AS revenue FROM orders WHERE status='delivered'").get();
  const activeAgents = db.prepare("SELECT COUNT(*) AS count FROM agents WHERE available=1").get().count;
  const orders = db.prepare(`${orderSelect} ORDER BY created_at DESC LIMIT 10`).all();
  res.json({ counts, revenue: delivered.revenue, activeAgents, recentOrders: orders, dataMode: "simulated-demo" });
});

app.get("/api/orders", (req, res) => {
  const status = req.query.status;
  const rows = status ? db.prepare(`${orderSelect} WHERE o.status=? ORDER BY o.created_at DESC`).all(status) : db.prepare(`${orderSelect} ORDER BY o.created_at DESC`).all();
  res.json(rows);
});
app.get("/api/restaurants", (_req, res) => res.json(db.prepare("SELECT * FROM restaurants ORDER BY name").all()));
app.get("/api/agents", (_req, res) => res.json(db.prepare(`SELECT a.*, COUNT(CASE WHEN o.status IN ('assigned','picked_up') THEN 1 END) AS active_orders
  FROM agents a LEFT JOIN orders o ON o.assigned_agent_id=a.id GROUP BY a.id ORDER BY a.name`).all()));

app.get("/api/rider/:agentId/dashboard", (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: "Rider not found" });
  const session = db.prepare("SELECT * FROM rider_work_sessions WHERE agent_id=?").get(agent.id);
  const totals = db.prepare(`SELECT COUNT(*) AS completed_deliveries,
      COALESCE(SUM(net_earnings), 0) AS total_net_earnings,
      COALESCE(SUM(gross_payout), 0) AS total_gross_payout,
      COALESCE(SUM(fuel_cost), 0) AS total_fuel_cost,
      COALESCE(SUM(route_km), 0) AS total_route_km
    FROM rider_earnings WHERE agent_id=? AND status='earned'`).get(agent.id);
  const today = db.prepare(`SELECT COUNT(*) AS deliveries,
      COALESCE(SUM(net_earnings), 0) AS net_earnings,
      COALESCE(SUM(route_km), 0) AS route_km
    FROM rider_earnings WHERE agent_id=? AND status='earned' AND date(completed_at)=date('now')`).get(agent.id);
  const activeOrders = db.prepare(`${orderSelect} WHERE o.assigned_agent_id=? AND o.status IN ('assigned','picked_up') ORDER BY o.created_at`).all(agent.id);
  const pendingEarnings = db.prepare("SELECT COALESCE(SUM(net_earnings), 0) AS amount FROM rider_earnings WHERE agent_id=? AND status='pending'").get(agent.id).amount;
  const runningMinutes = session?.session_started_at ? Math.max(0, Math.floor((Date.now() - Date.parse(session.session_started_at)) / 60_000)) : 0;
  const workingMinutes = (session?.completed_work_minutes || 0) + runningMinutes;
  const activeRoute = db.prepare("SELECT id, route_json FROM rider_routes WHERE agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").get(agent.id);
  res.json({
    rider: { id: agent.id, name: agent.name, phone: agent.phone, capacity: agent.capacity, available: Boolean(agent.available), location: { latitude: agent.latitude, longitude: agent.longitude } },
    stats: {
      completedDeliveries: totals.completed_deliveries,
      totalNetEarnings: Math.round(totals.total_net_earnings),
      totalGrossPayout: Math.round(totals.total_gross_payout),
      totalFuelCost: Math.round(totals.total_fuel_cost),
      totalRouteKm: Number(totals.total_route_km.toFixed(1)),
      workingMinutes,
      workingHours: Number((workingMinutes / 60).toFixed(1)),
      activeDeliveries: activeOrders.length,
      pendingNetEarnings: Math.round(pendingEarnings),
      todayDeliveries: today.deliveries,
      todayNetEarnings: Math.round(today.net_earnings),
      todayRouteKm: Number(today.route_km.toFixed(1)),
    },
    activeOrders,
    activeRoute: activeRoute ? { id: activeRoute.id, ...JSON.parse(activeRoute.route_json) } : null,
    payoutAssumptions: riderPayout,
  });
});

app.post("/api/rider/:agentId/availability", (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: "Rider not found" });
  const online = req.body?.online;
  if (typeof online !== "boolean") return res.status(400).json({ error: "online must be true or false" });
  const active = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE assigned_agent_id=? AND status IN ('assigned','picked_up')").get(agent.id).count;
  if (!online && active > 0) return res.status(409).json({ error: "Finish your assigned deliveries before going offline" });
  const session = db.prepare("SELECT * FROM rider_work_sessions WHERE agent_id=?").get(agent.id);
  const now = new Date().toISOString();
  if (online) {
    db.prepare("UPDATE rider_work_sessions SET session_started_at=CASE WHEN session_started_at IS NULL OR session_started_at='' THEN ? ELSE session_started_at END WHERE agent_id=?").run(now, agent.id);
    db.prepare("UPDATE agents SET available=1 WHERE id=?").run(agent.id);
  } else {
    const additionalMinutes = session?.session_started_at ? Math.max(0, Math.floor((Date.now() - Date.parse(session.session_started_at)) / 60_000)) : 0;
    db.prepare("UPDATE rider_work_sessions SET completed_work_minutes=completed_work_minutes+?, session_started_at='' WHERE agent_id=?").run(additionalMinutes, agent.id);
    db.prepare("UPDATE agents SET available=0 WHERE id=?").run(agent.id);
  }
  res.json({ online, riderId: agent.id });
});

app.get("/api/rider/:agentId/available-orders", (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: "Rider not found" });
  const pending = db.prepare(`${orderSelect} WHERE o.status='pending'`).all();
  const offers = pending.map((order) => {
    const firstLeg = estimateRoadKm(agent, { latitude: order.restaurant_latitude, longitude: order.restaurant_longitude });
    const customer = { latitude: order.customer_latitude, longitude: order.customer_longitude };
    const deliveryLeg = estimateRoadKm(
      { latitude: order.restaurant_latitude, longitude: order.restaurant_longitude },
      customer,
    );
    const returnLeg = estimateRoadKm(customer, agent);
    const estimatedDistanceKm = firstLeg + deliveryLeg + returnLeg;
    const estimatedTimeMinutes = Math.round(estimatedDistanceKm / 18 * 60 + order.preparation_minutes + 6);
    const earnings = calculateRiderEarnings(estimatedDistanceKm, deliveryLeg, [order], estimatedTimeMinutes);
    return {
      ...order,
      estimatedDistanceKm: Number(estimatedDistanceKm.toFixed(1)),
      estimatedBillableKm: Number(deliveryLeg.toFixed(1)),
      estimatedTimeMinutes,
      estimatedNet: earnings.estimatedNet,
      estimatedNetPerHour: earnings.estimatedNetPerHour,
      estimateSource: "simulated-straight-line-road-factor",
    };
  }).sort((left, right) => right.estimatedNet - left.estimatedNet);
  res.json({ rider: { id: agent.id, name: agent.name, capacity: agent.capacity, available: Boolean(agent.available) }, offers, payoutAssumptions: riderPayout });
});

app.post("/api/rider/:agentId/preview", async (req, res) => {
  const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(req.params.agentId);
  if (!agent) return res.status(404).json({ error: "Rider not found" });
  if (!agent.available) return res.status(409).json({ error: "This rider is offline or already has an active delivery route" });
  const orderIds = req.body?.orderIds;
  if (!Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > 4 || new Set(orderIds).size !== orderIds.length) {
    return res.status(400).json({ error: "Choose between 1 and 4 different orders for one route preview" });
  }
  const placeholders = orderIds.map(() => "?").join(",");
  const selectedOrders = db.prepare(`${orderSelect} WHERE o.id IN (${placeholders}) AND o.status='pending'`).all(...orderIds);
  if (selectedOrders.length !== orderIds.length) return res.status(409).json({ error: "One or more selected orders are no longer available" });
  try {
    const response = await fetch(`${optimizerUrl}/optimize/balanced`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        strategy: "balanced", solve_seconds: 3,
        orders: selectedOrders.map((order) => ({
          id: order.id, restaurant: { latitude: order.restaurant_latitude, longitude: order.restaurant_longitude },
          customer: { latitude: order.customer_latitude, longitude: order.customer_longitude },
          quantity: order.quantity, revenue: order.revenue, priority: order.priority,
          preparation_minutes: order.preparation_minutes, window_end_minutes: order.window_end_minutes,
        })),
        agents: [{ id: agent.id, location: { latitude: agent.latitude, longitude: agent.longitude }, capacity: agent.capacity, available: true }],
      }),
    });
    const routeResult = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: routeResult.detail || "This order combination is not route-feasible" });
    if (routeResult.unassigned_order_ids.length > 0 || routeResult.routes.length !== 1) {
      return res.status(422).json({ error: "The selected order combination cannot be completed by this rider within current capacity and time limits" });
    }
    const route = routeResult.routes[0];
    const earnings = calculateRiderEarnings(
      route.total_distance_km,
      route.billable_delivery_distance_km,
      selectedOrders,
      route.estimated_completion_minutes,
    );
    const offerId = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO rider_offers (id, agent_id, order_ids_json, route_json, earnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(offerId, agent.id, JSON.stringify(orderIds), JSON.stringify(routeResult), JSON.stringify(earnings), createdAt);
    res.json({ id: offerId, agentId: agent.id, orderIds, routeResult, earnings, createdAt, status: "offered" });
  } catch (error) {
    res.status(502).json({ error: "Optimization service unavailable", detail: error.message });
  }
});

app.post("/api/rider/offers/:offerId/accept", (req, res) => {
  const offer = db.prepare("SELECT * FROM rider_offers WHERE id=?").get(req.params.offerId);
  if (!offer || offer.status !== "offered") return res.status(404).json({ error: "Rider offer not found or already used" });
  const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(offer.agent_id);
  if (!agent?.available) return res.status(409).json({ error: "Rider is no longer available" });
  const orderIds = JSON.parse(offer.order_ids_json);
  const updateOrder = db.prepare("UPDATE orders SET status='assigned', assigned_agent_id=? WHERE id=? AND status='pending'");
  const routeId = randomUUID();
  const createdAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const orderId of orderIds) {
      const update = updateOrder.run(agent.id, orderId);
      if (update.changes !== 1) throw new Error(`Order ${orderId} is no longer available`);
    }
    db.prepare("UPDATE agents SET available=0 WHERE id=?").run(agent.id);
    db.prepare("UPDATE rider_work_sessions SET session_started_at=CASE WHEN session_started_at IS NULL OR session_started_at='' THEN ? ELSE session_started_at END WHERE agent_id=?").run(createdAt, agent.id);
    const offerEarnings = JSON.parse(offer.earnings_json);
    const insertPendingEarning = db.prepare(`INSERT INTO rider_earnings
      (id, agent_id, order_id, gross_payout, fuel_cost, net_earnings, route_km, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
    orderIds.forEach((orderId, index) => {
      const share = (total) => Math.round((total / orderIds.length) * 100) / 100;
      const finalShare = (total) => Number((total - share(total) * (orderIds.length - 1)).toFixed(2));
      insertPendingEarning.run(
        randomUUID(), agent.id, orderId,
        index === orderIds.length - 1 ? finalShare(offerEarnings.grossPayout) : share(offerEarnings.grossPayout),
        index === orderIds.length - 1 ? finalShare(offerEarnings.estimatedFuelCost) : share(offerEarnings.estimatedFuelCost),
        index === orderIds.length - 1 ? finalShare(offerEarnings.estimatedNet) : share(offerEarnings.estimatedNet),
        index === orderIds.length - 1 ? finalShare(offerEarnings.routeDistanceKm) : share(offerEarnings.routeDistanceKm),
        createdAt,
      );
    });
    db.prepare("UPDATE rider_offers SET status='accepted' WHERE id=?").run(offer.id);
    db.prepare("INSERT INTO rider_routes (id, agent_id, offer_id, route_json, earnings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(routeId, agent.id, offer.id, offer.route_json, offer.earnings_json, createdAt);
    db.exec("COMMIT");
    res.json({ accepted: true, routeId, agentId: agent.id, orderIds });
  } catch (error) {
    db.exec("ROLLBACK");
    res.status(409).json({ error: error.message });
  }
});

app.get("/api/rider/:agentId/route", (req, res) => {
  const route = db.prepare("SELECT * FROM rider_routes WHERE agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").get(req.params.agentId);
  if (!route) return res.json({ route: null });
  const routeResult = JSON.parse(route.route_json);
  const routeOrderIds = routeResult.routes.flatMap((item) => item.order_ids);
  const placeholders = routeOrderIds.map(() => "?").join(",");
  res.json({
    route: true,
    routeId: route.id, routeResult, earnings: JSON.parse(route.earnings_json),
    orders: db.prepare(`${orderSelect} WHERE o.id IN (${placeholders}) AND o.assigned_agent_id=? AND o.status IN ('assigned','picked_up') ORDER BY o.created_at`).all(...routeOrderIds, route.agent_id),
  });
});

app.post("/api/rider/:agentId/orders/:orderId/confirm-delivery", async (req, res) => {
  const { agentId, orderId } = req.params;
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.assigned_agent_id !== agentId) return res.status(403).json({ error: "This order is not assigned to this rider" });
  if (order.status !== "picked_up") return res.status(409).json({ error: "Confirm pickup before confirming delivery" });
  const activeRoutes = db.prepare("SELECT * FROM rider_routes WHERE agent_id=? AND status='active'").all(agentId);
  const route = activeRoutes.find((item) => {
    const offer = db.prepare("SELECT order_ids_json FROM rider_offers WHERE id=?").get(item.offer_id);
    return offer && JSON.parse(offer.order_ids_json).includes(orderId);
  });
  if (!route) return res.status(409).json({ error: "No active rider route contains this order" });
  if (JSON.parse(route.route_json).strategy !== "nearest-delivery-after-last-pickup") {
    return res.status(409).json({ error: "Confirm every restaurant pickup before starting customer deliveries" });
  }
  const offer = db.prepare("SELECT order_ids_json FROM rider_offers WHERE id=?").get(route.offer_id);
  const routeOrderIds = JSON.parse(offer.order_ids_json);
  const placeholders = routeOrderIds.map(() => "?").join(",");
  const remainingOrders = db.prepare(`${orderSelect} WHERE o.id IN (${placeholders}) AND o.id!=? AND o.status IN ('assigned','picked_up')`)
    .all(...routeOrderIds, orderId);
  let nextRouteResult = null;
  if (remainingOrders.length > 0) {
    try {
      const response = await fetch(`${optimizerUrl}/route/delivery-sequence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          start: { latitude: order.customer_latitude, longitude: order.customer_longitude },
          destinations: remainingOrders.map((remainingOrder) => ({
            order_id: remainingOrder.id,
            customer: { latitude: remainingOrder.customer_latitude, longitude: remainingOrder.customer_longitude },
            service_minutes: 4,
          })),
        }),
      });
      if (!response.ok) throw new Error(`Delivery route optimization returned ${response.status}`);
      nextRouteResult = await response.json();
      nextRouteResult.phase = "delivery";
      nextRouteResult.routes[0].agent_id = agentId;
      nextRouteResult.routes[0].start_location = { latitude: order.customer_latitude, longitude: order.customer_longitude };
    } catch (routeError) {
      return res.status(502).json({ error: "Could not replan the remaining deliveries; this order is still marked picked up", detail: routeError.message });
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare("UPDATE orders SET status='delivered' WHERE id=? AND assigned_agent_id=? AND status='picked_up'").run(orderId, agentId);
    if (updated.changes !== 1) throw new Error("Order status changed; refresh the route and try again");
    db.prepare("UPDATE rider_earnings SET status='earned', completed_at=? WHERE order_id=? AND agent_id=? AND status='pending'").run(new Date().toISOString(), orderId, agentId);
    const remainingOnRoute = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE id IN (${placeholders}) AND status!='delivered'`).get(...routeOrderIds).count;
    if (remainingOnRoute === 0) {
      db.prepare("UPDATE rider_routes SET status='completed' WHERE id=?").run(route.id);
    } else {
      db.prepare("UPDATE rider_routes SET route_json=? WHERE id=?").run(JSON.stringify(nextRouteResult), route.id);
    }
    const remainingForAgent = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE assigned_agent_id=? AND status IN ('assigned','picked_up')").get(agentId).count;
    if (remainingForAgent === 0) db.prepare("UPDATE agents SET available=1 WHERE id=?").run(agentId);
    db.exec("COMMIT");
    res.json({
      delivered: true,
      routeCompleted: remainingOnRoute === 0,
      remainingRouteOrders: remainingOnRoute,
      routeResult: nextRouteResult,
      order: db.prepare(`${orderSelect} WHERE o.id=?`).get(orderId),
    });
  } catch (error) {
    db.exec("ROLLBACK");
    res.status(409).json({ error: error.message });
  }
});

const transitions = {
  pending: ["preparing", "cancelled"], preparing: ["ready", "cancelled"],
  ready: ["assigned", "cancelled"], assigned: ["picked_up", "cancelled"],
  picked_up: ["delivered"], delivered: [], cancelled: [],
};
app.patch("/api/orders/:id/status", async (req, res) => {
  const { status } = req.body ?? {};
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!transitions[order.status]?.includes(status)) return res.status(409).json({ error: `Cannot change ${order.status} to ${status}` });
  if (status === "delivered" && order.assigned_agent_id) {
    const riderRoute = db.prepare("SELECT 1 FROM rider_routes WHERE agent_id=? AND status='active'").get(order.assigned_agent_id);
    if (riderRoute) return res.status(409).json({ error: "The assigned rider must explicitly confirm delivery" });
  }
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, order.id);
  let riderRouteReplanned = false;
  if (status === "picked_up" && order.assigned_agent_id) {
    const activeRoutes = db.prepare("SELECT * FROM rider_routes WHERE agent_id=? AND status='active'").all(order.assigned_agent_id);
    for (const activeRoute of activeRoutes) {
      const offer = db.prepare("SELECT order_ids_json FROM rider_offers WHERE id=?").get(activeRoute.offer_id);
      const routeOrderIds = offer ? JSON.parse(offer.order_ids_json) : [];
      if (!routeOrderIds.includes(order.id)) continue;
      const placeholders = routeOrderIds.map(() => "?").join(",");
      const unpickedCount = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE id IN (${placeholders}) AND status='assigned'`).get(...routeOrderIds).count;
      if (unpickedCount > 0) break;

      const lastPickup = db.prepare(`SELECT r.latitude, r.longitude FROM orders o JOIN restaurants r ON r.id=o.restaurant_id WHERE o.id=?`).get(order.id);
      const destinations = db.prepare(`SELECT id, customer_latitude, customer_longitude FROM orders WHERE id IN (${placeholders}) AND status='picked_up'`).all(...routeOrderIds);
      try {
        const routeResponse = await fetch(`${optimizerUrl}/route/delivery-sequence`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({
            start: { latitude: lastPickup.latitude, longitude: lastPickup.longitude },
            destinations: destinations.map((destination) => ({
              order_id: destination.id,
              customer: { latitude: destination.customer_latitude, longitude: destination.customer_longitude },
              service_minutes: 4,
            })),
          }),
        });
        if (!routeResponse.ok) throw new Error(`Delivery route optimization returned ${routeResponse.status}`);
        const deliveryRoute = await routeResponse.json();
        deliveryRoute.phase = "delivery";
        deliveryRoute.routes[0].agent_id = order.assigned_agent_id;
        deliveryRoute.routes[0].start_location = { latitude: lastPickup.latitude, longitude: lastPickup.longitude };
        db.prepare("UPDATE rider_routes SET route_json=? WHERE id=?").run(JSON.stringify(deliveryRoute), activeRoute.id);
        riderRouteReplanned = true;
      } catch (routeError) {
        console.error("Unable to replan rider deliveries from the last pickup:", routeError.message);
      }
      break;
    }
  }
  if (status === "delivered" && order.assigned_agent_id) {
    const activeRoutes = db.prepare("SELECT id, offer_id FROM rider_routes WHERE agent_id=? AND status='active'").all(order.assigned_agent_id);
    for (const route of activeRoutes) {
      const offer = db.prepare("SELECT order_ids_json FROM rider_offers WHERE id=?").get(route.offer_id);
      const routeOrderIds = JSON.parse(offer.order_ids_json);
      const placeholders = routeOrderIds.map(() => "?").join(",");
      const remainingOnRoute = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE id IN (${placeholders}) AND status IN ('assigned','picked_up')`).get(...routeOrderIds).count;
      if (remainingOnRoute === 0) db.prepare("UPDATE rider_routes SET status='completed' WHERE id=?").run(route.id);
    }
    const remainingForAgent = db.prepare("SELECT COUNT(*) AS count FROM orders WHERE assigned_agent_id=? AND status IN ('assigned','picked_up')").get(order.assigned_agent_id).count;
    if (remainingForAgent === 0) db.prepare("UPDATE agents SET available=1 WHERE id=?").run(order.assigned_agent_id);
  }
  res.json({ ...db.prepare(`${orderSelect} WHERE o.id=?`).get(order.id), riderRouteReplanned });
});

app.post("/api/optimization/run", async (req, res) => {
  const strategy = req.body?.strategy || "balanced";
  if (!["distance", "time", "profit", "balanced"].includes(strategy)) return res.status(400).json({ error: "Invalid optimization strategy" });
  const pending = db.prepare(`${orderSelect} WHERE o.status='pending'`).all();
  const agents = db.prepare("SELECT * FROM agents WHERE available=1").all();
  try {
    const response = await fetch(`${optimizerUrl}/optimize/${strategy}`, {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        strategy, solve_seconds: 5,
        orders: pending.map((order) => ({
          id: order.id, restaurant: { latitude: order.restaurant_latitude, longitude: order.restaurant_longitude },
          customer: { latitude: order.customer_latitude, longitude: order.customer_longitude },
          quantity: order.quantity, revenue: order.revenue, priority: order.priority,
          preparation_minutes: order.preparation_minutes, window_end_minutes: order.window_end_minutes,
        })),
        agents: agents.map((agent) => ({ id: agent.id, location: { latitude: agent.latitude, longitude: agent.longitude }, capacity: agent.capacity, available: true })),
      }),
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: result.detail || "Optimization failed" });
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO optimization_runs VALUES (?, ?, ?, ?, ?)").run(id, strategy, result.routing_source, JSON.stringify(result), createdAt);
    res.json({ id, createdAt, ...result });
  } catch (error) {
    res.status(502).json({ error: "Optimization service unavailable", detail: error.message });
  }
});

app.get("/api/optimization/history", (_req, res) => {
  res.json(db.prepare("SELECT id, strategy, routing_source, created_at FROM optimization_runs ORDER BY created_at DESC LIMIT 20").all());
});
app.get("/api/optimization/:id", (req, res) => {
  const run = db.prepare("SELECT * FROM optimization_runs WHERE id=?").get(req.params.id);
  if (!run) return res.status(404).json({ error: "Optimization run not found" });
  res.json({ ...run, ...JSON.parse(run.result_json) });
});

app.post("/api/optimization/:id/apply", (req, res) => {
  const run = db.prepare("SELECT * FROM optimization_runs WHERE id=?").get(req.params.id);
  if (!run) return res.status(404).json({ error: "Optimization run not found" });
  const result = JSON.parse(run.result_json);
  const update = db.prepare("UPDATE orders SET status='assigned', assigned_agent_id=? WHERE id=? AND status='pending'");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const route of result.routes) {
      for (const orderId of route.order_ids) {
        const change = update.run(route.agent_id, orderId);
        if (change.changes !== 1) throw new Error(`Order ${orderId} is no longer pending`);
      }
      db.prepare("UPDATE agents SET available=0 WHERE id=?").run(route.agent_id);
    }
    db.exec("COMMIT");
    res.json({ applied: true, assignedOrders: result.totals.orders });
  } catch (error) {
    db.exec("ROLLBACK");
    res.status(409).json({ error: error.message });
  }
});

app.post("/api/admin/reset-demo", (_req, res) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM optimization_runs; DELETE FROM rider_routes; DELETE FROM rider_offers; DELETE FROM rider_earnings; DELETE FROM rider_work_sessions; DELETE FROM orders; DELETE FROM agents; DELETE FROM restaurants;");
    seedDemoData();
    db.exec("COMMIT");
    res.json({ reset: true });
  } catch (error) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, "127.0.0.1", () => console.log(`Delivery API listening on http://127.0.0.1:${port}`));