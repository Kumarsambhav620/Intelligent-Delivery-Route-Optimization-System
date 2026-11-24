from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from app.routing import distance_time_matrix, route_geometry
from app.schemas import Location, OptimizationRequest


class InfeasibleRouteError(Exception):
    pass


def optimize(request: OptimizationRequest) -> dict:
    agents = [agent for agent in request.agents if agent.available]
    if request.orders and not agents:
        raise InfeasibleRouteError("No available delivery agents can accept these orders")
    if not request.orders:
        return {"strategy": request.strategy, "routes": [], "unassigned_order_ids": [], "totals": _empty_totals(), "routing_source": "not-required"}

    locations = [agent.location for agent in agents]
    pickup_nodes: dict[str, int] = {}
    delivery_nodes: dict[str, int] = {}
    for order in request.orders:
        pickup_nodes[order.id] = len(locations)
        locations.append(order.restaurant)
        delivery_nodes[order.id] = len(locations)
        locations.append(order.customer)

    distances, durations, source = distance_time_matrix(locations)
    manager = pywrapcp.RoutingIndexManager(len(locations), len(agents), list(range(len(agents))), list(range(len(agents))))
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index: int, to_index: int) -> int:
        return distances[manager.IndexToNode(from_index)][manager.IndexToNode(to_index)]

    def time_callback(from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        service_minutes = 0
        for order in request.orders:
            if from_node == pickup_nodes[order.id] or from_node == delivery_nodes[order.id]:
                service_minutes = order.service_minutes
                break
        travel_minutes = durations[from_node][manager.IndexToNode(to_index)] // 60
        return travel_minutes + service_minutes

    distance_callback_index = routing.RegisterTransitCallback(distance_callback)
    time_callback_index = routing.RegisterTransitCallback(time_callback)
    if request.strategy == "distance":
        routing.SetArcCostEvaluatorOfAllVehicles(distance_callback_index)
    elif request.strategy == "time":
        routing.SetArcCostEvaluatorOfAllVehicles(time_callback_index)
    elif request.strategy == "profit":
        def operating_cost_callback(from_index: int, to_index: int) -> int:
            meters = distance_callback(from_index, to_index)
            minutes = time_callback(from_index, to_index)
            return int(meters * request.cost_per_km / 10) + minutes * int(request.late_penalty_per_minute)

        routing.SetArcCostEvaluatorOfAllVehicles(routing.RegisterTransitCallback(operating_cost_callback))
        for vehicle_index in range(len(agents)):
            routing.SetFixedCostOfVehicle(int(request.agent_incentive * 100), vehicle_index)
    else:
        def balanced_callback(from_index: int, to_index: int) -> int:
            return distance_callback(from_index, to_index) + time_callback(from_index, to_index) * 80

        routing.SetArcCostEvaluatorOfAllVehicles(routing.RegisterTransitCallback(balanced_callback))

    demands = [0] * len(locations)
    for order in request.orders:
        demands[pickup_nodes[order.id]] = order.quantity
        demands[delivery_nodes[order.id]] = -order.quantity

    def demand_callback(from_index: int) -> int:
        return demands[manager.IndexToNode(from_index)]

    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,
        [agent.capacity for agent in agents],
        True,
        "Capacity",
    )
    max_shift = max(agent.max_shift_minutes for agent in agents)
    routing.AddDimension(time_callback_index, max_shift, max_shift, True, "Time")
    time_dimension = routing.GetDimensionOrDie("Time")
    for vehicle_index, agent in enumerate(agents):
        time_dimension.CumulVar(routing.End(vehicle_index)).SetMax(agent.max_shift_minutes)
    if request.strategy == "balanced":
        time_dimension.SetGlobalSpanCostCoefficient(500)

    for order in request.orders:
        pickup = manager.NodeToIndex(pickup_nodes[order.id])
        delivery = manager.NodeToIndex(delivery_nodes[order.id])
        routing.AddPickupAndDelivery(pickup, delivery)
        routing.solver().Add(routing.VehicleVar(pickup) == routing.VehicleVar(delivery))
        routing.solver().Add(time_dimension.CumulVar(pickup) >= order.preparation_minutes)
        routing.solver().Add(time_dimension.CumulVar(delivery) >= order.window_start_minutes)
        routing.solver().Add(time_dimension.CumulVar(delivery) <= order.window_end_minutes)
        routing.solver().Add(time_dimension.CumulVar(pickup) <= time_dimension.CumulVar(delivery))

    parameters = pywrapcp.DefaultRoutingSearchParameters()
    parameters.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    parameters.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    parameters.time_limit.FromSeconds(request.solve_seconds)
    solution = routing.SolveWithParameters(parameters)
    if solution is None:
        raise InfeasibleRouteError("No feasible route satisfies the capacity, shift, pickup and delivery-window constraints")

    routes = []
    assigned_orders: set[str] = set()
    for vehicle_index, agent in enumerate(agents):
        index = routing.Start(vehicle_index)
        stops = []
        route_distance_m = 0
        route_duration_minutes = 0
        route_order_ids: set[str] = set()
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            next_index = solution.Value(routing.NextVar(index))
            next_node = manager.IndexToNode(next_index)
            route_distance_m += distances[node][next_node]
            route_duration_minutes += durations[node][next_node] // 60
            if node in pickup_nodes.values() or node in delivery_nodes.values():
                order = next((item for item in request.orders if pickup_nodes[item.id] == node or delivery_nodes[item.id] == node), None)
                if order:
                    is_pickup = pickup_nodes[order.id] == node
                    stops.append({
                        "order_id": order.id,
                        "type": "pickup" if is_pickup else "delivery",
                        "location": (order.restaurant if is_pickup else order.customer).model_dump(),
                        "sequence": len(stops) + 1,
                        "estimated_arrival_minutes": solution.Value(time_dimension.CumulVar(index)),
                    })
                    route_order_ids.add(order.id)
                    assigned_orders.add(order.id)
            index = next_index
        if not stops:
            continue
        route_locations = [agent.location, *(Location(**stop["location"]) for stop in stops), agent.location]
        geometry, directions = route_geometry(route_locations)
        revenue = sum(order.revenue for order in request.orders if order.id in route_order_ids)
        distance_km = route_distance_m / 1000
        billable_distance_km = sum(
            distances[pickup_nodes[order.id]][delivery_nodes[order.id]]
            for order in request.orders
            if order.id in route_order_ids
        ) / 1000
        completion_minutes = solution.Value(time_dimension.CumulVar(index))
        operating_cost = distance_km * request.cost_per_km + request.agent_incentive
        workload_points = distance_km + len(route_order_ids) * 2 + route_duration_minutes / 10
        routes.append({
            "agent_id": agent.id,
            "start_location": agent.location.model_dump(),
            "stops": stops,
            "geometry": geometry,
            "directions": directions,
            "order_ids": sorted(route_order_ids),
            "total_distance_km": round(distance_km, 2),
            "billable_delivery_distance_km": round(billable_distance_km, 2),
            "estimated_driving_minutes": route_duration_minutes,
            "estimated_completion_minutes": completion_minutes,
            "total_stops": len(stops),
            "workload_points": round(workload_points, 2),
            "estimated_revenue": round(revenue, 2),
            "estimated_cost": round(operating_cost, 2),
            "estimated_profit": round(revenue - operating_cost, 2),
        })

    unassigned = sorted({order.id for order in request.orders} - assigned_orders)
    total_distance = sum(route["total_distance_km"] for route in routes)
    total_revenue = sum(route["estimated_revenue"] for route in routes)
    total_cost = sum(route["estimated_cost"] for route in routes)
    route_workloads = {route["agent_id"]: route["workload_points"] for route in routes}
    workloads = [route_workloads.get(agent.id, 0) for agent in agents]
    average_workload = sum(workloads) / len(workloads) if workloads else 0
    workload_std_dev = (sum((value - average_workload) ** 2 for value in workloads) / len(workloads)) ** 0.5 if workloads else 0
    return {
        "strategy": request.strategy,
        "routes": routes,
        "unassigned_order_ids": unassigned,
        "routing_source": source,
        "totals": {
            "orders": len(assigned_orders),
            "agents_used": len(routes),
            "distance_km": round(total_distance, 2),
            "driving_minutes": sum(route["estimated_driving_minutes"] for route in routes),
            "revenue": round(total_revenue, 2),
            "operating_cost": round(total_cost, 2),
            "estimated_profit": round(total_revenue - total_cost, 2),
            "workload_average": round(average_workload, 2),
            "workload_std_dev": round(workload_std_dev, 2),
        },
    }


def _empty_totals() -> dict:
    return {"orders": 0, "agents_used": 0, "distance_km": 0, "driving_minutes": 0, "revenue": 0, "operating_cost": 0, "estimated_profit": 0, "workload_average": 0, "workload_std_dev": 0}