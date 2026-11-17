import pytest
from pydantic import ValidationError

from ratelimiter.domain.models import Algorithm, Plan, PlanLimit, Policy, Scope


def test_window_algorithm_requires_window():
    with pytest.raises(ValidationError):
        Policy(name="x", algorithm=Algorithm.FIXED_WINDOW, scope=Scope.IP, plans={},
               default=PlanLimit(limit=5, rate_per_second=1))


def test_bucket_algorithm_requires_rate():
    with pytest.raises(ValidationError):
        Policy(name="x", algorithm=Algorithm.TOKEN_BUCKET, scope=Scope.IP, plans={},
               default=PlanLimit(limit=5, window_seconds=1))


def test_plan_fallback_to_default():
    p = Policy(name="x", algorithm=Algorithm.FIXED_WINDOW, scope=Scope.USER,
               plans={Plan.PRO: PlanLimit(limit=100, window_seconds=60)},
               default=PlanLimit(limit=10, window_seconds=60))
    assert p.limit_for(Plan.PRO).limit == 100
    assert p.limit_for(Plan.FREE).limit == 10


def test_limit_must_be_positive():
    with pytest.raises(ValidationError):
        PlanLimit(limit=0, window_seconds=1)
