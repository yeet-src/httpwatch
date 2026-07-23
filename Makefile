# httpwatch — build + run the whole thing (yeetd + server + probe).
#
#   make run     build the image and run it in the FOREGROUND (Ctrl-C to stop).
#                Best for a quick look — you see the logs live.
#   make up      build and run DETACHED with --restart unless-stopped (survives
#                reboots). Use this for a persistent deployment.
#   make down    stop and remove the detached container.
#   make logs    follow the detached container's logs.
#   make build   just build the image.
#
# The container runs with scoped caps (SYS_ADMIN for the bpffs mount, NET_ADMIN
# for the TCX attach, BPF + PERFMON for the program load), --security-opt
# apparmor=unconfined (the default profile denies the mount), and --pid=host
# --network=host — no --privileged. It mounts its OWN bpffs at /opt/fs/bpf on
# startup (docker/entrypoint.sh) and points yeetd there with --bpf-fs, since
# /sys is locked read-only for non-privileged containers. The only bind mount is
# the host's kernel BTF (read-only, for CO-RE); nothing else is shared. Host
# networking lets the probe attach to the real host interfaces and binds the
# server to the host's PORT.
# Open http://localhost:8080 (or your host over the network).
#
# Requirements: Linux with BTF + TCX (kernel 6.6+), Docker, and the ability to
# grant those caps. Not macOS/Windows Docker Desktop (that's a VM —
# you'd inspect the VM, not your host). See README.md.

.PHONY: run up down logs build
.DEFAULT_GOAL := run

IMAGE ?= httpwatch
NAME  ?= httpwatch
PORT  ?= 8080

# Optional passthroughs:
#   IFACE=lo,eth0      watch only these interfaces (default: all up ifaces)
#   KEEP_QUERY=true    keep query strings distinct instead of collapsing them
#   YEET_AUTH_KEY=...  register the host with the yeet control plane on startup
IFACE         ?=
KEEP_QUERY    ?=
YEET_AUTH_KEY ?=

# Use docker directly if the daemon is reachable, else fall back to sudo — so a
# `make run` works whether or not the user is in the `docker` group.
DOCKER := $(shell docker info >/dev/null 2>&1 && echo docker || echo sudo docker)

RUN_FLAGS := \
	--cap-add SYS_ADMIN \
	--cap-add NET_ADMIN \
	--cap-add BPF \
	--cap-add PERFMON \
	--security-opt apparmor=unconfined \
	--pid=host \
	--network=host \
	-v /sys/kernel/btf/vmlinux:/sys/kernel/btf/vmlinux:ro \
	-e PORT=$(PORT) \
	-e IFACE=$(IFACE) \
	-e KEEP_QUERY=$(KEEP_QUERY) \
	-e YEET_AUTH_KEY=$(YEET_AUTH_KEY)

build:
	$(DOCKER) build . -t $(IMAGE)

# Foreground demo run (Ctrl-C stops it).
run: build
	@$(DOCKER) run --rm -it --name $(NAME) $(RUN_FLAGS) $(IMAGE) || :

# Detached, self-healing run for a persistent deployment.
up: build
	@$(DOCKER) rm -f $(NAME) >/dev/null 2>&1 || true
	@$(DOCKER) run -d --name $(NAME) --restart unless-stopped $(RUN_FLAGS) $(IMAGE)
	@echo "httpwatch up on :$(PORT)  ·  make logs  |  make down"

down:
	@$(DOCKER) rm -f $(NAME) >/dev/null 2>&1 && echo "stopped $(NAME)" || echo "$(NAME) not running"

logs:
	@$(DOCKER) logs -f $(NAME)
