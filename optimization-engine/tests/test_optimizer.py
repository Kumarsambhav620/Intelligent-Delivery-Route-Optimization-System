from app.routing import route_geometry
from app.routing import nearest_delivery_sequence, route_geometry
from app.optimizer import InfeasibleRouteError, optimize
from app.schemas import DeliveryAgent, DeliveryDestination, DeliveryOrder, Location, OptimizationRequest


def test_routes_preserve_pickup_delivery_order_and_capacity():
    restaurant = Location(latitude=28.4744, longitude=77.5040)
    orders = [
        DeliveryOrder(id="order-1", restaurant=restaurant, customer=Location(latitude=28.4700, longitude=77.5100), quantity=1, revenue=180, window_end_minutes=180),
        DeliveryOrder(id="order-2", restaurant=restaurant, customer=Location(latitude=28.4680, longitude=77.5120), quantity=1, revenue=220, window_end_minutes=180),
    ]
    agents = [
        DeliveryAgent(id="agent-1", location=Location(latitude=28.4760, longitude=77.5020), capacity=2),
        DeliveryAgent(id="agent-2", location=Location(latitude=28.4800, longitude=77.5000), capacity=1),
    ]

    result = optimize(OptimizationRequest(orders=orders, agents=agents, strategy="balanced", solve_seconds=1))

    assert result["totals"]["orders"] == 2
    assert result["unassigned_order_ids"] == []
    assert all(route["billable_delivery_distance_km"] > 0 for route in result["routes"])
    assert all(route["estimated_completion_minutes"] >= route["estimated_driving_minutes"] for route in result["routes"])
    for route in result["routes"]:
        order_positions = {}
        for index, stop in enumerate(route["stops"]):
            order_positions.setdefault(stop["order_id"], {})[stop["type"]] = index
        assert all(positions["pickup"] < positions["delivery"] for positions in order_positions.values())
        assert len(route["order_ids"]) <= 2
    assert result["routing_source"].startswith("simulated-")


def test_agent_shift_limit_makes_overlong_route_infeasible():
    order = DeliveryOrder(
        id="long-route",
        restaurant=Location(latitude=28.4744, longitude=77.5040),
        customer=Location(latitude=28.4944, longitude=77.5040),
        window_end_minutes=180,
    )
    agent = DeliveryAgent(
        id="short-shift-agent",
        location=Location(latitude=28.4760, longitude=77.5020),
        max_shift_minutes=1,
    )

    try:
        optimize(OptimizationRequest(orders=[order], agents=[agent], solve_seconds=1))
    except InfeasibleRouteError as error:
        assert "No feasible route" in str(error)
    else:
        raise AssertionError("Expected the route to exceed the agent shift limit")


def test_balanced_strategy_uses_multiple_agents_for_several_orders():
    restaurant = Location(latitude=28.4744, longitude=77.5040)
    orders = [
        DeliveryOrder(
            id=f"order-{index}",
            restaurant=restaurant,
            customer=Location(latitude=28.4700 + index * 0.001, longitude=77.5100),
            window_end_minutes=180,
        )
        for index in range(6)
    ]
    agents = [
        DeliveryAgent(id=f"agent-{index}", location=Location(latitude=28.4760, longitude=77.5020), capacity=2)
        for index in range(3)
    ]

    result = optimize(OptimizationRequest(orders=orders, agents=agents, strategy="balanced", solve_seconds=2))

    assert result["totals"]["orders"] == len(orders)
    assert result["totals"]["agents_used"] > 1


def test_osrm_directions_include_leg_indices_and_readable_maneuvers(monkeypatch):
    monkeypatch.setenv("OSRM_BASE_URL", "https://osrm.test")

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "code": "Ok",
                "routes": [{
                    "geometry": {"coordinates": [[77.0, 28.0], [77.1, 28.1]]},
                    "legs": [
                        {"steps": [
                            {"name": "Alpha Road", "distance": 120, "duration": 12, "maneuver": {"type": "depart"}},
                            {"name": "Market Road", "distance": 500, "duration": 50, "maneuver": {"type": "turn", "modifier": "left"}},
                        ]},
                        {"steps": [
                            {"name": "", "distance": 0, "duration": 0, "maneuver": {"type": "arrive"}},
                        ]},
                    ],
                }],
            }

    monkeypatch.setattr("app.routing.httpx.get", lambda *args, **kwargs: Response())
    geometry, directions = route_geometry([
        Location(latitude=28.0, longitude=77.0),
        Location(latitude=28.1, longitude=77.1),
    ])

    assert geometry == [[28.0, 77.0], [28.1, 77.1]]
    assert directions[0]["instruction"] == "Start on Alpha Road"
    assert directions[1]["instruction"] == "turn left onto Market Road"
    assert [step["leg_index"] for step in directions] == [0, 0, 1]

def test_delivery_sequence_chooses_nearest_next_stop_from_last_pickup(monkeypatch):
    import app.routing as routing

    distances = [
        [0, 900, 200, 500],
        [900, 0, 800, 100],
        [200, 800, 0, 700],
        [500, 100, 700, 0],
    ]
    durations = [
        [0, 90, 20, 50],
        [90, 0, 80, 10],
        [20, 80, 0, 70],
        [50, 10, 70, 0],
    ]
    monkeypatch.setattr(routing, "distance_time_matrix", lambda locations: (distances, durations, "osrm"))
    monkeypatch.setattr(routing, "route_geometry", lambda locations: ([[point.latitude, point.longitude] for point in locations], []))
    destinations = [
        DeliveryDestination(order_id="far", customer=Location(latitude=28.49, longitude=77.51)),
        DeliveryDestination(order_id="nearest", customer=Location(latitude=28.471, longitude=77.501)),
        DeliveryDestination(order_id="after-nearest", customer=Location(latitude=28.48, longitude=77.505)),
    ]

    result = nearest_delivery_sequence(Location(latitude=28.474, longitude=77.504), destinations)

    assert result["routes"][0]["order_ids"] == ["nearest", "after-nearest", "far"]
    assert result["routes"][0]["stops"][0]["sequence"] == 1
    assert result["routes"][0]["start_location"] == Location(latitude=28.474, longitude=77.504).model_dump()
    assert result["routing_source"] == "osrm"