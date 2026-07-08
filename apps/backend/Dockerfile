# syntax=docker/dockerfile:1
FROM rust:1.88-slim-bookworm AS builder
WORKDIR /app
COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --package backend && \
    cp target/release/backend /app/backend-bin

FROM gcr.io/distroless/cc-debian12:latest
WORKDIR /app
COPY --from=builder /app/backend-bin /app/backend
EXPOSE 3000
CMD ["/app/backend"]
