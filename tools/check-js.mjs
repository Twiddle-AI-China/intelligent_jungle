import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

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
  for (const root of roots) {
    const path = resolve(root);
    const stats = statSync(path);
    if (stats.isDirectory()) visit(path);
    else if (stats.isFile() && extensions.has(extname(path))) found.push(path);
  }
  return found.sort((left, right) => left.localeCompare(right, 'en'));
}

function isTagNameBoundary(character) {
  return character === undefined || isHtmlSpace(character) || character === '>' || character === '/';
}

function findOpenTagEnd(html, start) {
  let quote = null;
  for (let offset = start; offset < html.length; offset += 1) {
    const character = html[offset];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return offset;
    }
  }
  return -1;
}

function isAsciiLetter(character) {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function findNextScriptTag(html, lowerHtml, start) {
  let cursor = start;
  while (cursor < html.length) {
    const candidate = html.indexOf('<', cursor);
    if (candidate === -1) return null;
    if (html.startsWith('<!--', candidate)) {
      const commentEnd = html.indexOf('-->', candidate + 4);
      if (commentEnd === -1) return null;
      cursor = commentEnd + 3;
      continue;
    }

    const nameStart = candidate + 1;
    if (!isAsciiLetter(html[nameStart])) {
      if (html[nameStart] === '!' || html[nameStart] === '?'
        || (html[nameStart] === '/' && isAsciiLetter(html[nameStart + 1]))) {
        const tagEnd = findOpenTagEnd(html, nameStart + 1);
        if (tagEnd === -1) return null;
        cursor = tagEnd + 1;
      } else {
        cursor = candidate + 1;
      }
      continue;
    }

    let nameEnd = nameStart;
    while (nameEnd < html.length && !isTagNameBoundary(html[nameEnd])) nameEnd += 1;
    const tagEnd = findOpenTagEnd(html, nameEnd);
    if (tagEnd === -1) return null;
    if (lowerHtml.slice(nameStart, nameEnd) === 'script') {
      return { start: candidate, end: tagEnd };
    }
    cursor = tagEnd + 1;
  }
  return null;
}

function findClosingScriptTag(html, lowerHtml, start) {
  let cursor = start;
  while (cursor < html.length) {
    const candidate = lowerHtml.indexOf('</script', cursor);
    if (candidate === -1) return null;
    const nameEnd = candidate + '</script'.length;
    if (isTagNameBoundary(html[nameEnd])) {
      const tagEnd = html.indexOf('>', nameEnd);
      return tagEnd === -1 ? null : { start: candidate, end: tagEnd };
    }
    cursor = candidate + 2;
  }
  return null;
}

function collectScriptElements(roots) {
  const found = [];
  for (const file of collectFiles(roots, new Set(['.html']))) {
    const html = readFileSync(file, 'utf8');
    const lowerHtml = html.toLowerCase();
    let cursor = 0;
    while (cursor < html.length) {
      const openingTag = findNextScriptTag(html, lowerHtml, cursor);
      if (!openingTag) break;
      const attributesStart = openingTag.start + '<script'.length;
      const openTagEnd = openingTag.end;
      const closingTag = findClosingScriptTag(html, lowerHtml, openTagEnd + 1);
      if (!closingTag) break;
      found.push({
        file,
        attributes: parseHtmlAttributes(html.slice(attributesStart, openTagEnd)),
        source: html.slice(openTagEnd + 1, closingTag.start),
      });
      cursor = closingTag.end + 1;
    }
  }
  return found;
}

function isLocalRelativeScriptSource(source) {
  if (source.startsWith('/') || source.startsWith('\\')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

export function collectJavaScriptFiles(roots) {
  return collectFiles(roots, JAVASCRIPT_EXTENSIONS);
}

function checkClassicSource(source, label) {
  try {
    new Script(source, { filename: label, displayErrors: true });
    return false;
  } catch (error) {
    process.stderr.write(`${label}\n${error.stack ?? error.message ?? String(error)}\n`);
    return true;
  }
}

export function checkJavaScriptFiles(files, { classicFiles = new Set() } = {}) {
  const failed = [];
  const classicPaths = new Set([...classicFiles].map((file) => resolve(file)));
  for (const file of files) {
    const path = resolve(file);
    const source = readFileSync(path, 'utf8');
    if (classicPaths.has(path)) {
      if (checkClassicSource(source, file)) failed.push(file);
      continue;
    }
    const result = spawnSync(
      process.execPath,
      ['--check', '--input-type=module', '-'],
      { encoding: 'utf8', input: source },
    );
    if (result.status !== 0 || result.error) {
      failed.push(file);
      if (result.stderr) process.stderr.write(`${file}\n${result.stderr}`);
      if (result.error) process.stderr.write(`${file}\n${result.error.message}\n`);
    }
  }
  return failed;
}

export function collectLocalJavaScriptReferences(roots) {
  const found = new Map();
  for (const element of collectScriptElements(roots)) {
    if (!element.attributes.has('src')) continue;
    const type = (element.attributes.get('type') ?? '').trim().toLowerCase();
    if (!JAVASCRIPT_TYPES.has(type)) continue;

    const source = element.attributes.get('src').trim();
    if (!source || !isLocalRelativeScriptSource(source)) continue;
    try {
      const url = new URL(source, pathToFileURL(element.file));
      if (url.protocol !== 'file:') continue;
      url.search = '';
      url.hash = '';
      const path = fileURLToPath(url);
      const reference = { path, module: type === 'module' };
      found.set(`${path}\0${reference.module ? 'module' : 'classic'}`, reference);
    } catch {
      continue;
    }
  }
  return [...found.values()].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path, 'en');
    return byPath || Number(left.module) - Number(right.module);
  });
}

