import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "delivery-api-test-"));
const port = 4100 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let optimizer;
const optimizerPort = port + 500;

before(async () => {
  optimizer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const requestUrl = new URL(request.url, `http://127.0.0.1:${optimizerPort}`);
    if (requestUrl.pathname === "/route/delivery-sequence") {
      const { start } = payload;
      const destinations = [...payload.destinations].sort((left, right) => {
        const distance = (destination) => Math.hypot(destination.customer.latitude - start.latitude, destination.customer.longitude - start.longitude);
        return distance(left) - distance(right);
      });
      const route = {
        agent_id: "rider", start_location: start,
        order_ids: destinations.map((destination) => destination.order_id),
        stops: destinations.map((destination, index) => ({
          order_id: destination.order_id, type: "delivery", location: destination.customer,
          sequence: index + 1, estimated_arrival_minutes: 10 + index * 12,
        })),
        geometry: [[start.latitude, start.longitude], ...destinations.map((destination) => [destination.customer.latitude, destination.customer.longitude])],
        directions: [], total_distance_km: 4, billable_delivery_distance_km: 4,
        estimated_driving_minutes: 22, estimated_completion_minutes: 28, total_stops: destinations.length,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ strategy: "nearest-delivery-after-last-pickup", phase: "delivery", routing_source: "osrm-test", routes: [route], unassigned_order_ids: [], totals: { orders: destinations.length, agents_used: 1, distance_km: 4, driving_minutes: 22, workload_std_dev: 0 } }));
      return;
    }
    const order = payload.orders[0];
    const agent = payload.agents[0];
    const route = {
      agent_id: agent.id,
      order_ids: payload.orders.map((item) => item.id),
      stops: payload.orders.flatMap((item, index) => [
        { order_id: item.id, type: "pickup", location: item.restaurant, sequence: index * 2 + 1, estimated_arrival_minutes: 5 },
        { order_id: item.id, type: "delivery", location: item.customer, sequence: index * 2 + 2, estimated_arrival_minutes: 18 },
      ]),
      total_distance_km: 3,
      billable_delivery_distance_km: 2,
      estimated_driving_minutes: 18,
      estimated_completion_minutes: 24,
      workload_points: 9,
      total_stops: payload.orders.length * 2,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      strategy: "balanced", routes: [route], unassigned_order_ids: [], routing_source: "simulated-test",
      totals: { orders: payload.orders.length, agents_used: 1, distance_km: 3, driving_minutes: 18, workload_std_dev: 0 },
    }));
    assert.ok(order);
  });
  await new Promise((resolvePromise) => optimizer.listen(optimizerPort, "127.0.0.1", resolvePromise));
  server = spawn(process.execPath, ["server.js"], {
    cwd: backendDirectory,
    stdio: "ignore",
    env: { ...process.env, API_PORT: String(port), DATABASE_PATH: resolve(temporaryDirectory, "test.sqlite"), OPTIMIZER_URL: `http://127.0.0.1:${optimizerPort}` },
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* Wait for the local server to bind. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("API did not start for integration tests");
});

