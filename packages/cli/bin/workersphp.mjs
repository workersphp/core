#!/usr/bin/env node
import { main } from '../src/index.mjs';

process.exit(await main(process.argv.slice(2)));
