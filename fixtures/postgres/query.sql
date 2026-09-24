select version(), 40 + 2 as answer;

-- PostgreSQL must recover from an executor error on the same connection.
begin;
\set ON_ERROR_STOP off
select 1 / 0;
\set ON_ERROR_STOP on
rollback;
select 'recovered_after_error', 42;