after(async () => {
  if (server && server.exitCode === null) {
    await new Promise((resolvePromise) => {
      server.once("exit", resolvePromise);
      server.kill();
    });
  }
  if (optimizer?.listening) await new Promise((resolvePromise) => optimizer.close(resolvePromise));
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("serves seeded restaurants, agents, and orders from SQLite", async () => {
  const [ordersResponse, pendingOrdersResponse, restaurantsResponse, agentsResponse, offersResponse] = await Promise.all([
    fetch(`${baseUrl}/api/orders`), fetch(`${baseUrl}/api/orders?status=pending`), fetch(`${baseUrl}/api/restaurants`), fetch(`${baseUrl}/api/agents`),
    fetch(`${baseUrl}/api/rider/agent-1/available-orders`),
  ]);
  assert.equal((await ordersResponse.json()).length, 30);
  assert.equal((await pendingOrdersResponse.json()).length, 20);
  assert.equal((await offersResponse.json()).offers.length, 20);
  assert.equal((await restaurantsResponse.json()).length, 5);
  assert.equal((await agentsResponse.json()).length, 10);
});

test("rider dashboards show separate work hours, earnings, and completed deliveries", async () => {
  const dashboards = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const response = await fetch(`${baseUrl}/api/rider/agent-${index + 1}/dashboard`);
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.deepEqual(dashboards.map((dashboard) => dashboard.rider.name), [
    "Aarav", "Meera", "Kabir", "Sana", "Ishaan", "Diya", "Vihaan", "Anaya", "Reyansh", "Tara",
  ]);
  assert.equal(new Set(dashboards.map((dashboard) => dashboard.stats.workingMinutes)).size, 10);
  assert.ok(dashboards.slice(0, 8).every((dashboard) => dashboard.stats.totalNetEarnings + dashboard.stats.pendingNetEarnings > 0));
  assert.ok(dashboards.slice(0, 8).every((dashboard) => dashboard.stats.completedDeliveries > 0));
});

test("rider availability pauses and resumes only that rider's shift clock", async () => {
  const before = await (await fetch(`${baseUrl}/api/rider/agent-1/dashboard`)).json();
  const offline = await fetch(`${baseUrl}/api/rider/agent-1/availability`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ online: false }),
  });
  assert.equal(offline.status, 200);
  const paused = await (await fetch(`${baseUrl}/api/rider/agent-1/dashboard`)).json();
  assert.equal(paused.rider.available, false);
  assert.ok(paused.stats.workingMinutes >= before.stats.workingMinutes);

  const online = await fetch(`${baseUrl}/api/rider/agent-1/availability`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ online: true }),
  });
  assert.equal(online.status, 200);
  const resumed = await (await fetch(`${baseUrl}/api/rider/agent-1/dashboard`)).json();
  assert.equal(resumed.rider.available, true);
  assert.equal(resumed.stats.workingMinutes, paused.stats.workingMinutes);
});

test("allows valid order transitions and rejects invalid transitions", async () => {
  const orders = await (await fetch(`${baseUrl}/api/orders?status=pending`)).json();
  const order = orders[0];
  const valid = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "preparing" }),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).status, "preparing");

  const invalid = await fetch(`${baseUrl}/api/orders/${order.id}/status`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "delivered" }),
  });
  assert.equal(invalid.status, 409);
});

