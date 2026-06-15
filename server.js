#!/usr/bin/env node

import { startApp } from './src/app.js';

startApp().catch((error) => {
  console.error('[Startup] Failed to start application:', error);
  process.exit(1);
});
