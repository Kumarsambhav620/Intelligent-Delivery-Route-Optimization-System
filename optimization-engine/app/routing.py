import math
import os

import httpx

from app.schemas import Location


def _haversine_meters(left: Location, right: Location) -> int:
    earth_radius_m = 6_371_000
    left_lat, right_lat = math.radians(left.latitude), math.radians(right.latitude)
    delta_lat = right_lat - left_lat
    delta_lon = math.radians(right.longitude - left.longitude)
    value = math.sin(delta_lat / 2) ** 2 + math.cos(left_lat) * math.cos(right_lat) * math.sin(delta_lon / 2) ** 2
    return int(earth_radius_m * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value)))


def distance_time_matrix(locations: list[Location]) -> tuple[list[list[int]], list[list[int]], str]:
    """Return road distance (m), duration (s), and the source label."""
    endpoint = os.getenv("OSRM_BASE_URL", "").rstrip("/")
    if endpoint:
        try:
            coordinates = ";".join(f"{point.longitude},{point.latitude}" for point in locations)
            response = httpx.get(
                f"{endpoint}/table/v1/driving/{coordinates}",
                params={"annotations": "distance,duration"},
                timeout=5.0,
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("code") != "Ok" or not payload.get("distances") or not payload.get("durations"):
                raise ValueError("OSRM returned an incomplete table")
            matrix_size = len(locations)
            raw_distances = payload["distances"]
            raw_durations = payload["durations"]
            if any(
                len(matrix) != matrix_size
                or any(len(row) != matrix_size for row in matrix)
                or any(value is None or not math.isfinite(value) or value < 0 for row in matrix for value in row)
                for matrix in (raw_distances, raw_durations)
            ):
                raise ValueError("OSRM returned an invalid or unreachable route matrix")
            distances = [[int(value) for value in row] for row in raw_distances]
            durations = [[int(value) for value in row] for row in raw_durations]
            return distances, durations, "osrm"
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass

    distances = [[0 for _ in locations] for _ in locations]
    durations = [[0 for _ in locations] for _ in locations]
    for from_index, origin in enumerate(locations):
        for to_index, destination in enumerate(locations):
            if from_index == to_index:
                continue
            road_distance = int(_haversine_meters(origin, destination) * 1.35)
            distances[from_index][to_index] = road_distance
            durations[from_index][to_index] = int(road_distance / 300 * 60)
    return distances, durations, "simulated-straight-line-road-factor"


def route_geometry(locations: list[Location]) -> tuple[list[list[float]] | None, list[dict]]:
    """Return OSRM road geometry and turn steps; never invent road geometry."""
    endpoint = os.getenv("OSRM_BASE_URL", "").rstrip("/")
    if not endpoint or len(locations) < 2:
        return None, []
    try:
        coordinates = ";".join(f"{point.longitude},{point.latitude}" for point in locations)
        response = httpx.get(
            f"{endpoint}/route/v1/driving/{coordinates}",
            params={"overview": "full", "geometries": "geojson", "steps": "true"},
            timeout=5.0,
        )
        response.raise_for_status()
        payload = response.json()
        route = (payload.get("routes") or [None])[0]
        if payload.get("code") != "Ok" or not route:
            return None, []
        raw_geometry = route.get("geometry", {}).get("coordinates", [])
        geometry = [[float(latitude), float(longitude)] for longitude, latitude in raw_geometry]
        if len(geometry) < 2:
            return None, []
        directions = []
        for leg_index, leg in enumerate(route.get("legs", [])):
            for step in leg.get("steps", []):
                maneuver = step.get("maneuver", {})
                road_name = step.get("name") or "local road"
                action = maneuver.get("type", "continue").replace("_", " ")
                modifier = maneuver.get("modifier")
                if action == "depart":
                    instruction = f"Start on {road_name}"
                elif action == "arrive":
                    instruction = "Arrive at the stop"
                elif action == "continue":
                    instruction = f"Continue on {road_name}"
                elif action in {"roundabout", "rotary"}:
                    exit_number = maneuver.get("exit")
                    instruction = f"At the {action}, take exit {exit_number} onto {road_name}" if exit_number else f"Enter the {action} onto {road_name}"
                else:
                    instruction = f"{action} {modifier} onto {road_name}" if modifier else f"{action.title()} onto {road_name}"
                directions.append({
                    "leg_index": leg_index,
                    "instruction": instruction,
                    "distance_m": round(step.get("distance", 0)),
                    "duration_s": round(step.get("duration", 0)),
                })
        return geometry, directions
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return None, []

def nearest_delivery_sequence(start: Location, destinations: list) -> dict:
    locations = [start, *(destination.customer for destination in destinations)]
    distances, durations, source = distance_time_matrix(locations)
    remaining = set(range(1, len(locations)))
    current_node = 0
    elapsed_minutes = 0
    total_distance_m = 0
    total_duration_s = 0
    stops = []

    while remaining:
        next_node = min(remaining, key=lambda node: (durations[current_node][node], distances[current_node][node]))
        destination = destinations[next_node - 1]
        travel_seconds = durations[current_node][next_node]
        elapsed_minutes += (travel_seconds + 59) // 60 + destination.service_minutes
        total_distance_m += distances[current_node][next_node]
        total_duration_s += travel_seconds
        stops.append({
            "order_id": destination.order_id,
            "type": "delivery",
            "location": destination.customer.model_dump(),
            "sequence": len(stops) + 1,
            "estimated_arrival_minutes": elapsed_minutes,
        })
        current_node = next_node
        remaining.remove(next_node)

    ordered_locations = [start, *(Location(**stop["location"]) for stop in stops)]
    geometry, directions = route_geometry(ordered_locations)
    distance_km = total_distance_m / 1000
    driving_minutes = (total_duration_s + 59) // 60
    return {
        "strategy": "nearest-delivery-after-last-pickup",
        "routing_source": source,
        "routes": [{
            "agent_id": "rider",
            "start_location": start.model_dump(),
            "stops": stops,
            "geometry": geometry,
            "directions": directions,
            "order_ids": [stop["order_id"] for stop in stops],
            "total_distance_km": round(distance_km, 2),
            "billable_delivery_distance_km": round(distance_km, 2),
            "estimated_driving_minutes": int(driving_minutes),
            "estimated_completion_minutes": int(elapsed_minutes),
            "total_stops": len(stops),
        }],
        "unassigned_order_ids": [],
        "totals": {
            "orders": len(stops), "agents_used": 1, "distance_km": round(distance_km, 2),
            "driving_minutes": int(driving_minutes), "workload_std_dev": 0,
        },
    }