test("previews and accepts a rider-selected delivery into a persistent route", async () => {
  const [availableResponse, agentsResponse, overviewResponse] = await Promise.all([
    fetch(`${baseUrl}/api/rider/agent-1/available-orders`), fetch(`${baseUrl}/api/agents`), fetch(`${baseUrl}/api/overview`),
  ]);
  const available = await availableResponse.json();
  const overview = await overviewResponse.json();
  assert.equal(available.offers.length, overview.counts.pending);
  assert.ok(available.offers[0].estimatedNet > 0);
  assert.ok((await agentsResponse.json()).some((agent) => agent.id === "agent-1" && agent.name === "Aarav"));

  const orderIds = available.offers.slice(0, 2).map((offer) => offer.id);
  const previewResponse = await fetch(`${baseUrl}/api/rider/agent-1/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderIds }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.routeResult.routes[0].stops[0].type, "pickup");
  assert.ok(preview.earnings.grossPayout > preview.earnings.estimatedNet);
  assert.equal(preview.earnings.routeDistanceKm, 3);
  assert.equal(preview.earnings.billableDistanceKm, 2);
  assert.ok(preview.earnings.estimatedNetPerHour > 0);
  assert.equal(preview.earnings.estimatedCompletionMinutes, 24);

  const acceptResponse = await fetch(`${baseUrl}/api/rider/offers/${preview.id}/accept`, { method: "POST", body: "{}" });
  assert.equal(acceptResponse.status, 200);
  const activeRoute = await (await fetch(`${baseUrl}/api/rider/agent-1/route`)).json();
  assert.equal(activeRoute.orders[0].status, "assigned");
  assert.equal(activeRoute.earnings.estimatedNet, preview.earnings.estimatedNet);

  const pickupOrderIds = activeRoute.routeResult.routes[0].stops.filter((stop) => stop.type === "pickup").map((stop) => stop.order_id);
  for (const [index, orderId] of pickupOrderIds.entries()) {
    const pickup = await fetch(`${baseUrl}/api/orders/${orderId}/status`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "picked_up" }),
    });
    assert.equal(pickup.status, 200);
    const pickupResult = await pickup.json();
    assert.equal(pickupResult.riderRouteReplanned, index === pickupOrderIds.length - 1);

    if (index < pickupOrderIds.length - 1) {
      const prematureDelivery = await fetch(`${baseUrl}/api/rider/agent-1/orders/${orderId}/confirm-delivery`, { method: "POST", body: "{}" });
      assert.equal(prematureDelivery.status, 409);
    }
  }

  const deliveryRoute = await (await fetch(`${baseUrl}/api/rider/agent-1/route`)).json();
  assert.equal(deliveryRoute.routeResult.phase, "delivery");
  assert.deepEqual(deliveryRoute.routeResult.routes[0].stops.map((stop) => stop.type), ["delivery", "delivery"]);
  const lastPickedOrder = activeRoute.orders.find((order) => order.id === pickupOrderIds.at(-1));
  assert.equal(deliveryRoute.routeResult.routes[0].start_location.latitude, lastPickedOrder.restaurant_latitude);
  assert.equal(deliveryRoute.routeResult.routes[0].start_location.longitude, lastPickedOrder.restaurant_longitude);

  for (const [index, orderId] of deliveryRoute.routeResult.routes[0].order_ids.entries()) {
    const currentOrders = await (await fetch(`${baseUrl}/api/orders`)).json();
    const currentOrder = currentOrders.find((item) => item.id === orderId);
    assert.equal(currentOrder.status, "picked_up", `${orderId} should be picked up before delivery`);
    const genericDelivery = await fetch(`${baseUrl}/api/orders/${orderId}/status`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "delivered" }),
    });
    assert.equal(genericDelivery.status, 409);

    const riderConfirmation = await fetch(`${baseUrl}/api/rider/agent-1/orders/${orderId}/confirm-delivery`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(riderConfirmation.status, 200, await riderConfirmation.clone().text());
    const confirmation = await riderConfirmation.json();
    assert.equal(confirmation.order.status, "delivered");
    assert.equal(confirmation.routeCompleted, index === deliveryRoute.orders.length - 1);
    if (index === 0) {
      const stillActive = await (await fetch(`${baseUrl}/api/rider/agent-1/route`)).json();
      assert.ok(stillActive.routeResult);
      assert.equal(stillActive.orders.length, deliveryRoute.orders.length - 1);
      assert.equal(stillActive.routeResult.routes[0].stops.length, 1);
      assert.ok(!stillActive.routeResult.routes[0].order_ids.includes(orderId));
      assert.deepEqual(stillActive.routeResult.routes[0].geometry[0], [currentOrder.customer_latitude, currentOrder.customer_longitude]);
      assert.deepEqual(stillActive.routeResult.routes[0].start_location, {
        latitude: currentOrder.customer_latitude,
        longitude: currentOrder.customer_longitude,
      });
    }
  }
  assert.equal((await (await fetch(`${baseUrl}/api/rider/agent-1/route`)).json()).route, null);
  const agents = await (await fetch(`${baseUrl}/api/agents`)).json();
  assert.equal(agents.find((agent) => agent.id === "agent-1").available, 1);
});

test("demo reset clears rider routes before reseeding Indian restaurants", async () => {
  const reset = await fetch(`${baseUrl}/api/admin/reset-demo`, { method: "POST" });
  assert.equal(reset.status, 200);
  const [restaurantsResponse, ordersResponse] = await Promise.all([
    fetch(`${baseUrl}/api/restaurants`), fetch(`${baseUrl}/api/orders?status=pending`),
  ]);
  const restaurants = await restaurantsResponse.json();
  assert.equal(restaurants.length, 5);
  assert.ok(restaurants.some((restaurant) => restaurant.name === "Pari Chowk Tandoor"));
  assert.equal((await ordersResponse.json()).length, 20);
});