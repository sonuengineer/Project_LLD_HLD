from bpcommon.errors import AppError


class PlanLimitReached(AppError):
    status_code, code = 403, "plan_limit_reached"


class FeatureNotInPlan(AppError):
    status_code, code = 403, "feature_not_in_plan"


class QuotaExceeded(AppError):
    status_code, code = 429, "quota_exceeded"
