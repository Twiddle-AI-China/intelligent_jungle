import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
const JAVASCRIPT_TYPES = new Set(['', 'application/javascript', 'module', 'text/javascript']);

function collectFiles(roots, extensions) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extensions.has(extname(entry.name))) found.push(path);
    }
  };
  for (const root of roots) visit(resolve(root));
  return found.sort((left, right) => left.localeCompare(right, 'en'));
}

export function collectJavaScriptFiles(roots) {
  return collectFiles(roots, JAVASCRIPT_EXTENSIONS);
}

export function checkJavaScriptFiles(files) {
  const failed = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0 || result.error) {
      failed.push(file);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) process.stderr.write(`${result.error.message}\n`);
    }
  }
  return failed;
}

export function collectInlineScripts(roots) {
  const found = [];
  for (const file of collectFiles(roots, new Set(['.html']))) {
    const html = readFileSync(file, 'utf8');
    const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let ordinal = 0;
    while ((match = pattern.exec(html)) !== null) {
      const attributes = match[1];
      if (/\bsrc\s*=/i.test(attributes)) continue;
      const typeMatch = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const type = (typeMatch?.[1] ?? '').toLowerCase();
      if (!JAVASCRIPT_TYPES.has(type)) continue;
      ordinal += 1;
      found.push({
        label: `${file}#inline-${ordinal}`,
        source: match[2],
        module: type === 'module',
      });
    }
  }
  return found.sort((left, right) => left.label.localeCompare(right.label, 'en'));
}

export function checkInlineScripts(scripts) {
  const failed = [];
  for (const script of scripts) {
    const args = script.module ? ['--check', '--input-type=module', '-'] : ['--check', '-'];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', input: script.source });
    if (result.status !== 0 || result.error) {
      failed.push(script.label);
      if (result.stderr) process.stderr.write(`${script.label}\n${result.stderr}`);
      if (result.error) process.stderr.write(`${script.label}\n${result.error.message}\n`);
    }
  }
  return failed;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const files = collectJavaScriptFiles(['src', 'mvp/src', 'flock-voice-engine/client']);
  const inlineScripts = collectInlineScripts(['flock-voice-engine/client']);
  if (files.length === 0) {
    process.stderr.write('没有找到 JavaScript 源文件\n');
    process.exitCode = 1;
  } else {
    const failed = [...checkJavaScriptFiles(files), ...checkInlineScripts(inlineScripts)];
    if (failed.length > 0) process.exitCode = 1;
    else process.stdout.write(
      `checked ${files.length} JavaScript files and ${inlineScripts.length} inline scripts\n`,
    );
  }
}
