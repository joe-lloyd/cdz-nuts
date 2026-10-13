// The Node server: the web app (app.ts) behind node:http, on node:sqlite files
// and the real disk. The Worker (worker.ts) is the same app on workerd.
import { createBackground } from './background.ts';
import { serveFetch } from './http-node.ts';
import { provideRuntime } from './runtime.ts';
import { nodeRuntime } from './runtime-node.ts';

provideRuntime(await nodeRuntime());
// Loaded after the runtime is provided: the app builds its stores on import.
const { handle, backgroundJobs } = await import('./app.ts');

const PORT = Number(process.env.PORT ?? 8080);
const background = createBackground(backgroundJobs, Date.now());
setInterval(() => background.tick(Date.now()), 5_000);
background.tick(Date.now());

serveFetch(handle).listen(PORT, () => console.log(`taste-db ui on :${PORT}`));
