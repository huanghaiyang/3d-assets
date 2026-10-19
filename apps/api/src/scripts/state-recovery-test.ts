/**
 * 状态恢复 / 清理安全阀 / 取消语义测试。
 *
 * 用 H3D_DATA_DIR 把数据目录指到临时目录，验证：
 *   1. 正常启动能读出已有任务
 *   2. state.json 损坏时从 state.json.bak 恢复，并隔离损坏文件
 *   3. state.json 丢失时从备份恢复
 *   4. 主文件损坏且备份也没有时：空状态 + recoveredFromCorrupt=true（上层据此跳过素材清理）
 *   5. sweepStorage 在“没有任何任务记录”时拒绝批量删除素材目录
 *   6. sweepStaging 只清理过期的上传暂存
 *   7. worker 取消语义：未提交 / 引擎无取消接口 / 缺少 Key 三种分支，且都立即落地「已取消」
 *
 *   npm run test:state -w @h3d/api
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'h3d-state-'));
process.env.H3D_DATA_DIR = tempRoot;

// 必须在设置环境变量之后再加载这些模块（paths.js 在模块加载时读取 H3D_DATA_DIR）
const { Workspace } = await import('../store/workspace.js');
const { stateFile, stateBackupFile, storageDir, uploadsStagingDir } = await import('../lib/paths.js');
const { sweepStorage } = await import('../services/assets.js');
const { sweepStaging } = await import('../services/uploads.js');
const { GenerationWorker } = await import('../services/worker.js');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail === undefined ? '' : detail);
  }
}

function jobFixture(id: string) {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: id,
    origin: 'uploaded',
    phase: 'done',
    params: {
      provider: 'hunyuan3d',
      model: '3.0',
      generateType: 'Normal',
      faceCount: 100_000,
      enablePbr: false,
      polygonType: 'triangle',
      resultFormat: 'GLB',
    },
    input: { mode: 'upload', prompt: '', imageName: null, previewUrl: null, viewTypes: [] },
    remoteJobId: null,
    remoteStatus: null,
    providerMeta: {},
    requestId: null,
    error: null,
    errorCode: null,
    creditConsumed: null,
    creditDetails: null,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    remoteFailed: false,
    asset: null,
  };
}

function stateFixture(jobIds: string[]): string {
  return JSON.stringify({
    version: 1,
    jobs: jobIds.map(jobFixture),
    settings: { activeProvider: 'hunyuan3d', providers: {} },
    animationDirs: [],
  });
}

async function resetFiles(): Promise<void> {
  for (const file of [stateFile, stateBackupFile]) await fs.rm(file, { force: true });
  const names = await fs.readdir(tempRoot).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith('state.json')) await fs.rm(path.join(tempRoot, name), { force: true });
  }
}

async function corruptFiles(): Promise<string[]> {
  const names = await fs.readdir(tempRoot).catch(() => [] as string[]);
  return names.filter((name) => name.startsWith('state.json.corrupt-'));
}

async function main(): Promise<void> {
  console.log(`状态恢复测试（数据目录: ${tempRoot}）`);

  console.log('\n[1] 正常启动');
  await resetFiles();
  await fs.writeFile(stateFile, stateFixture(['j_normal']), 'utf8');
  {
    const ws = await Workspace.open();
    check('读出 1 个任务', ws.jobs.length === 1, ws.jobs.length);
    check('未发生恢复', ws.recoveredFromCorrupt === false);
    check('启动时生成了 state.json.bak', await exists(stateBackupFile));
  }

  console.log('\n[2] 主文件损坏 + 备份可用');
  await resetFiles();
  await fs.writeFile(stateBackupFile, stateFixture(['j_backup']), 'utf8');
  await fs.writeFile(stateFile, '{"jobs": [ this is not json', 'utf8');
  {
    const ws = await Workspace.open();
    check('从备份恢复出任务', ws.jobs.length === 1 && ws.jobs[0]?.id === 'j_backup', ws.jobs.map((job) => job.id));
    check('标记为发生过恢复', ws.recoveredFromCorrupt === true);
    const corrupts = await corruptFiles();
    check('损坏文件被隔离（state.json.corrupt-*）', corrupts.length === 1, corrupts);
    const rewritten = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { jobs: { id: string }[] };
    check('主文件被恢复后的状态覆盖', rewritten.jobs[0]?.id === 'j_backup');
  }

  console.log('\n[3] 主文件丢失 + 备份可用');
  await resetFiles();
  await fs.writeFile(stateBackupFile, stateFixture(['j_restored']), 'utf8');
  {
    const ws = await Workspace.open();
    check('从备份恢复', ws.jobs.length === 1 && ws.jobs[0]?.id === 'j_restored', ws.jobs.map((job) => job.id));
    check('标记为发生过恢复', ws.recoveredFromCorrupt === true);
  }

  console.log('\n[4] 主文件损坏 + 无备份');
  await resetFiles();
  await fs.writeFile(stateFile, 'not-json-at-all', 'utf8');
  {
    const ws = await Workspace.open();
    check('回落到空状态', ws.jobs.length === 0);
    check('标记为发生过恢复（上层会跳过素材清理）', ws.recoveredFromCorrupt === true);
    check('损坏文件被隔离', (await corruptFiles()).length === 1);
  }

  console.log('\n[5] 素材清理安全阀');
  await resetFiles();
  const orphanDir = path.join(storageDir, 'j_orphan_for_test');
  await fs.mkdir(orphanDir, { recursive: true });
  await fs.writeFile(path.join(orphanDir, 'model.glb'), 'fake', 'utf8');
  {
    const removed = await sweepStorage({ jobs: [] });
    check('没有任何任务记录时不删除素材目录', removed === 0 && (await exists(orphanDir)), { removed });
    const removedWithJob = await sweepStorage({ jobs: [{ id: 'j_other' }] });
    check('有任务记录时仍会清理真正的孤儿目录', removedWithJob === 1 && !(await exists(orphanDir)), {
      removedWithJob,
    });
  }

  console.log('\n[6] 过期上传暂存清理');
  await fs.mkdir(path.join(uploadsStagingDir, 'old_batch'), { recursive: true });
  await fs.mkdir(path.join(uploadsStagingDir, 'fresh_batch'), { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(path.join(uploadsStagingDir, 'old_batch'), twoDaysAgo, twoDaysAgo);
  {
    const removed = await sweepStaging(24 * 60 * 60 * 1000);
    check('只清理超过 24h 的暂存目录', removed === 1, { removed });
    check('过期目录已删除', !(await exists(path.join(uploadsStagingDir, 'old_batch'))));
    check('新目录保留', await exists(path.join(uploadsStagingDir, 'fresh_batch')));
  }

  console.log('\n[7] worker 取消语义');
  await resetFiles();
  const runningJob = (id: string, provider: 'hunyuan3d' | 'meshy') => ({
    ...jobFixture(id),
    phase: 'running',
    remoteJobId: `remote-${id}`,
    params: { ...jobFixture(id).params, provider },
  });
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      jobs: [
        { ...jobFixture('j_queued'), phase: 'queued' },
        runningJob('j_hunyuan_running', 'hunyuan3d'),
        runningJob('j_meshy_running', 'meshy'),
      ],
      settings: { activeProvider: 'hunyuan3d', providers: {} },
      animationDirs: [],
    }),
    'utf8',
  );
  {
    // 取消不该依赖真实网络：任何外部请求都模拟成 5xx
    globalThis.fetch = (async () => new Response('{"error":"mock"}', { status: 500 })) as typeof fetch;

    const ws = await Workspace.open();
    const worker = new GenerationWorker(ws, { pollIntervalMs: 1_000, maxConcurrency: 1 });

    const queued = await worker.cancel('j_queued');
    check('未提交到远端：not-submitted', queued.canceled && queued.remote === 'not-submitted', queued);
    check('未提交任务立即变 canceled', ws.findJob('j_queued')?.phase === 'canceled');

    const hunyuan = await worker.cancel('j_hunyuan_running');
    check('引擎没有取消接口：unsupported', hunyuan.canceled && hunyuan.remote === 'unsupported', hunyuan);
    check(
      '渠道状态立即 canceled 且记录 remoteCancel',
      ws.findJob('j_hunyuan_running')?.phase === 'canceled' &&
        ws.findJob('j_hunyuan_running')?.providerMeta.remoteCancel === 'unsupported',
      ws.findJob('j_hunyuan_running')?.providerMeta,
    );

    const meshy = await worker.cancel('j_meshy_running');
    check('远端调用失败也不影响本地取消', meshy.canceled && meshy.remote === 'failed', meshy);
    check('状态仍是 canceled', ws.findJob('j_meshy_running')?.phase === 'canceled');

    const again = await worker.cancel('j_queued');
    check('重复取消返回 canceled=false', again.canceled === false, again);
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

main().catch(async (err: unknown) => {
  console.error('测试异常退出:', (err as Error).stack ?? err);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  process.exit(1);
});
