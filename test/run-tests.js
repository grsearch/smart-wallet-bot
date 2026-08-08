'use strict';

// Loading the test files in one process also works in restricted Windows
// service environments where node --test cannot spawn per-file workers.
require('./executor-interface.test');
require('./config-defaults.test');
require('./parser.test');
require('./smart-wallet-stream.test');
require('./position-store.test');
require('./copy-trader.test');
require('./dashboard-server.test');
