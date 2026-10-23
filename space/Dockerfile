# TimesFM 3.0 forecast API for Hugging Face Spaces (Docker SDK) or any host.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/home/user/.cache/huggingface \
    PORT=7860

WORKDIR /tmp/build
COPY requirements.txt .
# CPU-only torch keeps the image small; on a GPU host drop the extra index.
RUN pip install --upgrade "pip>=26.2.2" \
 && pip install --extra-index-url https://download.pytorch.org/whl/cpu torch \
 && pip install -r requirements.txt

# Spaces run the container as uid 1000.
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user/app
COPY --chown=user app.py .

EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
