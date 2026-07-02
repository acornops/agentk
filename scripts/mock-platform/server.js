import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import { gunzipSync } from 'zlib';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const app = express();
const port = 3000;
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || './snapshots';

app.use(express.json());

// Ensure snapshot directory exists
await mkdir(SNAPSHOT_DIR, { recursive: true }).catch(console.error);

const server = app.listen(port, () => {
  console.log(`Mock platform listening on port ${port}`);
});

const wss = new WebSocketServer({ server, path: '/agent' });

let activeAgent = null;
let lastHandshake = null;
let lastHeartbeatAt = null;

wss.on('connection', (ws, req) => {
  const agentKey = req.headers['x-agent-key'];
  console.log(`Agent connected with key: ${agentKey}`);
  activeAgent = ws;

  ws.on('message', (message) => {
    let data = message;

    // Check if it's Gzipped (snapshots are)
    if (message[0] === 0x1f && message[1] === 0x8b) {
      try {
        data = gunzipSync(message).toString();
      } catch (err) {
        console.error('Failed to decompress message:', err);
        return;
      }
    } else {
      data = message.toString();
    }

    try {
      const parsed = JSON.parse(data);
      console.log(`Received message: ${parsed.method || 'Response'}`);

      if (parsed.method === 'lifecycle/handshake') {
        handleHandshake(ws, parsed);
      } else if (parsed.method === 'lifecycle/heartbeat') {
        console.log(`Heartbeat from agent at ${parsed.params.timestamp}`);
        lastHeartbeatAt = parsed.params.timestamp;
      } else if (parsed.method === 'notify/snapshot') {
        handleSnapshot(parsed);
      } else if (parsed.id && !parsed.method) {
        console.log('Received response from agent:', JSON.stringify(parsed, null, 2));
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Agent disconnected');
    if (activeAgent === ws) activeAgent = null;
  });
});

function handleHandshake(ws, message) {
  console.log('Received handshake:', JSON.stringify(message.params, null, 2));
  lastHandshake = message.params;
  const response = {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      workspaceId: 'ws-local-123',
      targetId: message.params?.targetId || 'cluster-local-456',
      targetType: 'kubernetes',
      config: {
        snapshotInterval: 60
      }
    }
  };
  ws.send(JSON.stringify(response));
  console.log('Sent handshake response');
}

async function handleSnapshot(message) {
  const timestamp = message.params.timestamp.replace(/[:.]/g, '-');
  const filename = `snapshot-${timestamp}.json`;
  const filepath = join(SNAPSHOT_DIR, filename);

  console.log(`Received snapshot at ${message.params.timestamp}. Saving to ${filename}`);

  // Log a summary
  const data = message.params.data;
  const summary = Object.keys(data).map(k => `${k}: ${Array.isArray(data[k]) ? data[k].length : 'object'}`).join(', ');
  console.log(`Snapshot summary: ${summary}`);

  await writeFile(filepath, JSON.stringify(message, null, 2));
}

// Endpoint to send a command to the agent
app.post('/send-command', (req, res) => {
  if (!activeAgent || activeAgent.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: 'No active agent connection' });
  }

  const { method, params } = req.body;
  if (!method) {
    return res.status(400).json({ error: 'Method is required' });
  }

  const id = `cmd-${Date.now()}`;
  const request = {
    jsonrpc: '2.0',
    method,
    params: params || {},
    id
  };

  activeAgent.send(JSON.stringify(request));
  console.log(`Sent command to agent: ${method} (id: ${id})`);
  res.json({ message: 'Command sent', id });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'agentk-mock-platform',
    websocketConnected: !!activeAgent && activeAgent.readyState === WebSocket.OPEN
  });
});

app.get('/connections', (_req, res) => {
  res.json({
    websocketConnected: !!activeAgent && activeAgent.readyState === WebSocket.OPEN,
    lastHandshake,
    lastHeartbeatAt
  });
});

const openApi = {
  openapi: '3.1.0',
  info: {
    title: 'AgentK Local Mock Platform API',
    version: '0.0.1-experimental.1',
    description: 'Local developer endpoints used to inspect agent connectivity and send JSON-RPC commands to the agent.'
  },
  servers: [{ url: 'http://localhost:3000' }],
  paths: {
    '/health': {
      get: {
        summary: 'Mock platform health',
        responses: {
          200: {
            description: 'Health payload.'
          }
        }
      }
    },
    '/connections': {
      get: {
        summary: 'Inspect active websocket connection and recent lifecycle metadata',
        responses: {
          200: {
            description: 'Connection payload.'
          }
        }
      }
    },
    '/send-command': {
      post: {
        summary: 'Send a JSON-RPC command to connected agent',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['method'],
                properties: {
                  method: { type: 'string', description: 'JSON-RPC method (for example: tools/call).' },
                  params: { type: 'object', additionalProperties: true }
                }
              },
              examples: {
                listTools: {
                  summary: 'List tools',
                  value: { method: 'tools/list', params: {} }
                },
                callTool: {
                  summary: 'Call describe_resource',
                  value: {
                    method: 'tools/call',
                    params: {
                      name: 'describe_resource',
                      arguments: { kind: 'Pod', namespace: 'default', name: 'example' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'Command accepted and forwarded to websocket client.' },
          400: { description: 'Invalid request.' },
          404: { description: 'No active agent connection.' }
        }
      }
    }
  }
};

app.get('/openapi.json', (_req, res) => {
  res.json(openApi);
});

app.get(['/docs', '/docs/'], (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentK Mock Platform API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.20.2/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.20.2/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis]
      });
    </script>
  </body>
</html>`);
});
