"""TimesFM 3.0 forecast API.

Runs identically on a local machine (``uvicorn app:app --port 7860``) and on a
Hugging Face Space (Docker SDK).  The model is loaded once at startup; every
request is validated, cleaned and forwarded to ``TimesFM3Evaluator.predict_batch``.

Environment variables
---------------------
MODEL_ID      Hugging Face repo id or local checkpoint (default google/timesfm-3.0-pytorch)
DEVICE        "cpu" / "cuda" / unset (auto-detect)
API_KEY       If set, every /forecast call must send header ``X-API-Key``
MAX_HORIZON   Upper bound for the requested horizon (default 64)
MAX_SERIES    Upper bound for series per request (default 20)
MAX_CONTEXT   Longest context kept per series, older points are dropped (default 2048)
MIN_CONTEXT   Shortest context accepted after cleaning (default 32)
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("timesfm-api")

MODEL_ID = os.environ.get("MODEL_ID", "google/timesfm-3.0-pytorch")
DEVICE = os.environ.get("DEVICE") or None
API_KEY = os.environ.get("API_KEY", "")
MAX_HORIZON = int(os.environ.get("MAX_HORIZON", "64"))
MAX_SERIES = int(os.environ.get("MAX_SERIES", "20"))
MAX_CONTEXT = int(os.environ.get("MAX_CONTEXT", "2048"))
MIN_CONTEXT = int(os.environ.get("MIN_CONTEXT", "32"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "8"))

MODEL_QUANTILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]


class _State:
    forecaster: Any = None
    device: str = "unknown"
    load_error: str | None = None
    loading: bool = False
    load_seconds: float | None = None
    lock = threading.Lock()


STATE = _State()


def _load_model() -> None:
    """Loads the model synchronously (runs in a worker thread)."""
    from timesfm3 import ModelConfig, TimesFM3Evaluator  # imported lazily: slow

    STATE.loading = True
    t0 = time.time()
    try:
        config = ModelConfig(
            checkpoint_path=MODEL_ID,
            per_core_batch_size=BATCH_SIZE,
            device=DEVICE,
        )
        forecaster = TimesFM3Evaluator(config)
        STATE.forecaster = forecaster
        STATE.device = str(getattr(forecaster, "device", DEVICE or "auto"))
        STATE.load_seconds = round(time.time() - t0, 1)
        log.info("model %s loaded on %s in %ss", MODEL_ID, STATE.device, STATE.load_seconds)
    except Exception as exc:  # noqa: BLE001
        STATE.load_error = f"{type(exc).__name__}: {exc}"
        log.exception("model load failed")
    finally:
        STATE.loading = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Kick off loading in the background so /health answers immediately.
    task = asyncio.get_event_loop().run_in_executor(None, _load_model)
    yield
    await task


app = FastAPI(title="TimesFM 3.0 forecast API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def allow_private_network(request, call_next):
    """Lets an https page call a localhost instance during development (Chrome PNA preflight)."""
    response = await call_next(request)
    if request.method == "OPTIONS":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# --------------------------------------------------------------------------- auth
def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


# ------------------------------------------------------------------------ schemas
class ForecastRequest(BaseModel):
    series: list[list[float | None]] = Field(..., description="One list of values per series; null = missing")
    horizon: int = Field(8, ge=1, description="Number of steps to forecast")
    non_negative: bool = Field(True, description="Clamp forecasts at zero (counts, rates)")
    quantiles: list[float] = Field(default=[0.1, 0.5, 0.9], description="Subset of 0.1..0.9 to return")

    @field_validator("quantiles")
    @classmethod
    def _check_quantiles(cls, qs: list[float]) -> list[float]:
        for q in qs:
            if not any(math.isclose(q, mq) for mq in MODEL_QUANTILES):
                raise ValueError(f"quantile {q} not in {MODEL_QUANTILES}")
        return qs


class SeriesResult(BaseModel):
    point: list[float]
    quantiles: dict[str, list[float]]
    context_length: int


class ForecastResponse(BaseModel):
    model: str
    device: str
    horizon: int
    results: list[SeriesResult]
    elapsed_ms: int


# ------------------------------------------------------------------------ helpers
def _clean_series(values: list[float | None], idx: int) -> np.ndarray:
    """Drops trailing/leading missing values, interpolates interior gaps, truncates."""
    arr = np.array([np.nan if v is None else float(v) for v in values], dtype=np.float64)
    finite = np.isfinite(arr)
    if not finite.any():
        raise HTTPException(status_code=422, detail=f"series[{idx}] has no finite values")
    first, last = int(np.argmax(finite)), int(len(arr) - 1 - np.argmax(finite[::-1]))
    arr = arr[first : last + 1]
    finite = np.isfinite(arr)
    if not finite.all():
        xs = np.arange(len(arr))
        arr = np.interp(xs, xs[finite], arr[finite])
    if len(arr) > MAX_CONTEXT:
        arr = arr[-MAX_CONTEXT:]
    if len(arr) < MIN_CONTEXT:
        raise HTTPException(
            status_code=422,
            detail=f"series[{idx}] has {len(arr)} usable points, need at least {MIN_CONTEXT}",
        )
    return arr


def _run_forecast(contexts: list[np.ndarray], horizon: int, non_negative: bool) -> list[Any]:
    with STATE.lock:  # one inference at a time keeps memory bounded on a 16 GB Space
        return list(
            STATE.forecaster.predict_batch(
                contexts=contexts,
                horizon=horizon,
                return_quantiles=True,
                use_symmetric_averaging=False,
                make_positive=non_negative,
                sort_quantiles=True,
            )
        )


def _to_list(a: np.ndarray, non_negative: bool) -> list[float]:
    a = np.asarray(a, dtype=np.float64)
    if non_negative:
        a = np.maximum(a, 0.0)
    return [round(float(v), 6) for v in a]


# ------------------------------------------------------------------------- routes
@app.get("/health")
def health() -> dict[str, Any]:
    ready = STATE.forecaster is not None
    return {
        "status": "ok" if ready else ("error" if STATE.load_error else "loading"),
        "model": MODEL_ID,
        "device": STATE.device if ready else None,
        "load_seconds": STATE.load_seconds,
        "error": STATE.load_error,
        "limits": {
            "max_horizon": MAX_HORIZON,
            "max_series": MAX_SERIES,
            "max_context": MAX_CONTEXT,
            "min_context": MIN_CONTEXT,
        },
    }


@app.post("/forecast", response_model=ForecastResponse, dependencies=[Depends(require_api_key)])
async def forecast(req: ForecastRequest) -> ForecastResponse:
    if STATE.forecaster is None:
        if STATE.load_error:
            raise HTTPException(status_code=500, detail=f"model failed to load: {STATE.load_error}")
        raise HTTPException(status_code=503, detail="model is still loading, retry shortly")
    if req.horizon > MAX_HORIZON:
        raise HTTPException(status_code=422, detail=f"horizon must be <= {MAX_HORIZON}")
    if not req.series:
        raise HTTPException(status_code=422, detail="series must not be empty")
    if len(req.series) > MAX_SERIES:
        raise HTTPException(status_code=422, detail=f"at most {MAX_SERIES} series per request")

    contexts = [_clean_series(s, i) for i, s in enumerate(req.series)]

    t0 = time.time()
    outputs = await asyncio.to_thread(_run_forecast, contexts, req.horizon, req.non_negative)
    elapsed_ms = int((time.time() - t0) * 1000)

    results: list[SeriesResult] = []
    for ctx, out in zip(contexts, outputs):
        point = np.asarray(out.forecast).reshape(-1)[: req.horizon]
        q = np.asarray(out.quantiles).reshape(req.horizon, -1)  # (horizon, 9)
        qdict = {}
        for want in req.quantiles:
            col = min(range(len(MODEL_QUANTILES)), key=lambda i: abs(MODEL_QUANTILES[i] - want))
            qdict[f"{MODEL_QUANTILES[col]:.1f}"] = _to_list(q[:, col], req.non_negative)
        results.append(
            SeriesResult(point=_to_list(point, req.non_negative), quantiles=qdict, context_length=len(ctx))
        )

    log.info("forecast: %d series, horizon %d, %d ms", len(contexts), req.horizon, elapsed_ms)
    return ForecastResponse(
        model=MODEL_ID, device=STATE.device, horizon=req.horizon, results=results, elapsed_ms=elapsed_ms
    )


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return f"""<!doctype html><meta charset="utf-8"><title>TimesFM forecast API</title>
<body style="font-family:system-ui;max-width:720px;margin:2rem auto;line-height:1.5">
<h1>TimesFM forecast API</h1>
<p>Model: <code>{MODEL_ID}</code> &middot; <a href="/health">/health</a> &middot; <a href="/docs">OpenAPI docs</a></p>
<pre>POST /forecast
X-API-Key: &lt;key&gt;   (only if the server was started with API_KEY)
{{"series": [[1, 2, 3, ...]], "horizon": 8, "non_negative": true, "quantiles": [0.1, 0.5, 0.9]}}</pre>
<p>Weights of TimesFM&nbsp;3.0 are released under a non-commercial license. This endpoint is for personal research use.</p>
</body>"""
