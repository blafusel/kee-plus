FROM python:3.13-alpine
WORKDIR /app
COPY server.py files.py ./
COPY public ./public
ENV MYNOTES_DB=/data/notes.db PORT=8080 PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8080
CMD ["python", "server.py"]
