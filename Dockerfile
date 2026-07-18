# syntax=docker/dockerfile:1
FROM rust:bookworm AS builder-base

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY assets ./assets

FROM builder-base AS builder-musl

ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends musl-tools pkg-config \
    && rm -rf /var/lib/apt/lists/*
ENV CC_x86_64_unknown_linux_musl=musl-gcc
ENV CC_aarch64_unknown_linux_musl=musl-gcc
RUN case "$TARGETARCH" in \
        amd64) rust_target=x86_64-unknown-linux-musl ;; \
        arm64) rust_target=aarch64-unknown-linux-musl ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$rust_target" \
    && cargo build --locked --release --target "$rust_target" \
    && mkdir -p /out \
    && cp "/src/target/$rust_target/release/lowkey-gallery" /out/gallery

FROM alpine:latest AS runtime-alpine

RUN addgroup -g 10001 -S gallery \
    && adduser -S -D -H -u 10001 -G gallery -s /sbin/nologin gallery \
    && mkdir -p /pictures /data \
    && chown gallery:gallery /data

COPY --from=builder-musl /out/gallery /usr/local/bin/gallery

ENV GALLERY_ROOT=/pictures \
    GALLERY_DATA=/data \
    GALLERY_BIND=0.0.0.0:3002 \
    RUST_LOG=info

VOLUME ["/pictures", "/data"]
EXPOSE 3002
USER gallery

ENTRYPOINT ["/usr/local/bin/gallery"]

FROM runtime-alpine AS runtime
