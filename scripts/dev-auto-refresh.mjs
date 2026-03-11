import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const nodeExecutable = process.execPath;
const nodeDir = path.dirname(nodeExecutable);
const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
let syncing = false;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? -1}`));
    });
    child.on('error', reject);
  });
}

async function syncOnce() {
  if (syncing) {
    return;
  }

  syncing = true;
  try {
    await runCommand(nodeExecutable, ['scripts/sync-funds.mjs']);
  } catch (error) {
    console.error('[auto-refresh] sync failed:', error instanceof Error ? error.message : error);
  } finally {
    syncing = false;
  }
}

async function main() {
  await syncOnce();

  if (!fs.existsSync(viteBin)) {
    throw new Error(`Vite 未安装，缺少文件: ${viteBin}`);
  }

  const vite = spawn(nodeExecutable, [viteBin, '--host', '0.0.0.0', '--open'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const handleOutput = (chunk, writer) => {
    const text = chunk.toString();
    writer.write(text);
  };

  vite.stdout?.on('data', (chunk) => handleOutput(chunk, process.stdout));
  vite.stderr?.on('data', (chunk) => handleOutput(chunk, process.stderr));

  const timer = setInterval(() => {
    void syncOnce();
  }, 60_000);

  const shutdown = () => {
    clearInterval(timer);
    vite.kill();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  vite.on('exit', (code) => {
    clearInterval(timer);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
