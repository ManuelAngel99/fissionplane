-- Runs on every boot (CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS is not set,
-- so effectively on first boot of a fresh volume). The metering tables
-- arrive with the usage-metering implementation; only the database
-- shell is guaranteed here.

CREATE DATABASE IF NOT EXISTS fissionplane;
