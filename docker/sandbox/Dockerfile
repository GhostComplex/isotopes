# isotopes-sandbox — base image for agent shell execution
#
# Build:
#   docker build -t isotopes-sandbox:latest docker/sandbox/
#
# Used by SandboxExecutor when sandbox.mode is "all" or "non-main".

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
      ripgrep \
      tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Non-root user; uid 1000 matches typical host dev user, avoiding most
# bind-mount permission issues. Override at build/run time if your host
# user uses a different uid.
RUN useradd -m -u 1000 -s /bin/bash agent

WORKDIR /workspace
USER agent

# Container is kept alive by the orchestrator via `tail -f /dev/null`
# (set by ContainerManager.buildCreateArgs). Commands are injected via
# `docker exec`. ENTRYPOINT is intentionally not set here.
