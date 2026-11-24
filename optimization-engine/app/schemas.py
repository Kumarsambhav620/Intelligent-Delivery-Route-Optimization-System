from typing import Literal

from pydantic import BaseModel, Field, model_validator


class Location(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class DeliveryOrder(BaseModel):
    id: str = Field(min_length=1)
    restaurant: Location
    customer: Location
    quantity: int = Field(default=1, ge=1)
    revenue: float = Field(default=0, ge=0)
    preparation_minutes: int = Field(default=0, ge=0)
    window_start_minutes: int = Field(default=0, ge=0)
    window_end_minutes: int = Field(default=240, ge=1)
    priority: int = Field(default=1, ge=1, le=5)
    service_minutes: int = Field(default=3, ge=0)

    @model_validator(mode="after")
    def validate_window(self):
        if self.window_end_minutes <= self.window_start_minutes:
            raise ValueError("Delivery window end must be after its start")
        return self


class DeliveryAgent(BaseModel):
    id: str = Field(min_length=1)
    location: Location
    capacity: int = Field(default=3, ge=1)
    max_shift_minutes: int = Field(default=480, ge=1)
    available: bool = True


class OptimizationRequest(BaseModel):
    orders: list[DeliveryOrder]
    agents: list[DeliveryAgent]
    strategy: Literal["distance", "time", "profit", "balanced"] = "balanced"
    cost_per_km: float = Field(default=12, ge=0)
    late_penalty_per_minute: float = Field(default=2, ge=0)
    agent_incentive: float = Field(default=0, ge=0)
    solve_seconds: int = Field(default=4, ge=1, le=30)

    @model_validator(mode="after")
    def validate_problem(self):
        if len({order.id for order in self.orders}) != len(self.orders):
            raise ValueError("Order IDs must be unique")
        if len({agent.id for agent in self.agents}) != len(self.agents):
            raise ValueError("Agent IDs must be unique")
        if any(order.quantity > max((agent.capacity for agent in self.agents), default=0) for order in self.orders):
            raise ValueError("An order exceeds every available vehicle capacity")
        return self

class DeliveryDestination(BaseModel):
    order_id: str = Field(min_length=1)
    customer: Location
    service_minutes: int = Field(default=3, ge=0)

class DeliverySequenceRequest(BaseModel):
    start: Location
    destinations: list[DeliveryDestination] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_destinations(self):
        if len({destination.order_id for destination in self.destinations}) != len(self.destinations):
            raise ValueError("Destination order IDs must be unique")
        return self