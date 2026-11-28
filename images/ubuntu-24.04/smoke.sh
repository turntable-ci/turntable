#!/usr/bin/env bash
# Smoke test of turntable-ubuntu-24.04, run inside the built image by CI before it is pushed:
#   docker run --rm -v "$PWD/images/ubuntu-24.04/smoke.sh:/smoke.sh:ro" <image> bash /smoke.sh
# It checks the toolchain answers and that turntable-svc starts each service, as root and as runner.
set -euxo pipefail

git --version
gh --version | head -1
jq --version
zstd --version
node --version
bun --version
uv --version
python3 -c 'import sys; assert sys.version_info[:2] == (3, 13), sys.version'
ruby --version
go version
java -version
id runner
sudo -n -u runner sudo -n true

# As root: the services drop to runner.
POSTGRES_PASSWORD=pw POSTGRES_DB=app turntable-svc start postgres
PGPASSWORD=pw psql -h 127.0.0.1 -U postgres -d app -v ON_ERROR_STOP=1 -c \
  'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION citext; SELECT version();'
turntable-svc start redis
redis-cli -h 127.0.0.1 ping | grep -qx PONG
MYSQL_ROOT_PASSWORD=pw MYSQL_DATABASE=app turntable-svc start mysql
mysql -h 127.0.0.1 -P 3306 -u root -ppw -e 'SELECT 1' app
turntable-svc status
turntable-svc stop postgres
turntable-svc stop redis
turntable-svc stop mysql

# As runner, with its own data dir: no root needed.
sudo -u runner env TURNTABLE_SVC_DATA=/tmp/svc-runner TURNTABLE_SVC_RUN=/tmp/svc-runner-run \
  PGPORT=5433 turntable-svc start postgres
psql -h 127.0.0.1 -p 5433 -U postgres -c 'SELECT 1'
echo smoke-ok
