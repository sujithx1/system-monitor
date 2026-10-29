-- Run on the PRODUCTION PostgreSQL server as a superuser (psql -f this-file.sql).
-- Creates a read-only role for the agent. pg_monitor grants read access to statistics
-- views and pg_ls_waldir(); it cannot modify data, configuration or files, and cannot
-- terminate backends or delete WAL.
\set ON_ERROR_STOP on
\prompt 'Password for role system_monitor: ' monitor_password
CREATE ROLE system_monitor LOGIN PASSWORD :'monitor_password' CONNECTION LIMIT 3;
GRANT pg_monitor TO system_monitor;
ALTER ROLE system_monitor SET default_transaction_read_only = on;
ALTER ROLE system_monitor SET statement_timeout = '5s';
ALTER ROLE system_monitor SET lock_timeout = '1s';
ALTER ROLE system_monitor SET idle_in_transaction_session_timeout = '10s';
-- Replace appdb with your database name(s):
GRANT CONNECT ON DATABASE appdb TO system_monitor;
-- pg_hba.conf (local agent):  host  appdb  system_monitor  127.0.0.1/32  scram-sha-256
