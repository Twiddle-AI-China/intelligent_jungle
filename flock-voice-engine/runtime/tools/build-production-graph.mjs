#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFixedProductionGraph } from './production-graph-config.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const graph = buildFixedProductionGraph(repoRoot);
process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
