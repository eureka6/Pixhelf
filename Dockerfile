# syntax=docker/dockerfile:1

FROM scratch

ARG TARGETARCH
ARG VERSION
ARG REVISION
ARG SOURCE_URL

LABEL org.opencontainers.image.title="Pixhelf" \
      org.opencontainers.image.description="Self-hosted image gallery" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}"

COPY --chmod=0755 dist/pixhelf-${TARGETARCH}-linux /pixhelf

WORKDIR /data
EXPOSE 3002

ENTRYPOINT ["/pixhelf"]