export function collectClassicJavaScriptFiles(roots) {
  const found = new Set(
    collectLocalJavaScriptReferences(roots)
      .filter((reference) => !reference.module)
      .map((reference) => reference.path),
  );
  return [...found].sort((left, right) => left.localeCompare(right, 'en'));
}

export function buildJavaScriptCheckPlan(sourceRoots, htmlRoots) {
  const references = collectLocalJavaScriptReferences(htmlRoots);
  const files = new Set(collectJavaScriptFiles(sourceRoots));
  const classicFiles = new Set();
  for (const reference of references) {
    files.add(reference.path);
    if (!reference.module) classicFiles.add(reference.path);
  }
  return {
    files: [...files].sort((left, right) => left.localeCompare(right, 'en')),
    classicFiles,
    references,
  };
}

export function collectInlineScripts(roots) {
  const found = [];
  const ordinals = new Map();
  for (const element of collectScriptElements(roots)) {
    if (element.attributes.has('src')) continue;
    const type = (element.attributes.get('type') ?? '').trim().toLowerCase();
    if (!JAVASCRIPT_TYPES.has(type)) continue;
    const ordinal = (ordinals.get(element.file) ?? 0) + 1;
    ordinals.set(element.file, ordinal);
    found.push({
      label: `${element.file}#inline-${ordinal}`,
      source: element.source,
      module: type === 'module',
    });
  }
  return found.sort((left, right) => left.label.localeCompare(right.label, 'en'));
}

export function checkInlineScripts(scripts) {
  const failed = [];
  for (const script of scripts) {
    if (!script.module) {
      if (checkClassicSource(script.source, script.label)) failed.push(script.label);
      continue;
    }
    const result = spawnSync(
      process.execPath,
      ['--check', '--input-type=module', '-'],
      { encoding: 'utf8', input: script.source },
    );
    if (result.status !== 0 || result.error) {
      failed.push(script.label);
      if (result.stderr) process.stderr.write(`${script.label}\n${result.stderr}`);
      if (result.error) process.stderr.write(`${script.label}\n${result.error.message}\n`);
    }
  }
  return failed;
}

const canonicalCheckerPath = realpathSync(fileURLToPath(import.meta.url));
let invokedDirectly = false;
if (process.argv[1]) {
  try {
    invokedDirectly = canonicalCheckerPath === realpathSync(resolve(process.argv[1]));
  } catch {
    invokedDirectly = false;
  }
}

if (invokedDirectly) {
  const repoRoot = resolve(dirname(canonicalCheckerPath), '..');
  const clientRoots = [join(repoRoot, 'flock-voice-engine', 'client')];
  const runtimeRoot = join(repoRoot, 'flock-voice-engine', 'runtime', 'src');
  const htmlRoots = [
    join(repoRoot, 'index.html'),
    join(repoRoot, 'mvp', 'index.html'),
    ...clientRoots,
  ];
  const { files, classicFiles } = buildJavaScriptCheckPlan(
    [join(repoRoot, 'src'), join(repoRoot, 'mvp', 'src'), ...clientRoots, runtimeRoot],
    htmlRoots,
  );
  const inlineScripts = collectInlineScripts(htmlRoots);
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
