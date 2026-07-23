# httpwatch — multi-stage build.
#
# Stage 1 (build) compiles the eBPF object + bundles the exporter JS using the
# yeet vendored toolchain (clang/bpftool/esbuild, ~190MB of cache). None of that
# reaches the final image — stage 2 copies only the built artifacts.
#
# Stage 2 (runtime) is node:*-slim + yeetd + the node server. It carries just the
# compiled probe (bin/probe.bpf.o) and the JS bundle (src/index.jsx), so it's a
# fraction of the size of a single-stage build.

# ---- stage 1: build the exporter (eBPF object + JS bundle) ----
FROM node:22-bookworm AS build

# make drives the build; curl fetches the vendored toolchain. vmlinux.h is
# vendored, so the BPF object compiles without kernel BTF (CO-RE relocates it at
# load time on whatever kernel runs the container).
RUN apt-get update && apt-get install -y --no-install-recommends \
      make curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY agent ./agent
RUN cd agent && make

# ---- stage 2: runtime (yeetd + node server + built artifacts) ----
FROM node:22-bookworm-slim

# OCI labels — `image.source` links the GHCR package to the repo, so it shows up
# in the repo's Packages sidebar and the package page links back to the source.
LABEL org.opencontainers.image.source="https://github.com/yeet-src/httpwatch" \
      org.opencontainers.image.description="httpwatch — a live browser dashboard of the plaintext HTTP crossing a host, captured off the wire by eBPF" \
      org.opencontainers.image.licenses="GPL-2.0"

# yeetd + the yeet CLI come from the official installer (apt repo), which pulls
# yeetd's runtime deps (libelf, …) itself. curl + ca-certificates are for the
# installer; gnupg lets apt verify the yeet repo signature on slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
  && curl -fsSL https://yeet.cx | sh \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the built agent (compiled BPF object + JS bundle + its sources) — the
# ~190MB toolchain cache from stage 1 is left behind.
COPY --from=build /app/agent ./agent
COPY server ./server
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV PORT=8080 \
    AGENT_DIR=/app/agent \
    NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
