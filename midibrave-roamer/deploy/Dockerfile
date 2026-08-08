# Spark-local immutable GPU/audio base. It already contains CUDA, PyTorch,
# aiohttp, NumPy, SciPy, soundfile and the audited runtime dependency set.
FROM flock-audio:5f5f49c83eb0d0c95fc16c5e56b4778e02790b09-138b077ba1ed

WORKDIR /app
COPY flock-voice-engine/server /app/flock-voice-engine/server
COPY flock-voice-engine/client /app/flock-voice-engine/client
COPY flock-voice-engine/assets /app/flock-voice-engine/assets
COPY midibrave-roamer /app/midibrave-roamer
RUN python3 /app/midibrave-roamer/scripts/assemble.py

ENV PYTHONPATH=/app/flock-voice-engine
EXPOSE 8092
ENTRYPOINT ["python3", "/app/midibrave-roamer/scripts/serve.py"]
CMD ["--backend", "neural", "--host", "0.0.0.0", "--port", "8092", "--skip-assemble"]
