/**
 * @license
 * Copyright (c) 2019 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt The complete set of authors may be found
 * at http://polymer.github.io/AUTHORS.txt The complete set of contributors may
 * be found at http://polymer.github.io/CONTRIBUTORS.txt Code distributed by
 * Google as part of the polymer project is also subject to an additional IP
 * rights grant found at http://polymer.github.io/PATENTS.txt
 */

require('source-map-support').install();
require('chromedriver');
require('geckodriver');

import * as fs from 'fs-extra';
import * as path from 'path';
import * as table from 'table';

import {Builder} from 'selenium-webdriver';
import commandLineArgs = require('command-line-args');
import commandLineUsage = require('command-line-usage');
import ansi = require('ansi-escape-sequences');

import {BenchmarkResult, BenchmarkSpec, BenchmarkSession} from './types';
import {Server} from './server';

const repoRoot = path.resolve(__dirname, '..', '..');

const validBrowsers = new Set([
  'chrome',
  'firefox',
]);

const optDefs: commandLineUsage.OptionDefinition[] = [
  {
    name: 'help',
    description: 'Show documentation',
    type: Boolean,
    defaultValue: false,
  },
  {
    name: 'host',
    description: 'Which host to run on',
    type: String,
    defaultValue: '127.0.0.1',
  },
  {
    name: 'port',
    description: 'Which port to run on (0 for random free)',
    type: Number,
    defaultValue: '0',
  },
  {
    name: 'name',
    description: 'Which benchmarks to run (* for all)',
    alias: 'n',
    type: String,
    defaultValue: '*',
  },
  {
    name: 'implementation',
    description: 'Which implementations to run (* for all)',
    alias: 'i',
    type: String,
    defaultValue: 'lit-html',
  },
  {
    name: 'browser',
    description: 'Which browsers to launch in automatic mode, ' +
        `comma-delimited (${[...validBrowsers].join(' ,')})`,
    alias: 'b',
    type: String,
    defaultValue: 'chrome',
  },
  {
    name: 'trials',
    description: 'How many times to run each benchmark',
    alias: 't',
    type: Number,
    defaultValue: 10,
  },
  {
    name: 'manual',
    description: 'Don\'t run automatically, just show URLs and collect results',
    alias: 'm',
    type: Boolean,
    defaultValue: false,
  },
];

interface Opts {
  help: boolean;
  host: string;
  port: number;
  name: string;
  implementation: string;
  browser: string;
  trials: number;
  manual: boolean;
}

const ignoreFiles = new Set([
  'node_modules',
  'package.json',
  'package-lock.json',
]);

async function specsFromOpts(opts: Opts): Promise<BenchmarkSpec[]> {
  const specs: BenchmarkSpec[] = [];
  let impls;
  if (opts.implementation === '*') {
    impls = await fs.readdir(path.join(repoRoot, 'benchmarks'));
    impls = impls.filter((dir) => !ignoreFiles.has(dir));
  } else {
    impls = opts.implementation.split(',');
  }
  for (const implementation of impls) {
    const dir = path.join(repoRoot, 'benchmarks', implementation);
    let benchmarks;
    if (opts.name === '*') {
      benchmarks = await fs.readdir(dir);
      benchmarks = benchmarks.filter((dir) => !ignoreFiles.has(dir));
    } else {
      benchmarks = opts.name.split(',');
    }
    for (const name of benchmarks) {
      specs.push({
        name,
        implementation,
        trials: opts.trials,
      });
    }
  }
  return specs;
}

export async function saveRun(
    benchmarkName: string, session: BenchmarkSession) {
  const filename = path.resolve(
      __dirname, '..', '..', 'benchmarks', benchmarkName, 'runs.json');
  let data: {sessions: BenchmarkSession[]}|undefined;
  let contents: string|undefined;
  try {
    contents = await fs.readFile(filename, 'utf-8');
  } catch (e) {
  }
  if (contents !== undefined && contents.trim() !== '') {
    data = JSON.parse(contents);
  }
  if (data === undefined) {
    data = {sessions: []};
  }
  if (data.sessions === undefined) {
    data.sessions = [];
  }
  data.sessions.push(session);
  fs.writeFile(filename, JSON.stringify(data));
}

