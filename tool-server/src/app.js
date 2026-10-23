import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { mockApi } from './mockApi.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const rpc = req.path === '/mcp'
      ? ` rpc=${req.body?.method || '?'}${req.body?.params?.name ? ':' + req.body.params.name : ''}`
      : '';
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms${rpc}`);
  });
  next();
});

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Optional bearer token for everything except /health
  app.use((req, res, next) => {
    const token = process.env.AUTH_TOKEN;
    if (!token || req.path === '/health') return next();
    if (req.headers.authorization === `Bearer ${token}`) return next();
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } });
  });

  app.use('/api', mockApi());

  // Stateless Streamable HTTP MCP endpoint
  app.post('/mcp', async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('MCP error:', e);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const notAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return app;
}
