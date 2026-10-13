// The Node runtime: node:sqlite files, the real disk, packages/ui off the disk,
// and node:net for the probe. Importing it provides nothing; call nodeRuntime().
import net from 'node:net';
import { nodeFiles } from './files-node.ts';
import type { Runtime } from './runtime.ts';
import { nodeSql } from './sql-node.ts';
import { nodeUi } from './ui-node.ts';

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (online: boolean) => {
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function nodeRuntime(): Promise<Runtime> {
  return { sql: nodeSql, files: nodeFiles, ui: await nodeUi(), probe };
}
