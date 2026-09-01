# syntax=docker/dockerfile:1

FROM scratch AS model-base

# Keep these pinned artifacts in sync with src/text_search/download.rs and the
# release workflow. Registry compression and content-addressing make these
# layers reusable until the model revision changes.
ADD --checksum=sha256:29cc0b2bcf6ff777f2e15742be92b110e4acbdb2068356e862c4637a4b15fe4f \
    https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e/model.safetensors \
    /opt/pixhelf/models/chinese-clip-vit-base-patch16-f4a64596/model.safetensors
ADD --checksum=sha256:45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c \
    https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e/vocab.txt \
    /opt/pixhelf/models/chinese-clip-vit-base-patch16-f4a64596/vocab.txt

FROM model-base

ARG TARGETARCH
ARG VERSION
ARG REVISION
ARG SOURCE_URL

LABEL org.opencontainers.image.title="Pixhelf" \
      org.opencontainers.image.description="Self-hosted image gallery" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}"

ENV PIXHELF_TEXT_SEARCH_MODEL=/opt/pixhelf/models/chinese-clip-vit-base-patch16-f4a64596

COPY --chmod=0755 dist/pixhelf-${TARGETARCH}-linux /pixhelf

WORKDIR /data
EXPOSE 3002

ENTRYPOINT ["/pixhelf"]
