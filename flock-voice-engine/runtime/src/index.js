import { loadRuntimeConfig } from './config.js';
import { loadReleaseInfo } from './release-info.js';
import { createCandidateServer } from './server.js';

loadRuntimeConfig();
const releaseInfo = loadReleaseInfo();
const server = createCandidateServer({ releaseInfo });

server.listen(18090, '127.0.0.1');
