#!/usr/bin/env node
import { HELP, parseCommand, runtime } from './lib/runtime.mjs';

try {
  const { command, values } = parseCommand(process.argv.slice(2));
  if (command === 'install' || command === 'configure') {
    throw new Error('安装和配置请在终端运行 npx linger-image-gen install 或 npx linger-image-gen configure。');
  }
  await runtime(command, values);
} catch (error) {
  console.error(`Linger Image Gen: ${error.message}`);
  process.exitCode = 1;
}
