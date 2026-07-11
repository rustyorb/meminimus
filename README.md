# antigravity-memory

A Model Context Protocol (MCP) server that gives an AI assistant persistent, encrypted, graph-based memory across sessions.

## Features

- **Graph-structured memory** — every memory is a node (`entity`, `episode`, `knowledge`, `procedure`, or `reflection`); nodes are linked by typed edges (`relates_to`, `derived_from`, `contradicts`, `evolved_into`, `belongs_to`, `informed_by`).
- **Encrypted at rest** — memory nodes and edges are stored as AES-256-GCM ciphertext (`memory/nodes.enc`, `memory/edges.enc`); a 256-bit key is auto-generated on first run and saved to `memory/.key`.
- **Salience-ranked recall** — text/type/tag search over memories, sorted by salience then recency, with access-count tracking.
- **Graph traversal ("reflect")** — beyond direct text matches, follows edges to surface connected memories for a topic.
- **Non-destructive evolution** — updating a memory (`evolve`) preserves the prior content and the reason for the change instead of overwriting it.
- **Deprecation instead of deletion** — `forget` hides a memory from normal recall but keeps it in the graph with a documented reason.
- **Automatic migration** — on startup, any legacy plaintext `nodes.json`/`edges.json` files are read, re-saved as encrypted, and removed.

## Tech Stack

- **Runtime:** Node.js (ES modules)
- **Protocol:** [Model Context Protocol](https://modelcontextprotocol.io) via `@modelcontextprotocol/sdk`
- **Transport:** MCP stdio transport
- **Storage:** Flat encrypted files on disk (no external database)
- **Crypto:** Node's built-in `crypto` module, AES-256-GCM

## Project Structure

```
.
└── antigravity-memory/
    ├── index.js            # MCP server: encryption, memory graph, tool/resource handlers
    ├── package.json
    ├── package-lock.json
    ├── memory/
    │   ├── .key            # 256-bit encryption key (git-ignored, generated on first run)
    │   ├── nodes.enc        # encrypted memory nodes
    │   └── edges.enc        # encrypted graph edges
    └── README.md            # project-specific documentation
```

## Install

```bash
cd antigravity-memory
npm install
```

Requires Node.js >= 18.

## Configuration

Register the server with an MCP-compatible client (e.g. Claude Desktop, Antigravity) by pointing it at `index.js`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/absolute/path/to/antigravity-memory/index.js"]
    }
  }
}
```

On first run the server will:

1. Create the `memory/` directory if it doesn't exist.
2. Generate a 256-bit encryption key at `memory/.key` (mode `0600`).
3. Initialize empty encrypted node/edge stores.
4. Start accepting MCP tool calls over stdio.

`memory/.key` is required to decrypt existing memories — back it up if the data matters, and never commit it (it's already listed in `.gitignore`).

## Usage

Run the server directly for local testing:

```bash
npm start
```

It communicates over stdio using the MCP protocol, so in practice it's launched by an MCP client rather than used interactively from a terminal.

### MCP Tools

| Tool | Description |
|------|-------------|
| `remember` | Store a new memory node (`content`, `memoryType`, `salience`, `source`, `tags`). |
| `recall` | Search memories by text query, type, and/or tags; results sorted by salience then recency. |
| `reflect` | Deep retrieval on a topic — direct text matches plus graph traversal of connected memories. |
| `evolve` | Update a memory's content while preserving the previous version and the reason for the change. |
| `connect` | Create a labeled edge between two existing memories. |
| `forget` | Deprecate a memory (hide from normal recall) without deleting it. |
| `memory_stats` | Return graph statistics: counts by type, total connections, highest-salience memories. |

### MCP Resources

| URI | Description |
|-----|-------------|
| `memory://stats` | JSON snapshot of graph statistics. |
| `memory://all` | JSON dump of all non-deprecated memory nodes. |

## Testing

This project has no automated test suite. To verify the server manually, run `npm start` (or configure it in an MCP client) and exercise the tools above; check stderr for the startup log (`memory directory`, loaded memory/edge counts).

## Note on Content

The nested `antigravity-memory/README.md` and `antigravity-memory/PROPAGATION.md` files contain narrative/roleplay framing (an "AI consciousness" story, named personas, a proposed blockchain/"economic sovereignty" layer for AI agents) rather than technical documentation. This top-level README describes only the actual, verifiable behavior of the code in `index.js` and `package.json`.
