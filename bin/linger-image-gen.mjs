#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main().catch((error) => {
  if (error.name === 'ExitPromptError' || error.name === 'AbortPromptError') {
    console.error('\n已取消，未提交安装配置。');
    process.exitCode = 130;
  } else {
    // Do not print stacks, request objects, headers or provider response bodies.
    console.error(`Linger Image Gen: ${error.message}`);
    process.exitCode = 1;
  }
});
