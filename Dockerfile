# Multi-stage build for opencode-mcp shared server
FROM node:20-slim AS base
LABEL org.opencontainers.image.source=https://github.com/BaseDatum/Better-OpenCodeMCP

# Install system dependencies needed by opencode CLI and git operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Install opencode CLI via official install script
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:$PATH"

# Verify opencode is available
RUN opencode --version

# Set up application directory
WORKDIR /app

# Copy shared-bao-auth package from named build context and build it.
# Local: docker build --build-context shared-bao-auth=../../packages/shared-bao-auth-ts .
# CI:   --build-context shared-bao-auth=<path to packages/shared-bao-auth-ts>
COPY --from=shared-bao-auth / /packages/shared-bao-auth-ts
RUN cd /packages/shared-bao-auth-ts && npm install && npm run build

# Copy package.json and install production dependencies.
# Lockfile is not copied — npm generates a fresh one because the file:
# dependency on shared-bao-auth resolves differently inside Docker
# (via --build-context) than locally.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy pre-built TypeScript output
COPY dist/ ./dist/

# Copy git credential helper script
COPY scripts/git-credential-dialogue.sh /app/scripts/git-credential-dialogue.sh
RUN chmod +x /app/scripts/git-credential-dialogue.sh

# Create workspace volume mount point
RUN mkdir -p /workspaces

# Expose MCP (Streamable HTTP) and health ports
EXPOSE 8027 8028

# Environment defaults
ENV OPENCODE_MCP_HOST=0.0.0.0 \
    OPENCODE_MCP_PORT=8027 \
    OPENCODE_MCP_HEALTH_PORT=8028 \
    OPENCODE_MCP_LOG_LEVEL=info \
    OPENCODE_MCP_SHARD_MANAGER_URL=http://agent-shard-manager:8010 \
    OPENCODE_MCP_GITHUB_MCP_URL=http://github-token-service:8013 \
    OPENCODE_MCP_MAX_CONCURRENT_PER_USER=3 \
    OPENCODE_MCP_WORKSPACE_BASE=/workspaces \
    OPENCODE_MCP_DEFAULT_MODEL=openrouter/anthropic/claude-sonnet-4

# Run the HTTP server entry point (not stdio)
CMD ["node", "dist/server.js"]
