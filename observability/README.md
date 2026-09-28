# SigNoz observability

This directory contains the declarative SigNoz installation for the project.
SigNoz runs as a separate observability stack; the backend sends request traces
to its OpenTelemetry (OTLP) receiver.

## Install SigNoz

Install `foundryctl` using the [official Docker installation guide](https://signoz.io/docs/install/docker/), then run:

```sh
cd observability
foundryctl forge -f casting.yaml
docker compose -f pours/deployment/compose.yaml config --quiet
foundryctl cast -f casting.yaml
```

The generated deployment is written under `observability/pours/` and is not
tracked by Git. The SigNoz UI is available at `http://localhost:8080`.
SigNoz needs at least 4 GB of memory. Its OTLP receivers use port `4317` for
gRPC and `4318` for HTTP. The casting binds published UI and OTLP ports to
`127.0.0.1`; the backend can reach the collector over the private Docker network.

## Send backend traces

The backend exports traces only when an OTLP endpoint is configured. Without
one, it continues using its existing console tracing. Configure these variables
in `.env`:

```env
OTEL_SERVICE_NAME=albion-guild-manager-backend
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

From the repository root, run the backend directly with:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 cargo run -p backend
```

Use the endpoint appropriate for where the backend runs:

- Backend started directly on the host with `cargo run`: `http://localhost:4317`.
- Backend in this repository's Docker Compose stack: use
  `http://signoz-ingester:4317` and start it with the private-network overlay:

  ```sh
  docker compose \
    -f docker-compose.yml \
    -f observability/docker-compose.otel.yml \
    up -d backend
  ```

  The overlay attaches only the backend to SigNoz's internal Docker network.
  Make sure the backend image used by Compose was built from this version of
  the source; the existing Compose service uses a prebuilt image.
- Backend and SigNoz on different machines: use the collector's private
  hostname or IP and secure the connection with TLS.

After changing the environment, restart the backend. Generate a request (for
example, open `/scalar` on the backend), then look for
`albion-guild-manager-backend` under **APM → Services** in SigNoz.

The exported HTTP spans include the method, Axum route template, response
status, and duration. They intentionally exclude raw request paths, query
strings, and `tracing` events to avoid sending identifiers or OAuth values.
Console logs remain unchanged; this initial integration exports traces only,
not application metrics.

## Production notes

- Keep OTLP ports `4317` and `4318` private to the application/collector network;
  do not expose them to the public internet.
- The casting binds the SigNoz UI to loopback too; use an authenticated TLS
  reverse proxy or an SSH tunnel for remote administration.
- Keep `OTEL_EXPORTER_OTLP_ENDPOINT` unset to disable trace export. A malformed
  exporter configuration logs a warning and does not prevent the backend from
  starting.
- Self-hosted SigNoz does not require an ingestion key. Do not put credentials,
  cookies, or tokens in span attributes.

See the [self-hosted OTLP ingestion guide](https://signoz.io/docs/ingestion/self-hosted/overview/)
for endpoint details and the [Rust instrumentation guide](https://signoz.io/docs/instrumentation/opentelemetry-rust/)
for additional instrumentation options.
