# turntable-ubuntu-24.04: the default sandbox image, close to GitHub's ubuntu-24.04 runner image for
# common CI. docs/default-image.mdx lists what is in it. Everything is pinned: the base by digest,
# every download by version and sha256, and every apt repository key by sha256. Apt packages come
# from those signed repositories at the major version named here (an apt archive drops old patch
# releases, so an exact apt pin would stop the image building); the build prints every version.
#
# Services start without Docker: `turntable-svc start postgres` (or redis, mysql) runs one on
# localhost as the non-root `runner` user. amd64 only, like the providers that run it.
ARG BASE=ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
FROM ${BASE}

ARG TARGETARCH
ARG NODE_VERSION=22.21.1
ARG NODE_SHA256=680d3f30b24a7ff24b98db5e96f294c0070f8f9078df658da1bce1b9c9873c88
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG UV_VERSION=0.11.16
ARG UV_SHA256=74947fe2c03315cf07e82ab3acc703eddef01aba4d5232a98e4c6825ec116131
ARG PYTHON_VERSION=3.13
ARG GO_VERSION=1.27.4
ARG GO_SHA256=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840
ARG POSTGRES_MAJOR=18
ARG JAVA_MAJOR=21
ARG GH_KEY_SHA256=6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b
ARG PGDG_KEY_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76
ARG ADOPTIUM_KEY_SHA256=a46d5d3ab75c3c86dddf1bfd2957a067a24b1c6b2d2ed2bc69294bf970c5160b

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy \
    GOROOT=/usr/local/go \
    PATH=/usr/local/go/bin:/opt/uv-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Base tools, and the three signed apt repositories (GitHub CLI, PGDG, Adoptium), each key checked.
RUN set -eux; \
    [ "${TARGETARCH:-amd64}" = amd64 ] || { echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1; }; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL -o /tmp/gh.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
    echo "${GH_KEY_SHA256}  /tmp/gh.gpg" | sha256sum -c -; \
    install -m 0644 /tmp/gh.gpg /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    curl -fsSL -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "${PGDG_KEY_SHA256}  /tmp/pgdg.asc" | sha256sum -c -; \
    gpg --dearmor -o /usr/share/keyrings/pgdg.gpg /tmp/pgdg.asc; \
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    curl -fsSL -o /tmp/adoptium.asc https://packages.adoptium.net/artifactory/api/gpg/key/public; \
    echo "${ADOPTIUM_KEY_SHA256}  /tmp/adoptium.asc" | sha256sum -c -; \
    gpg --dearmor -o /usr/share/keyrings/adoptium.gpg /tmp/adoptium.asc; \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb noble main" > /etc/apt/sources.list.d/adoptium.list; \
    rm /tmp/gh.gpg /tmp/pgdg.asc /tmp/adoptium.asc; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      git git-lfs gh jq zstd unzip zip xz-utils rsync wget less openssh-client sudo locales tzdata \
      ripgrep procps \
      build-essential pkg-config make cmake libssl-dev libffi-dev zlib1g-dev libyaml-dev \
      libreadline-dev libpq-dev default-libmysqlclient-dev \
      ruby-full \
      "temurin-${JAVA_MAJOR}-jdk" \
      "postgresql-${POSTGRES_MAJOR}" "postgresql-${POSTGRES_MAJOR}-pgvector" "postgresql-client-${POSTGRES_MAJOR}" \
      redis-server redis-tools \
      mysql-server mysql-client; \
    rm -rf /var/lib/apt/lists/*; \
    systemctl disable postgresql redis-server mysql 2>/dev/null || true

# Node LTS, bun, uv with Python, Go: release archives, each checked against its sha256.
RUN set -eux; \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"; \
    echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun; \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
    curl -fsSL -o /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"; \
    echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1; \
    uv python install "${PYTHON_VERSION}"; \
    ln -sf "$(uv python find "${PYTHON_VERSION}")" /usr/local/bin/python3; \
    ln -sf /usr/local/bin/python3 /usr/local/bin/python; \
    curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"; \
    echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/go.tar.gz -C /usr/local; \
    rm -rf /tmp/node.tar.xz /tmp/bun.zip /tmp/bun /tmp/uv.tar.gz /tmp/go.tar.gz

# The non-root user steps run as, with passwordless sudo like GitHub's runner, and the service data
# dirs it owns, so a database starts without root.
COPY turntable-svc /usr/local/bin/turntable-svc
RUN set -eux; \
    chmod 0755 /usr/local/bin/turntable-svc; \
    userdel -r ubuntu 2>/dev/null || true; \
    useradd -m -u 1001 -s /bin/bash runner; \
    echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner; \
    chmod 0440 /etc/sudoers.d/runner; \
    install -d -o runner -g runner -m 0755 /var/lib/turntable-svc /var/run/turntable-svc; \
    chmod 1777 /var/run/postgresql /var/run/mysqld 2>/dev/null || install -d -m 1777 /var/run/postgresql /var/run/mysqld; \
    git --version; gh --version | head -1; jq --version; zstd --version; \
    node --version; npm --version; bun --version; uv --version; python3 --version; \
    ruby --version; go version; java -version; \
    "/usr/lib/postgresql/${POSTGRES_MAJOR}/bin/postgres" --version; redis-server --version; mysqld --version

ENV TURNTABLE_IMAGE=turntable-ubuntu-24.04 \
    PG_BIN=/usr/lib/postgresql/18/bin
WORKDIR /home/runner
