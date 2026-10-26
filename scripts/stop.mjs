// 关闭本地 dev 服务（api:8788 / web:5173）。
// 思路：按端口反查正在 LISTEN 的进程 PID，连同其子进程整棵杀掉。
// 这样 `npm run dev`（concurrently 拉起 tsx watch + vite）也能一并退出，
// 不会留下占着端口的孤儿进程导致下次启动报 EADDRINUSE。
import { execFileSync, execSync } from 'node:child_process';
import process from 'node:process';

const PORTS = [
  { port: 8788, name: 'api' },
  { port: 5173, name: 'web' },
];

const isWindows = process.platform === 'win32';

/** 返回监听指定端口的进程 PID 列表（去重） */
function listeningPids(port) {
  try {
    if (isWindows) {
      // netstat 行形如：  TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    12345
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const match = line.match(/^ {2}TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (match && Number(match[1]) === port) pids.add(Number(match[2]));
      }
      return [...pids];
    }
    // macOS / Linux：lsof 直接给出监听该端口的 PID
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    // 没有监听者时 netstat/lsof 会返回非 0 退出码，属于正常情况
    return [];
  }
}

/** 结束一个进程；Windows 用 /T 连子进程一起结束 */
function killTree(pid) {
  try {
    if (isWindows) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

let stopped = 0;
for (const { port, name } of PORTS) {
  const pids = listeningPids(port);
  if (pids.length === 0) {
    console.log(`[stop] ${name} (${port}) 未在运行`);
    continue;
  }
  for (const pid of pids) {
    if (killTree(pid)) {
      stopped += 1;
      console.log(`[stop] 已结束 ${name} (${port}) PID ${pid}`);
    } else {
      console.log(`[stop] ${name} (${port}) PID ${pid} 结束失败（可能权限不足）`);
    }
  }
}

console.log(stopped > 0 ? `[stop] 共结束 ${stopped} 个进程` : '[stop] 没有需要关闭的进程');
