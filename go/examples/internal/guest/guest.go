// Package guest embeds the same guest programs used by the other SDK examples.
// The build and release scripts copy them from the repository's fixtures directory.
package guest

import _ "embed"

//go:embed fixtures/python/hello.py
var Python []byte

//go:embed fixtures/edgejs/server.js
var EdgeJS []byte

//go:embed fixtures/postgres/query.sql
var PostgresSQL string
