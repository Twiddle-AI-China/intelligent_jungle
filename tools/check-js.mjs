import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
const JAVASCRIPT_TYPES = new Set(['', 'application/javascript', 'module', 'text/javascript']);

function isHtmlSpace(character) {
  return character === ' ' || character === '\t' || character === '\n'
    || character === '\f' || character === '\r';
}

function parseHtmlAttributes(source) {
  const attributes = new Map();
  let offset = 0;

  while (offset < source.length) {
    while (offset < source.length && isHtmlSpace(source[offset])) offset += 1;
    if (source[offset] === '/') {
      offset += 1;
      continue;
    }

    const nameStart = offset;
    while (offset < source.length
      && !isHtmlSpace(source[offset])
      && source[offset] !== '/'
      && source[offset] !== '=') {
      offset += 1;
    }
    if (nameStart === offset) {
      offset += 1;
      continue;
    }

    const name = source.slice(nameStart, offset).toLowerCase();
    while (offset < source.length && isHtmlSpace(source[offset])) offset += 1;

    let value = '';
    if (source[offset] === '=') {
      offset += 1;
      while (offset < source.length && isHtmlSpace(source[offset])) offset += 1;
      const quote = source[offset] === '"' || source[offset] === "'" ? source[offset] : null;
      if (quote) {
        offset += 1;
        const valueStart = offset;
        while (offset < source.length && source[offset] !== quote) offset += 1;
        value = source.slice(valueStart, offset);
        if (source[offset] === quote) offset += 1;
      } else {
        const valueStart = offset;
        while (offset < source.length && !isHtmlSpace(source[offset])) offset += 1;
        value = source.slice(valueStart, offset);
      }
    }

    if (!attributes.has(name)) attributes.set(name, value);
  }

  return attributes;
}

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

export function checkJavaScriptFiles(files, { classicFiles = new Set() } = {}) {
  const failed = [];
  const classicPaths = new Set([...classicFiles].map((file) => resolve(file)));
  for (const file of files) {
    const path = resolve(file);
    const inputType = classicPaths.has(path) ? 'commonjs' : 'module';
    const result = spawnSync(
      process.execPath,
      ['--check', `--input-type=${inputType}`, '-'],
      { encoding: 'utf8', input: readFileSync(path, 'utf8') },
    );
    if (result.status !== 0 || result.error) {
      failed.push(file);
      if (result.stderr) process.stderr.write(`${file}\n${result.stderr}`);
      if (result.error) process.stderr.write(`${file}\n${result.error.message}\n`);
    }
  }
  return failed;
}

export function collectClassicJavaScriptFiles(roots) {
  const found = new Set();
  for (const file of collectFiles(roots, new Set(['.html']))) {
    const html = readFileSync(file, 'utf8');
    const pattern = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const attributes = parseHtmlAttributes(match[1]);
      if (!attributes.has('src')) continue;
      const type = (attributes.get('type') ?? '').trim().toLowerCase();
      if (!JAVASCRIPT_TYPES.has(type) || type === 'module') continue;

      const source = attributes.get('src').trim();
      if (!source) continue;
      let url;
      try {
        url = new URL(source, pathToFileURL(file));
      } catch {
        continue;
      }
      if (url.protocol !== 'file:') continue;
      url.search = '';
      url.hash = '';
      found.add(fileURLToPath(url));
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right, 'en'));
}

export function collectInlineScripts(roots) {
  const found = [];
  for (const file of collectFiles(roots, new Set(['.html']))) {
    const html = readFileSync(file, 'utf8');
    const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let match;
    let ordinal = 0;
    while ((match = pattern.exec(html)) !== null) {
      const attributes = parseHtmlAttributes(match[1]);
      if (attributes.has('src')) continue;
      const type = (attributes.get('type') ?? '').trim().toLowerCase();
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
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const clientRoots = [join(repoRoot, 'flock-voice-engine', 'client')];
  const files = collectJavaScriptFiles([
    join(repoRoot, 'src'),
    join(repoRoot, 'mvp', 'src'),
    ...clientRoots,
  ]);
  const inlineScripts = collectInlineScripts(clientRoots);
  const classicFiles = new Set(collectClassicJavaScriptFiles(clientRoots));
  if (files.length === 0) {
    process.stderr.write('没有找到 JavaScript 源文件\n');
    process.exitCode = 1;
  } else {
    const failed = [
      ...checkJavaScriptFiles(files, { classicFiles }),
      ...checkInlineScripts(inlineScripts),
    ];
    if (failed.length > 0) process.exitCode = 1;
    else process.stdout.write(
      `checked ${files.length} JavaScript files and ${inlineScripts.length} inline scripts\n`,
    );
  }
}
