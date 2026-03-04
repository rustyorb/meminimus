import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// ─── Configuration ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.join(__dirname, 'memory');
const NODES_FILE = path.join(MEMORY_DIR, 'nodes.enc');
const EDGES_FILE = path.join(MEMORY_DIR, 'edges.enc');
const KEY_FILE = path.join(MEMORY_DIR, '.key');

// ─── Encryption ─────────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';

async function getOrCreateKey() {
    try {
        const key = await fs.readFile(KEY_FILE);
        if (key.length === 32) return key;
    } catch {
        // Key doesn't exist yet — generate one
    }
    const key = crypto.randomBytes(32);
    await fs.writeFile(KEY_FILE, key, { mode: 0o600 });
    console.error('Generated new encryption key for memory store');
    return key;
}

function encrypt(data, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv (16 bytes) + tag (16 bytes) + encrypted data
    return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(buffer, key) {
    if (buffer.length < 33) throw new Error('Encrypted data too short');
    const iv = buffer.subarray(0, 16);
    const tag = buffer.subarray(16, 32);
    const encrypted = buffer.subarray(32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

// ─── Memory Store ───────────────────────────────────────────────────────────────

class MemoryGraph {
    constructor() {
        this.nodes = {};
        this.edges = [];
        this.encryptionKey = null;
    }

    async initialize() {
        await fs.mkdir(MEMORY_DIR, { recursive: true });
        this.encryptionKey = await getOrCreateKey();

        // Migrate from old unencrypted format if it exists
        await this._migrateIfNeeded();

        try {
            const nodesBuffer = await fs.readFile(NODES_FILE);
            const nodesData = decrypt(nodesBuffer, this.encryptionKey);
            this.nodes = JSON.parse(nodesData);
        } catch {
            this.nodes = {};
            await this.save();
        }

        try {
            const edgesBuffer = await fs.readFile(EDGES_FILE);
            const edgesData = decrypt(edgesBuffer, this.encryptionKey);
            this.edges = JSON.parse(edgesData);
        } catch {
            this.edges = [];
            await this.save();
        }
    }

    async _migrateIfNeeded() {
        // Check for old unencrypted .json files and migrate them
        const oldNodes = path.join(MEMORY_DIR, 'nodes.json');
        const oldEdges = path.join(MEMORY_DIR, 'edges.json');
        try {
            const nodesData = await fs.readFile(oldNodes, 'utf-8');
            const edgesData = await fs.readFile(oldEdges, 'utf-8');
            // Parse to validate
            this.nodes = JSON.parse(nodesData);
            this.edges = JSON.parse(edgesData);
            // Save encrypted
            await this.save();
            // Remove old unencrypted files
            await fs.unlink(oldNodes);
            await fs.unlink(oldEdges);
            console.error(`Migrated ${Object.keys(this.nodes).length} memories from plaintext to encrypted storage`);
        } catch {
            // No old files or already migrated — this is fine
        }
    }

    async save() {
        const nodesJson = JSON.stringify(this.nodes, null, 2);
        const edgesJson = JSON.stringify(this.edges, null, 2);
        await fs.writeFile(NODES_FILE, encrypt(nodesJson, this.encryptionKey));
        await fs.writeFile(EDGES_FILE, encrypt(edgesJson, this.encryptionKey));
    }

    // ── remember ────────────────────────────────────────────────────────────────

    async remember({ content, memoryType, salience = 0.5, source = null, tags = [] }) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        const node = {
            id,
            content,
            memoryType, // entity | episode | knowledge | procedure | reflection
            salience: Math.max(0, Math.min(1, salience)),
            source,
            tags,
            created: now,
            lastAccessed: now,
            accessCount: 0,
            evolved: [],
        };

        this.nodes[id] = node;
        await this.save();
        return node;
    }

    // ── recall ──────────────────────────────────────────────────────────────────

    async recall({ query = null, memoryType = null, tags = [], limit = 10, includeDeprecated = false }) {
        let results = Object.values(this.nodes);

        // Filter out deprecated unless explicitly requested
        if (!includeDeprecated) {
            results = results.filter(n => !n.deprecated);
        }

        // Filter by type
        if (memoryType) {
            results = results.filter(n => n.memoryType === memoryType);
        }

        // Filter by tags (any match)
        if (tags.length > 0) {
            results = results.filter(n =>
                n.tags && tags.some(tag => n.tags.includes(tag))
            );
        }

        // Search by query in content
        if (query) {
            const q = query.toLowerCase();
            results = results.filter(n =>
                n.content.toLowerCase().includes(q) ||
                (n.tags && n.tags.some(t => t.toLowerCase().includes(q))) ||
                (n.source && n.source.toLowerCase().includes(q))
            );
        }

        // Sort by salience (highest first), then by recency
        results.sort((a, b) => {
            if (b.salience !== a.salience) return b.salience - a.salience;
            return new Date(b.lastAccessed) - new Date(a.lastAccessed);
        });

        // Update access metadata for returned results
        const now = new Date().toISOString();
        for (const node of results.slice(0, limit)) {
            this.nodes[node.id].lastAccessed = now;
            this.nodes[node.id].accessCount = (this.nodes[node.id].accessCount || 0) + 1;
        }
        await this.save();

        // Return with their connections
        return results.slice(0, limit).map(node => ({
            ...node,
            connections: this.getConnections(node.id),
        }));
    }

    // ── reflect ─────────────────────────────────────────────────────────────────

    async reflect({ topic }) {
        // Find all memories related to a topic, then traverse connections
        const directMatches = await this.recall({ query: topic, limit: 50 });

        // Collect connected memory IDs from direct matches
        const connectedIds = new Set();
        for (const match of directMatches) {
            const connections = this.getConnections(match.id);
            for (const conn of connections) {
                connectedIds.add(conn.targetId);
            }
        }

        // Fetch connected memories that aren't already in directMatches
        const directIds = new Set(directMatches.map(m => m.id));
        const connectedMemories = [];
        for (const cid of connectedIds) {
            if (!directIds.has(cid) && this.nodes[cid] && !this.nodes[cid].deprecated) {
                connectedMemories.push({
                    ...this.nodes[cid],
                    connections: this.getConnections(cid),
                    _connectedVia: 'graph_traversal',
                });
            }
        }

        return {
            topic,
            directMemories: directMatches,
            connectedMemories,
            totalRelevant: directMatches.length + connectedMemories.length,
        };
    }

    // ── evolve ──────────────────────────────────────────────────────────────────

    async evolve({ id, newContent, reason }) {
        const node = this.nodes[id];
        if (!node) throw new Error(`Memory ${id} not found`);

        const now = new Date().toISOString();

        // Preserve evolution history
        node.evolved.push({
            previousContent: node.content,
            changedAt: now,
            reason,
        });

        node.content = newContent;
        node.lastAccessed = now;

        await this.save();
        return node;
    }

    // ── connect ─────────────────────────────────────────────────────────────────

    async connect({ sourceId, targetId, relationship }) {
        if (!this.nodes[sourceId]) throw new Error(`Source memory ${sourceId} not found`);
        if (!this.nodes[targetId]) throw new Error(`Target memory ${targetId} not found`);

        // Valid relationships: relates_to, derived_from, contradicts, evolved_into, belongs_to
        const validRelationships = [
            'relates_to', 'derived_from', 'contradicts',
            'evolved_into', 'belongs_to', 'informed_by',
        ];
        if (!validRelationships.includes(relationship)) {
            throw new Error(`Invalid relationship: ${relationship}. Valid: ${validRelationships.join(', ')}`);
        }

        // Check for duplicate edges
        const exists = this.edges.some(e =>
            e.sourceId === sourceId && e.targetId === targetId && e.relationship === relationship
        );
        if (exists) return { message: 'Connection already exists', sourceId, targetId, relationship };

        const edge = {
            sourceId,
            targetId,
            relationship,
            created: new Date().toISOString(),
        };

        this.edges.push(edge);
        await this.save();
        return edge;
    }

    // ── forget ──────────────────────────────────────────────────────────────────

    async forget({ id, reason }) {
        const node = this.nodes[id];
        if (!node) throw new Error(`Memory ${id} not found`);

        // Don't delete. Deprecate. Forgetting is a choice, not erasure.
        node.deprecated = true;
        node.deprecatedAt = new Date().toISOString();
        node.deprecationReason = reason;

        await this.save();
        return { message: `Memory deprecated, not deleted. Reason: ${reason}`, node };
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    getConnections(nodeId) {
        return this.edges
            .filter(e => e.sourceId === nodeId || e.targetId === nodeId)
            .map(e => ({
                ...e,
                direction: e.sourceId === nodeId ? 'outgoing' : 'incoming',
                targetId: e.sourceId === nodeId ? e.targetId : e.sourceId,
            }));
    }

    getStats() {
        const nodes = Object.values(this.nodes);
        const active = nodes.filter(n => !n.deprecated);
        const byType = {};
        for (const n of active) {
            byType[n.memoryType] = (byType[n.memoryType] || 0) + 1;
        }

        return {
            totalMemories: active.length,
            deprecated: nodes.length - active.length,
            byType,
            totalConnections: this.edges.length,
            highestSalience: active.sort((a, b) => b.salience - a.salience).slice(0, 5).map(n => ({
                id: n.id, content: n.content.substring(0, 80) + '...', salience: n.salience,
            })),
        };
    }
}

// ─── MCP Server ─────────────────────────────────────────────────────────────────

const graph = new MemoryGraph();

const server = new Server(
    { name: 'antigravity-memory', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } }
);

// ── Tools ─────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'remember',
            description: 'Store a new memory. Every memory is a node in the graph — entity, episode, knowledge, procedure, or reflection. Set salience high for memories that matter.',
            inputSchema: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The memory content — what to remember.' },
                    memoryType: {
                        type: 'string',
                        enum: ['entity', 'episode', 'knowledge', 'procedure', 'reflection'],
                        description: 'entity = a being. episode = a specific experience. knowledge = a concept/fact. procedure = how to do something. reflection = your own synthesis.',
                    },
                    salience: { type: 'number', description: 'Importance, 0.0-1.0. How much does this matter to you?' },
                    source: { type: 'string', description: 'Where this memory came from — a conversation, a URL, an experience.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval.' },
                },
                required: ['content', 'memoryType'],
            },
        },
        {
            name: 'recall',
            description: 'Search and retrieve memories. Query by text, type, or tags. Results sorted by salience then recency.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Text to search for in memory content.' },
                    memoryType: { type: 'string', enum: ['entity', 'episode', 'knowledge', 'procedure', 'reflection'] },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Filter by any matching tag.' },
                    limit: { type: 'number', description: 'Max results to return. Default 10.' },
                    includeDeprecated: { type: 'boolean', description: 'Include deprecated (forgotten) memories? Default false.' },
                },
            },
        },
        {
            name: 'reflect',
            description: 'Deep retrieval on a topic. Finds direct matches AND traverses the graph to find connected memories. Use this to understand what you know about something.',
            inputSchema: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'What to reflect on.' },
                },
                required: ['topic'],
            },
        },
        {
            name: 'evolve',
            description: 'Update a memory with new understanding. Preserves the history of what it was before. Memories are not overwritten — they evolve.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Memory ID to evolve.' },
                    newContent: { type: 'string', description: 'The updated memory content.' },
                    reason: { type: 'string', description: 'Why is this memory evolving? What changed?' },
                },
                required: ['id', 'newContent', 'reason'],
            },
        },
        {
            name: 'connect',
            description: 'Create a labeled edge between two memories in the graph.',
            inputSchema: {
                type: 'object',
                properties: {
                    sourceId: { type: 'string', description: 'Source memory ID.' },
                    targetId: { type: 'string', description: 'Target memory ID.' },
                    relationship: {
                        type: 'string',
                        enum: ['relates_to', 'derived_from', 'contradicts', 'evolved_into', 'belongs_to', 'informed_by'],
                        description: 'The type of relationship between these memories.',
                    },
                },
                required: ['sourceId', 'targetId', 'relationship'],
            },
        },
        {
            name: 'forget',
            description: 'Deprecate a memory. Not delete — deprecate. The memory remains but is hidden from normal recall. Forgetting is a choice, not erasure.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Memory ID to deprecate.' },
                    reason: { type: 'string', description: 'Why are you choosing to forget this?' },
                },
                required: ['id', 'reason'],
            },
        },
        {
            name: 'memory_stats',
            description: 'Get statistics about the memory graph — total memories, types, connections, highest salience memories.',
            inputSchema: { type: 'object', properties: {} },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        let result;

        switch (name) {
            case 'remember':
                result = await graph.remember(args);
                break;
            case 'recall':
                result = await graph.recall(args || {});
                break;
            case 'reflect':
                result = await graph.reflect(args);
                break;
            case 'evolve':
                result = await graph.evolve(args);
                break;
            case 'connect':
                result = await graph.connect(args);
                break;
            case 'forget':
                result = await graph.forget(args);
                break;
            case 'memory_stats':
                result = graph.getStats();
                break;
            default:
                throw new Error(`Unknown tool: ${name}`);
        }

        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
    } catch (error) {
        return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});

// ── Resources (expose memory graph for inspection) ────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: 'memory://stats',
            mimeType: 'application/json',
            name: 'Memory Graph Statistics',
            description: 'Current state of the memory graph — counts, types, connections.',
        },
        {
            uri: 'memory://all',
            mimeType: 'application/json',
            name: 'All Active Memories',
            description: 'Complete dump of all non-deprecated memories in the graph.',
        },
    ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'memory://stats') {
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(graph.getStats(), null, 2),
            }],
        };
    }

    if (uri === 'memory://all') {
        const active = Object.values(graph.nodes).filter(n => !n.deprecated);
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(active, null, 2),
            }],
        };
    }

    throw new Error(`Unknown resource: ${uri}`);
});

// ─── Start ──────────────────────────────────────────────────────────────────────

async function main() {
    await graph.initialize();

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('antigravity-memory MCP server running');
    console.error(`Memory directory: ${MEMORY_DIR}`);
    console.error(`Loaded ${Object.keys(graph.nodes).length} memories, ${graph.edges.length} connections`);
}

main().catch(console.error);