const tableHeaders = [
  'Benchmark',       // 0
  'Implementation',  // 1
  'Browser',         // 2
  '(Version)',       // 3
  'Trials',          // 4
  'Worst (ms)',      // 5
  'Avg (ms)',        // 6
].map((header) => ansi.format(`[bold]{${header}}`));

const tableColumns: {[key: string]: table.ColumnConfig} = {
  0: {
    width: 10,
  },
  1: {
    width: 15,
  },
  2: {
    width: 8,
  },
  3: {
    width: 12,
  },
  4: {
    alignment: 'center',
    width: 6,
  },
  5: {
    alignment: 'right',
    width: 10,
  },
  6: {
    alignment: 'right',
    width: 8,
  },
};

function formatResultRow(result: BenchmarkResult): string[] {
  const millis = result.millis;
  const len = millis.length;
  const sum = millis.reduce((acc, cur) => acc + cur);
  const avg = sum / len;
  const worst = Math.max(...millis);
  return [
    result.name,
    result.implementation,
    result.browser.name,
    result.browser.version,
    len.toString(),
    worst.toFixed(3),
    avg.toFixed(3),
  ];
}

async function main() {
  const opts = commandLineArgs(optDefs) as Opts;
  if (opts.help) {
    console.log(commandLineUsage([{
      header: 'lit-benchmarks-runner',
      optionList: optDefs,
    }]));
    return;
  }

  if (opts.trials <= 0) {
    throw new Error('--trials must be > 0');
  }

  const specs = await specsFromOpts(opts);
  const server = await Server.start({
    host: opts.host,
    port: opts.port,
    rootDir: repoRoot,
  });

  if (opts.manual === true) {
    const urlTable: string[][] = [];
    for (const spec of specs) {
      urlTable.push([
        spec.name,
        spec.implementation,
        server.specUrl(spec),
      ]);
    }
    console.log();
    console.log('Visit these URLs in any browser:');
    console.log();
    console.log(table.table(urlTable));

    console.log('Results will appear below:');
    console.log();
    const stream = table.createStream({
      columnCount: tableHeaders.length,
      columns: tableColumns,
      columnDefault: {
        width: 18,
      },
    });
    // TODO(aomarks) Upstream this type to DT, it's wrong.
    const streamWrite = stream.write as unknown as (cols: string[]) => void;
    streamWrite(tableHeaders);
    (async function() {
      for await (const result of server.streamResults()) {
        streamWrite(formatResultRow(result));
      }
    })();

  } else {
    const browsers = new Set(
        opts.browser.replace(/\s+/, '').split(',').filter((b) => b !== ''));
    if (browsers.size === 0) {
      throw new Error('At least one --browser must be specified');
    }
    for (const b of browsers) {
      if (validBrowsers.has(b) === false) {
        throw new Error(`Unknown --browser '${b}'`);
      }
    }

    const tableData: string[][] = [];
    tableData.push(tableHeaders);
    for (const browser of browsers) {
      console.log(`Launching ${browser}`);
      const driver = await new Builder().forBrowser(browser).build();
      for (const spec of specs) {
        console.log(
            `    Running benchmark ${spec.name} in ${spec.implementation}`);
        const run = server.runBenchmark(spec);
        await driver.get(run.url);
        const result = await run.result;
        // const fullName = `${spec.implementation}-${spec.benchmark}`;
        // const runData = await getRunData(fullName, results);
        // await saveRun(fullName, runData);
        tableData.push(formatResultRow(result));
      }
      console.log();
      await driver.close();
    }

    console.log(table.table(tableData, {columns: tableColumns}));
  }

  await server.close();
}

main();
