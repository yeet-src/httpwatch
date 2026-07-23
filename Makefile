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

.PHONY: run up down logs build state
.DEFAULT_GOAL := run

IMAGE ?= httpwatch
NAME  ?= httpwatch
PORT  ?= 8080

# Optional passthroughs:
#   IFACE=lo,eth0      watch only these interfaces (default: all up ifaces)
#   KEEP_QUERY=true    keep query strings distinct instead of collapsing them
#   BODIES=none|response|both   which message bodies to capture (default: response;
#                      `both` captures request bodies too — they carry credentials)
#   YEET_AUTH_KEY=...  register the host with the yeet control plane on startup
#   STATE=<path|name>  where alert rules live so they survive the container being
#                      deleted and recreated. The default is a real directory on
#                      the host — bind-mounted, so `alerts.json` is a file you
#                      can read, back up, edit or delete:
#                        ~/.local/state/httpwatch/alerts.json
#                      Any value containing `/` is treated as a host path
#                      (created if missing, relative paths resolved); a bare name
#                      like `httpwatch-data` uses a docker named volume instead.
IFACE         ?=
KEEP_QUERY    ?=
BODIES        ?=
YEET_AUTH_KEY ?=
STATE         ?= $(HOME)/.local/state/httpwatch

# A bare name is a docker volume; anything path-like is bind-mounted and must be
# absolute (docker reads a relative -v source as a volume name).
ifeq (,$(findstring /,$(STATE)))
STATE_MOUNT := $(STATE)
else
STATE_MOUNT := $(abspath $(STATE))
endif

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
	-v $(STATE_MOUNT):/data \
	-e PORT=$(PORT) \
	-e IFACE=$(IFACE) \
	-e KEEP_QUERY=$(KEEP_QUERY) \
	-e BODIES=$(BODIES) \
	-e YEET_AUTH_KEY=$(YEET_AUTH_KEY) \
	-e STATE_UID=$(shell id -u) \
	-e STATE_GID=$(shell id -g)

build:
	$(DOCKER) build . -t $(IMAGE)

# Create the state directory as the invoking user, so alerts.json ends up in a
# directory you own — docker would otherwise create it root-owned. Skipped when
# STATE names a docker volume instead of a path.
state:
	@case "$(STATE)" in \
	  */*) mkdir -p "$(STATE_MOUNT)" && echo "state: $(STATE_MOUNT)/alerts.json";; \
	  *)   echo "state: docker volume $(STATE)";; \
	esac

# Foreground demo run (Ctrl-C stops it).
run: build state
	@$(DOCKER) run --rm -it --name $(NAME) $(RUN_FLAGS) $(IMAGE) || :

# Detached, self-healing run for a persistent deployment.
up: build state
	@$(DOCKER) rm -f $(NAME) >/dev/null 2>&1 || true
	@$(DOCKER) run -d --name $(NAME) --restart unless-stopped $(RUN_FLAGS) $(IMAGE)
	@echo "httpwatch up on :$(PORT)  ·  make logs  |  make down"

down:
	@$(DOCKER) rm -f $(NAME) >/dev/null 2>&1 && echo "stopped $(NAME)" || echo "$(NAME) not running"

logs:
	@$(DOCKER) logs -f $(NAME)
