---
title: TimesFM 3.0 Forecast API
emoji: 📈
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: other
short_description: JSON forecast endpoint for the TimesFM browser extension
---

# TimesFM 3.0 forecast API

Small FastAPI service around Google's [TimesFM 3.0](https://huggingface.co/google/timesfm-3.0-pytorch).
It is the backend for the "TimesFM 趨勢預測" Chrome extension in this repository.

## Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/health`   | `{"status": "ok" | "loading" | "error", ...}` – the extension polls this while a sleeping Space wakes up |
| POST   | `/forecast` | Body `{"series": [[...]], "horizon": 8, "non_negative": true, "quantiles": [0.1, 0.5, 0.9]}` |
| GET    | `/docs`     | OpenAPI UI |

## Configuration (Space → Settings → Variables and secrets)

| Name        | Default                        | Notes |
|-------------|--------------------------------|-------|
| `API_KEY`   | *(empty = no auth)*            | Set as a **secret**; the extension sends it as `X-API-Key` |
| `MODEL_ID`  | `google/timesfm-3.0-pytorch`   | Use `google/timesfm-2.5-200m-pytorch` if you need Apache-2.0 weights |
| `DEVICE`    | auto                           | `cpu` or `cuda` |
| `MAX_HORIZON` / `MAX_SERIES` / `MAX_CONTEXT` / `MIN_CONTEXT` | 64 / 20 / 2048 / 32 | Request limits |

## Running locally

```bash
pip install -r requirements.txt
uvicorn app:app --port 7860
curl -s localhost:7860/health
```

## Notes

* Free **CPU Basic** hardware (2 vCPU / 16 GB) is enough; a forecast of a few series takes seconds.
* The Space sleeps after 48 h without traffic. The first request afterwards downloads the 1.3 GB checkpoint and takes 1–3 minutes; `/health` reports `loading` meanwhile.
* TimesFM 3.0 weights are distributed under the *TimesFM Non-Commercial License v1.0* (non-commercial, non-production use only). Switch `MODEL_ID` to a 2.5 checkpoint (Apache-2.0) for anything else.
