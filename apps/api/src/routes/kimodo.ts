import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { kimodoService } from '../services/kimodo.js';
import { createLogger } from '../lib/logger.js';
import { repoRoot } from '../lib/paths.js';

const log = createLogger('kimodo-route');

const BRIDGE_JS = String.raw`
(function () {
  const PARENT = window.parent;
  if (!PARENT || PARENT === window) return;
  let lastReadyIds = new Set();

  function post(type, payload) {
    try { PARENT.postMessage({ source: 'kimodo-bridge', type, payload }, '*'); } catch (_) {}
  }

  // 把父页面的请求转发给 demo 的 REST API
  window.addEventListener('message', async (event) => {
    const data = event.data || {};
    if (data.source !== 'kimodo-parent') return;
    if (data.type === 'generate') {
      try {
        const r = await fetch('/api/kimodo/demo/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data.payload || {}),
        });
        const body = await r.json().catch(() => ({}));
        post('generate-result', { ok: r.ok, status: r.status, body });
      } catch (e) {
        post('generate-result', { ok: false, error: String(e) });
      }
    }
  });

  // 轮询 demo 动画列表，发现新就绪的动画就通知父页面
  async function poll() {
    try {
      const list = await fetch('/api/kimodo/demo/api/animations').then(r => r.json());
      const ready = (list || []).filter(a => a.status === 'ready');
      const current = new Set(ready.map(a => a.id));
      for (const a of ready) {
        if (!lastReadyIds.has(a.id)) post('animation-ready', a);
      }
      lastReadyIds = current;
      post('animations', list);
    } catch (_) {}
  }
  poll();
  setInterval(poll, 2500);

  // 通知父页面桥已就绪
  post('bridge-ready', {});
})();
`;

export async function registerKimodoRoutes(app: FastifyInstance): Promise<void> {
  const demoUrl = () => kimodoService.url;

  app.get('/api/kimodo/status', async () => kimodoService.status());

  app.post('/api/kimodo/start', async () => kimodoService.start());

  app.post('/api/kimodo/stop', async () => kimodoService.stop());

  /** 注入了 postMessage 桥的 demo 首页，供 iframe 嵌入 */
  app.get('/api/kimodo/frame', async (request, reply) => {
    if (!kimodoService.isRunning) {
      return reply.code(503).send('<html><body style="color:#888;font-family:sans-serif;padding:24px">Kimodo 未启动，请先点击「启动」按钮。</body></html>');
    }
    try {
      const resp = await fetch(`${demoUrl()}/`);
      let html = await resp.text();
      // 把 demo 的绝对路径改写到我们的代理前缀下（避免重复改写已被代理的路径）
      html = html
        .replace(/\/api\/(?!kimodo\/)/g, '/api/kimodo/demo/api/')
        .replace(/\/models\.js(?!kimodo\/)/g, '/api/kimodo/demo/models.js')
        .replace(/\/localai\.png(?!kimodo\/)/g, '/api/kimodo/demo/localai.png')
        .replace(/\/compare(?!kimodo\/)/g, '/api/kimodo/demo/compare');
      // 注入桥脚本
      html += '\n<script src="/api/kimodo/bridge.js"></script>';
      return reply.type('text/html; charset=utf-8').send(html);
    } catch (err) {
      log.error(`获取 demo 首页失败: ${(err as Error).message}`);
      return reply.code(502).send({ error: '无法连接 kimodo demo' });
    }
  });

  app.get('/api/kimodo/bridge.js', async (_request, reply) => {
    return reply.type('application/javascript; charset=utf-8').send(BRIDGE_JS);
  });

  /** 透传代理到 demo 的所有路径 */
  app.all('/api/kimodo/demo/*', async (request, reply) => {
    if (!kimodoService.isRunning) {
      return reply.code(503).send({ error: 'kimodo 未启动' });
    }
    const sub = (request.params as { '*': string })['*'];
    const target = `${demoUrl()}/${sub}`;
    const init: RequestInit = {
      method: request.method as string,
      headers: { ...(request.headers as Record<string, string>) },
    };
    const headers = init.headers as Record<string, string>;
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      init.body = JSON.stringify(request.body);
    }
    try {
      const resp = await fetch(target, init);
      const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
      reply.header('content-type', contentType);
      const buffer = Buffer.from(await resp.arrayBuffer());
      return reply.code(resp.status).send(buffer);
    } catch (err) {
      log.error(`代理到 demo 失败 ${target}: ${(err as Error).message}`);
      return reply.code(502).send({ error: '代理请求失败' });
    }
  });

  /** 生成（由父页面调用，避免跨域） */
  app.post('/api/kimodo/generate', async (request, reply) => {
    if (!kimodoService.isRunning) return reply.code(503).send({ error: 'kimodo 未启动' });
    try {
      const resp = await fetch(`${demoUrl()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body ?? {}),
      });
      const body = await resp.json().catch(() => ({}));
      return reply.code(resp.status).send(body);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/kimodo/animations', async (_request, reply) => {
    if (!kimodoService.isRunning) return reply.code(503).send([]);
    try {
      const resp = await fetch(`${demoUrl()}/api/animations`);
      return reply.code(resp.status).send(await resp.json());
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** 把 kimodo 生成的动作转换成 Mixamo 动画 JSON（format=fbx-animation-data） */
  app.get('/api/kimodo/import/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const motionDir = path.join(kimodoService.outputDir, id);
    const rootPath = path.join(motionDir, 'root_positions.f32');
    const rotPath = path.join(motionDir, 'local_rotations_xyzw.f32');
    if (!fs.existsSync(rootPath) || !fs.existsSync(rotPath)) {
      return reply.code(404).send({ error: `动画 ${id} 的数据文件不存在` });
    }

    const outDir = path.join(kimodoService.outputDir, 'mixamo');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${id}.json`);

    const converter = path.join(repoRoot, 'tools', 'kimodo', 'to_mixamo.py');
    // 优先用带 numpy 的 Python（Anaconda），可通过 KIMODO_PYTHON 覆盖
    const python =
      process.env.KIMODO_PYTHON ||
      (fs.existsSync('D:\\ProgramData\\anaconda3\\python.exe') ? 'D:\\ProgramData\\anaconda3\\python.exe' : 'python');
    const clipName = (request.query as { clipName?: string }).clipName || `kimodo ${id.slice(0, 8)}`;

    try {
      const result = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
        const child = spawn(python, [converter, '--motion-dir', motionDir, '--clip-name', clipName, '--out', outFile], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', (c) => (out += c.toString()));
        child.stderr.on('data', (c) => (err += c.toString()));
        child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
      });
      if (result.code !== 0) {
        log.error(`to_mixamo 失败: ${result.err}`);
        return reply.code(500).send({ error: result.err || '转换失败' });
      }
      const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      return { ok: true, data, clipName };
    } catch (err) {
      log.error(`导入 kimodo 动画失败: ${(err as Error).message}`);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
