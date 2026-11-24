from app.routing import distance_time_matrix, nearest_delivery_sequence
from fastapi import FastAPI, HTTPException

from app.optimizer import InfeasibleRouteError, optimize
from app.schemas import OptimizationRequest
from app.schemas import DeliverySequenceRequest, OptimizationRequest

app = FastAPI(title="Food Delivery Optimization Engine", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "optimization-engine"}

@app.post("/route/delivery-sequence")
def route_delivery_sequence(request: DeliverySequenceRequest):
    return nearest_delivery_sequence(request.start, request.destinations)


@app.post("/optimize/{strategy}")
def run_optimization(strategy: str, request: OptimizationRequest):
    if strategy not in {"distance", "time", "profit", "balanced"}:
        raise HTTPException(status_code=404, detail="Unknown optimization strategy")
    request.strategy = strategy
    try:
        return optimize(request)
    except InfeasibleRouteError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error