// Importing this module makes node:sqlite the app's SQL host, for code that
// only needs a database (the test runner loads it with `--import`). Entry
// points that run the whole app call provideRuntime(await nodeRuntime()).
import { provideSql } from './sql.ts';
import { nodeSql } from './sql-node.ts';

provideSql(nodeSql);
