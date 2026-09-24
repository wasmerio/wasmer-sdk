CREATE TABLE IF NOT EXISTS notes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO notes (title) VALUES ('Hello from PostgreSQL in Wasmer!');
SELECT * FROM notes ORDER BY id;
SELECT version();
SELECT 6 * 7 AS answer;
