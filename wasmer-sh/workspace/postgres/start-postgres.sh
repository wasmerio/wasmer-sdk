#!/usr/bin/env bash
set -eu

# Package files are private to each process. Keep the database in the shared
# workspace so reconnecting psql does not restore the packaged, empty database.
cd /workspace
if [ ! -f .postgres/PG_VERSION ]; then
  rm -rf .postgres.new
  cp -r /base .postgres.new
  mv .postgres.new .postgres
fi
# The package sets -D /base; PostgreSQL's configuration can redirect its data.
printf "\ndata_directory = '/workspace/.postgres'\n" >> /base/postgresql.conf

while true; do
  # This PGlite build serves one connection per process. Restart after a clean
  # disconnect, or WASIX's 30-second accept timeout while no client is connected.
  if pglite 2> .postgres/server.log; then
    continue
  fi
  if [[ $(< .postgres/server.log) != *'could not accept new connection: Operation timed out'* ]]; then
    cat .postgres/server.log >&2
    exit 1
  fi
done
