FROM mcr.microsoft.com/playwright/python:v1.47.0-noble
WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn playwright==1.47.0 "httpx[http2]"
COPY resolver.py ./
EXPOSE 7788
CMD ["python", "resolver.py"]
