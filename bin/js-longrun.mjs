#!/usr/bin/env node
import { runCli } from '../src/cli.mjs';
try { await runCli(); }
catch (error) { process.stderr.write(`js-longrun: ${error.message}\n`); process.exitCode = 1; }
