import { mergeConfig } from 'vitest/config';
import base from '../../vitest.config';
const config = mergeConfig(base, {});
config.test = { ...config.test, include: ['tests/runtime/copied-card-origin.native.ts', 'tests/runtime/reminder-origin.native.ts', 'tests/runtime/reminder-origin-writer.native.ts'], fileParallelism: false, maxWorkers: 1 };
export default config;
