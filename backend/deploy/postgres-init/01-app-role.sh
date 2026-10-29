#!/bin/sh
# Runs once, on first initialisation of the monitoring database volume.
# Creates the least-privileged runtime role used by the API and worker.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" -v db_name="$POSTGRES_DB" -v owner="$POSTGRES_USER" <<'EOSQL'
CREATE ROLE monitor_app LOGIN PASSWORD :'app_password' CONNECTION LIMIT 40;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO monitor_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO monitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO monitor_app;
EOSQL
