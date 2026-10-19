# MCP Registry schema

`server-2025-12-11.schema.json` is an unmodified copy of the official released
[2025-12-11 schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json),
downloaded on 2026-10-19. Its SHA-256 is recorded by the adjacent validation tests.
The upstream [changelog](https://github.com/modelcontextprotocol/registry/blob/11b7b0e274d518b6f449c5ee3518a6151d9848b9/docs/reference/server-json/CHANGELOG.md)
lists this as the latest released version; the newer draft is unreleased.

The upstream license is preserved in `LICENSE` from
[`modelcontextprotocol/registry` at `11b7b0e274d518b6f449c5ee3518a6151d9848b9`](https://github.com/modelcontextprotocol/registry/tree/11b7b0e274d518b6f449c5ee3518a6151d9848b9).
Keep the schema byte-for-byte intact when updating it, and review the official registry's
additional publishing requirements separately. `npm run mcp:registry:validate` runs offline
against this pinned copy; it never logs in, contacts a deployed server, or submits a listing.
