import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse as parseJs } from 'acorn';
import * as walk from 'acorn-walk';
import { parse as parseHtml } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

const ASSET_EXTENSION = /\.(?:avif|css|gif|html?|ico|jpe?g|json|mp3|ogg|png|svg|wav|webp|woff2?)$/i;
const CODE_EXTENSION = /\.(?:c?js|mjs|json|css|html?|py)$/i;

export function selectPythonInterpreter({ env = process.env, platform = process.platform } = {}) {
  const configured = env.PYTHON?.trim();
  return configured || (platform === 'win32' ? 'python' : 'python3');
}

function graphError(source, line, detail) {
  const error = new Error(`PRODUCTION_GRAPH_UNRESOLVED_EDGE: ${source}:${line}: ${detail}`);
  error.code = 'PRODUCTION_GRAPH_UNRESOLVED_EDGE';
  throw error;
}

function posix(value) { return value.split(sep).join('/'); }
function localSpecifier(value) {
  return typeof value === 'string' && (value.startsWith('.') || value.startsWith('/'));
}
function runtimeApiTarget(value) {
  if (value.startsWith('/api/')) return `runtime-api:${value}`;
  try {
    const url = new URL(value);
    if (url.origin === 'http://127.0.0.1:18090' && url.pathname.startsWith('/api/')) {
      return `runtime-api:${url.pathname}`;
    }
  } catch { /* not an absolute URL */ }
  return null;
}
function importMetaUrl(node) {
  return node?.type === 'MemberExpression' && node.computed === false
    && node.object?.type === 'MetaProperty' && node.object.meta.name === 'import'
    && node.object.property.name === 'meta' && node.property?.name === 'url';
}
function literal(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
  }
  return null;
}
function globalMemberName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression'
      && node.object?.type === 'Identifier'
      && ['window', 'globalThis', 'self'].includes(node.object.name)) {
    return node.computed ? literal(node.property) : node.property?.name ?? null;
  }
  return null;
}
function dynamicGlobalMember(node) {
  return node?.type === 'MemberExpression' && node.computed === true
    && node.object?.type === 'Identifier'
    && ['window', 'globalThis', 'self'].includes(node.object.name)
    && literal(node.property) === null;
}
function memberPath(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type !== 'MemberExpression') return null;
  const base = memberPath(node.object);
  const property = node.computed ? literal(node.property) : node.property?.name;
  if (base === 'document' && property === 'defaultView') return 'window';
  if (['window', 'globalThis', 'self'].includes(base)
      && ['window', 'globalThis', 'self'].includes(property)) return base;
  return base && property ? `${base}.${property}` : null;
}
function guardedHostValue(node) {
  if (!node) return false;
  if (node.type === 'Identifier') {
    return ['window', 'globalThis', 'self', 'Reflect', 'Object'].includes(node.name);
  }
  if (node.type === 'SequenceExpression') return guardedHostValue(node.expressions.at(-1));
  if (node.type === 'ConditionalExpression') {
    return guardedHostValue(node.consequent) || guardedHostValue(node.alternate);
  }
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') {
    return guardedHostValue(node.left) || guardedHostValue(node.right);
  }
  if (node.type === 'ArrayExpression') return node.elements.some(guardedHostValue);
  if (node.type === 'ObjectExpression') {
    return node.properties.some((property) => guardedHostValue(property.value));
  }
  if (node.type === 'AwaitExpression' || node.type === 'ChainExpression'
      || node.type === 'UnaryExpression') return guardedHostValue(node.argument ?? node.expression);
  if (node.type !== 'MemberExpression') return false;
  const path = memberPath(node);
  if (['window', 'globalThis', 'self', 'Reflect', 'Object'].includes(path)) return true;
  return !['Identifier', 'MemberExpression'].includes(node.object?.type)
    && guardedHostValue(node.object);
}
function potentialHostReceiver(node, callReturnsHost = () => false) {
  if (guardedHostValue(node)) return true;
  return (node?.type === 'CallExpression' || node?.type === 'NewExpression')
    && (callReturnsHost(node) || node.arguments.some(guardedHostValue));
}
function dynamicAudioWorkletMember(node) {
  return node?.type === 'MemberExpression' && node.computed === true
    && memberPath(node.object)?.endsWith('.audioWorklet') && literal(node.property) === null;
}
function guardedCapability(node) {
  const path = memberPath(node);
  return ['window.fetch', 'globalThis.fetch', 'self.fetch',
    'window.Worker', 'globalThis.Worker', 'self.Worker',
    'window.SharedWorker', 'globalThis.SharedWorker', 'self.SharedWorker',
    'window.eval', 'globalThis.eval', 'self.eval',
    'window.Function', 'globalThis.Function', 'self.Function',
    'Reflect.get', 'Object.getOwnPropertyDescriptor'].includes(path)
    || path?.endsWith('.audioWorklet.addModule');
}
function reflectedCapability(node) {
  const reflector = memberPath(node?.callee);
  if (!['Reflect.get', 'Object.getOwnPropertyDescriptor'].includes(reflector)) return false;
  const target = memberPath(node.arguments[0]);
  const property = literal(node.arguments[1]);
  if (['window', 'globalThis', 'self'].includes(target)
      || guardedHostValue(node.arguments[0])) {
    return property === null || ['fetch', 'Worker', 'SharedWorker', 'eval', 'Function']
      .includes(property);
  }
  return target?.endsWith('.audioWorklet')
    && (property === null || property === 'addModule');
}
function newUrlLiteral(node) {
  return node?.type === 'NewExpression' && node.callee?.type === 'Identifier'
    && node.callee.name === 'URL' && importMetaUrl(node.arguments?.[1])
    ? literal(node.arguments?.[0]) : null;
}

function parseJavaScript(source, file, emit, lineOffset = 0, realm = 'browser') {
  const browserExecutable = realm === 'browser' || realm === 'browser-library';
  let ast;
  try {
    ast = parseJs(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true,
      allowHashBang: true });
  } catch (error) { graphError(file, (error.loc?.line ?? 1) + lineOffset,
    `JavaScript parse: ${error.message}`); }
  const sourceLine = (node) => (node.loc?.start.line ?? 1) + lineOffset;
  const hostReturningFunctions = new Map();
  const summarizeFunction = (name, fn) => {
    if (!name) return;
    const parameters = new Map((fn.params ?? []).map((parameter, index) => [parameter.name, index]));
    const summary = { fixed: false, parameters: new Set() };
    const inspectReturn = (value) => {
      if (guardedHostValue(value)) summary.fixed = true;
      if (value?.type === 'Identifier' && parameters.has(value.name)) {
        summary.parameters.add(parameters.get(value.name));
      }
    };
    if (fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement') {
      inspectReturn(fn.body);
    } else walk.simple(fn.body, { ReturnStatement(node) { inspectReturn(node.argument); } });
    if (summary.fixed || summary.parameters.size) hostReturningFunctions.set(name, summary);
  };
  walk.simple(ast, {
    FunctionDeclaration(node) { summarizeFunction(node.id?.name, node); },
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier'
          && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
        summarizeFunction(node.id.name, node.init);
      }
      if (node.init?.type === 'Identifier' && node.init.name === 'URL'
          || ['window.URL', 'globalThis.URL', 'self.URL'].includes(memberPath(node.init))) {
        graphError(file, sourceLine(node), 'URL constructor alias');
      }
      if (node.id?.type === 'ObjectPattern'
          && ['window', 'globalThis', 'self'].includes(memberPath(node.init))
          && node.id.properties.some((property) => (property.computed
            ? literal(property.key) : property.key?.name) === 'URL')) {
        graphError(file, sourceLine(node), 'URL constructor alias');
      }
    },
    AssignmentExpression(node) {
      if (node.right?.type === 'Identifier' && node.right.name === 'URL') {
        graphError(file, sourceLine(node), 'URL constructor alias');
      }
    },
  });
  let summariesChanged = true;
  while (summariesChanged) {
    summariesChanged = false;
    walk.simple(ast, { VariableDeclarator(node) {
      if (node.id?.type !== 'Identifier' || node.init?.type !== 'Identifier') return;
      const summary = hostReturningFunctions.get(node.init.name);
      if (summary && !hostReturningFunctions.has(node.id.name)) {
        hostReturningFunctions.set(node.id.name, summary); summariesChanged = true;
      }
    } });
  }
  const callReturnsHost = (node) => {
    if ((node?.type === 'CallExpression' || node?.type === 'NewExpression')
        && node.arguments.some((argument) => argument?.type !== 'ObjectExpression'
          && guardedHostValue(argument))) return true;
    if (node?.callee?.type !== 'Identifier') return false;
    const summary = hostReturningFunctions.get(node.callee.name);
    return Boolean(summary && (summary.fixed || [...summary.parameters]
      .some((index) => guardedHostValue(node.arguments[index])
        || callReturnsHost(node.arguments[index]))));
  };
  const add = (node, kind, value) => emit(value, sourceLine(node), kind);
  walk.simple(ast, {
    ImportDeclaration(node) { add(node, 'js.import', node.source.value); },
    ExportNamedDeclaration(node) { if (node.source) add(node, 'js.reexport', node.source.value); },
    ExportAllDeclaration(node) { add(node, 'js.reexport', node.source.value); },
    ImportExpression(node) {
      const value = literal(node.source);
      if (value === null) graphError(file, sourceLine(node), 'non-literal dynamic import');
      add(node, 'js.dynamic-import', value);
    },
    NewExpression(node) {
      if (browserExecutable && dynamicGlobalMember(node.callee)) {
        graphError(file, sourceLine(node), 'non-literal computed global constructor');
      }
      const calleePath = memberPath(node.callee);
      const constructor = ['window.Worker', 'globalThis.Worker', 'self.Worker',
        'window.SharedWorker', 'globalThis.SharedWorker', 'self.SharedWorker']
        .includes(calleePath) ? calleePath.split('.').at(-1) : globalMemberName(node.callee);
      if (browserExecutable && (constructor === 'Function'
          || ['window.Function', 'globalThis.Function', 'self.Function'].includes(calleePath))) {
        graphError(file, sourceLine(node), 'dynamic code constructor');
      }
      if (browserExecutable && ['Worker', 'SharedWorker'].includes(constructor)) {
        const value = literal(node.arguments[0]) ?? newUrlLiteral(node.arguments[0]);
        if (value === null) graphError(file, sourceLine(node), `non-literal ${constructor}`);
        add(node, `js.${constructor.toLowerCase()}`, value);
      }
      if (node.callee?.type === 'Identifier' && node.callee.name === 'URL'
          && importMetaUrl(node.arguments?.[1])) {
        const value = literal(node.arguments[0]);
        if (value === null) graphError(file, sourceLine(node), 'non-literal import.meta.url');
        add(node, 'js.url', value);
      }
    },
    CallExpression(node) {
      if (browserExecutable
          && (dynamicGlobalMember(node.callee) || dynamicAudioWorkletMember(node.callee))) {
        graphError(file, sourceLine(node), 'non-literal computed global call');
      }
      if (browserExecutable && (['eval', 'Function'].includes(globalMemberName(node.callee))
          || ['window.eval', 'globalThis.eval', 'self.eval',
            'window.Function', 'globalThis.Function', 'self.Function']
            .includes(memberPath(node.callee)))) {
        graphError(file, sourceLine(node), 'dynamic code execution');
      }
      const executableProperty = node.callee?.type === 'MemberExpression'
        ? (node.callee.computed ? literal(node.callee.property) : node.callee.property?.name) : null;
      if (browserExecutable && ['fetch', 'Worker', 'SharedWorker', 'eval', 'Function']
        .includes(executableProperty)
          && !['window.fetch', 'globalThis.fetch', 'self.fetch',
            'window.Worker', 'globalThis.Worker', 'self.Worker',
            'window.SharedWorker', 'globalThis.SharedWorker', 'self.SharedWorker']
            .includes(memberPath(node.callee))
          && potentialHostReceiver(node.callee.object, callReturnsHost)) {
        graphError(file, sourceLine(node), 'tainted host capability call');
      }
      if (browserExecutable && (globalMemberName(node.callee) === 'fetch'
          || ['window.fetch', 'globalThis.fetch', 'self.fetch'].includes(memberPath(node.callee)))) {
        const value = literal(node.arguments[0]);
        if (value === null && realm !== 'browser-library') {
          graphError(file, sourceLine(node), 'non-literal fetch');
        }
        add(node, 'js.fetch', value ?? 'external:configurable-fetch');
      }
      if (browserExecutable && node.callee?.type === 'MemberExpression'
          && (node.callee.computed ? literal(node.callee.property) : node.callee.property?.name)
            === 'addModule') {
        if (realm === 'browser-library'
            && !memberPath(node.callee)?.endsWith('.audioWorklet.addModule')) {
          graphError(file, sourceLine(node), 'configurable addModule receiver');
        }
        const value = literal(node.arguments[0]) ?? newUrlLiteral(node.arguments[0]);
        if (value === null && realm !== 'browser-library') {
          graphError(file, sourceLine(node), 'non-literal AudioWorklet module');
        }
        add(node, 'js.audio-worklet', value ?? 'external:configurable-audio-worklet');
      }
    },
    Literal(node) {
      const value = literal(node);
      if (value && ASSET_EXTENSION.test(value)
          && (value.startsWith('assets/') || value.startsWith('./') || value.startsWith('../'))) {
        add(node, 'js.static-asset', value);
      }
    },
    TemplateLiteral(node) {
      if (node.expressions.length > 0 && node.quasis.some((quasi) => {
        const value = quasi.value.cooked ?? quasi.value.raw;
        return value.startsWith('assets/') || value.startsWith('/assets/') || value.startsWith('./assets/')
          || value.startsWith('../assets/');
      })) graphError(file, sourceLine(node), 'non-literal static asset');
      const value = literal(node);
      if (value && ASSET_EXTENSION.test(value)
          && (value.startsWith('assets/') || value.startsWith('./') || value.startsWith('../'))) {
        add(node, 'js.static-asset', value);
      }
    },
  });
  if (!browserExecutable) return;
  walk.ancestor(ast, {
    CallExpression(node) {
      if (reflectedCapability(node)) {
        graphError(file, sourceLine(node), 'reflected executable capability read');
      }
    },
    MemberExpression(node, _state, ancestors) {
      if (dynamicGlobalMember(node)) {
        graphError(file, sourceLine(node), 'non-literal computed global capability read');
      }
      if (!guardedCapability(node)) return;
      const parent = ancestors.at(-2);
      const direct = (parent?.type === 'CallExpression' || parent?.type === 'NewExpression')
        && parent.callee === node;
      if (!direct) graphError(file, sourceLine(node), 'guarded executable capability alias');
    },
    VariableDeclarator(node) {
      if (guardedHostValue(node.init) || callReturnsHost(node.init)) {
        graphError(file, sourceLine(node), 'guarded host object alias');
      }
      if (node.id?.type !== 'ObjectPattern'
          || !['window', 'globalThis', 'self', 'Reflect', 'Object']
            .includes(memberPath(node.init))) return;
      for (const property of node.id.properties) {
        const name = property.computed ? literal(property.key) : property.key?.name;
        if ((property.computed && name === null)
            || ['fetch', 'Worker', 'SharedWorker', 'get', 'getOwnPropertyDescriptor'].includes(name)) {
          graphError(file, sourceLine(property), 'destructured executable capability alias');
        }
      }
    },
    AssignmentExpression(node) {
      if (guardedHostValue(node.right) || callReturnsHost(node.right)) {
        graphError(file, sourceLine(node), 'guarded host object alias');
      }
    },
    Identifier(node, _state, ancestors) {
      if (!['fetch', 'Worker', 'SharedWorker', 'eval', 'Function', 'URL'].includes(node.name)) return;
      const parent = ancestors.at(-2);
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      const grandparent = ancestors.at(-3);
      if (node.name === 'URL' && parent?.type === 'MemberExpression' && parent.object === node
          && grandparent?.type === 'CallExpression' && grandparent.callee === parent) return;
      const direct = (parent?.type === 'CallExpression' || parent?.type === 'NewExpression')
        && parent.callee === node;
      if (!direct) graphError(file, sourceLine(node), 'guarded executable capability alias');
    },
  });
}

function walkHtml(node, emit, sourceFile) {
  if (node.tagName) {
    const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name, value]));
    const line = node.sourceCodeLocation?.startLine ?? 1;
    for (const { name, value } of node.attrs ?? []) {
      const normalizedScheme = value.replace(/[\u0000-\u0020]+/g, '');
      if (name.toLowerCase().startsWith('on') || /^javascript:/i.test(normalizedScheme)
          || name.toLowerCase() === 'srcdoc'
          || (['src', 'data'].includes(name.toLowerCase()) && /^data:/i.test(normalizedScheme)
            && ['script', 'iframe', 'object', 'embed'].includes(node.tagName))) {
        graphError(sourceFile, line, 'inline HTML executable attribute');
      }
    }
    for (const [name, kind] of [['src', 'html.src'], ['href', 'html.link']]) {
      if (name === 'href' && node.tagName !== 'link') continue;
      const value = attrs[name];
      if (value && !value.startsWith('#') && !/^(?:data:|mailto:)/.test(value)) {
        emit(value.split(/[?#]/, 1)[0], line, kind);
      }
    }
    const scriptType = String(attrs.type ?? '').split(';', 1)[0].trim().toLowerCase();
    if (node.tagName === 'script' && !attrs.src && scriptType === 'module') {
      const text = (node.childNodes ?? []).filter((child) => child.nodeName === '#text')
        .map((child) => child.value).join('');
      parseJavaScript(text, sourceFile, emit, line - 1);
    }
    const executableScriptType = !scriptType || scriptType === 'module'
      || /^(?:application\/(?:ecmascript|javascript|x-ecmascript|x-javascript)|text\/(?:ecmascript|javascript(?:1\.[0-5])?|jscript|livescript|x-ecmascript|x-javascript))$/.test(scriptType);
    if (node.tagName === 'script' && !attrs.src && executableScriptType) {
      const text = (node.childNodes ?? []).filter((child) => child.nodeName === '#text')
        .map((child) => child.value).join('');
      if (scriptType !== 'module') parseJavaScript(text, sourceFile, emit, line - 1);
    }
    if (node.tagName === 'style') {
      const text = (node.childNodes ?? []).filter((child) => child.nodeName === '#text')
        .map((child) => child.value).join('');
      parseCss(text, sourceFile, emit, line - 1);
    }
  }
  for (const child of node.childNodes ?? []) walkHtml(child, emit, sourceFile);
}

function parseCss(source, file, emit, lineOffset = 0) {
  let root;
  try { root = postcss.parse(source, { from: file }); }
  catch (error) { graphError(file, (error.line ?? 1) + lineOffset,
    `CSS parse: ${error.message}`); }
  root.walkAtRules('import', (rule) => {
    const parsed = valueParser(rule.params).nodes.find((node) => node.type === 'string'
      || (node.type === 'function' && node.value === 'url'));
    const value = parsed?.type === 'function' ? valueParser.stringify(parsed.nodes) : parsed?.value;
    if (!value) graphError(file, rule.source.start.line, 'non-literal CSS import');
    emit(value.replace(/^['"]|['"]$/g, ''), rule.source.start.line + lineOffset, 'css.import');
  });
  root.walkDecls((decl) => valueParser(decl.value).walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const value = valueParser.stringify(node.nodes).trim().replace(/^['"]|['"]$/g, '');
    if (!value || value.startsWith('data:')) return;
    emit(value, decl.source.start.line + lineOffset, 'css.url');
  }));
}

const PYTHON_EXTRACTOR = String.raw`
import ast, json, sys
p=sys.argv[1]
tree=ast.parse(open(p, encoding='utf-8').read(), filename=p)
out=[]
dynamic_names={'__import__'}
dynamic_modules={'importlib', 'builtins'}
getattr_names={'getattr'}
vars_names={'vars'}
code_names={'exec','eval','compile'}
setattr_names={'setattr'}
for n in ast.walk(tree):
  if isinstance(n, ast.Import):
    for a in n.names:
      if a.name in ('importlib','builtins'): dynamic_modules.add(a.asname or a.name)
  elif isinstance(n, ast.ImportFrom) and n.module in ('importlib','builtins'):
    for a in n.names:
      if a.name in ('import_module','__import__'): dynamic_names.add(a.asname or a.name)
      if a.name == 'getattr': getattr_names.add(a.asname or a.name)
      if a.name == 'vars': vars_names.add(a.asname or a.name)
      if a.name in ('exec','eval','compile'): code_names.add(a.asname or a.name)
      if a.name == 'setattr': setattr_names.add(a.asname or a.name)
dynamic_dicts=set()
attribute_categories={}
def expression_path(value):
  if isinstance(value, ast.Name): return value.id
  if isinstance(value, ast.Attribute):
    base=expression_path(value.value)
    return base+'.'+value.attr if base else ''
  if isinstance(value, ast.Subscript):
    if isinstance(value.value, ast.Attribute) and value.value.attr == '__dict__':
      base=expression_path(value.value.value)
      key=value.slice.value if isinstance(value.slice, ast.Constant) and isinstance(value.slice.value,str) else '[]'
      return base+'.'+key if base else ''
    base=expression_path(value.value)
    return base+'[]' if base else ''
  return ''
def categories(value):
  if isinstance(value, ast.Name):
    out=set()
    if value.id in getattr_names: out.add('getattr')
    if value.id in vars_names: out.add('vars')
    if value.id in dynamic_names: out.add('dynamic_name')
    if value.id in dynamic_modules: out.add('dynamic_module')
    if value.id in dynamic_dicts: out.add('dynamic_dict')
    if value.id in code_names: out.add('code_exec')
    if value.id in setattr_names: out.add('setattr')
    return out
  if isinstance(value, ast.Attribute):
    path=expression_path(value)
    if path in attribute_categories: return set(attribute_categories[path])
    base=categories(value.value)
    if 'dynamic_module' in base:
      if value.attr in ('import_module','__import__'): return {'dynamic_name'}
      if value.attr == '__dict__': return {'dynamic_dict'}
      if value.attr == 'getattr': return {'getattr'}
      if value.attr == 'vars': return {'vars'}
      if value.attr in ('exec','eval','compile'): return {'code_exec'}
      if value.attr == 'setattr': return {'setattr'}
    return set()
  if isinstance(value, (ast.Tuple,ast.List,ast.Set)):
    return set().union(*(categories(item) for item in value.elts)) if value.elts else set()
  if isinstance(value, ast.Dict):
    return set().union(*(categories(item) for item in value.values)) if value.values else set()
  if isinstance(value, ast.Subscript):
    path=expression_path(value)
    if path in attribute_categories: return set(attribute_categories[path])
    return categories(value.value)
  if isinstance(value, ast.IfExp): return categories(value.body) | categories(value.orelse)
  if isinstance(value, ast.BoolOp):
    return set().union(*(categories(item) for item in value.values))
  if isinstance(value, ast.NamedExpr): return categories(value.value)
  if isinstance(value, ast.BinOp): return categories(value.left) | categories(value.right)
  if isinstance(value, ast.UnaryOp): return categories(value.operand)
  if isinstance(value, ast.Call):
    function=categories(value.func)
    call_values=list(value.args)+[item.value for item in value.keywords]
    arguments=set().union(*(categories(item) for item in call_values)) if call_values else set()
    if 'vars' in function and 'dynamic_module' in arguments: return {'dynamic_dict'}
    return arguments
  return set()
def target_names(target):
  if isinstance(target, ast.Name): return [target.id]
  if isinstance(target, (ast.Tuple,ast.List)):
    return [name for item in target.elts for name in target_names(item)]
  return []
changed=True
while changed:
  changed=False
  for n in ast.walk(tree):
    if not isinstance(n, (ast.Assign, ast.AnnAssign)): continue
    value=n.value
    targets=n.targets if isinstance(n, ast.Assign) else [n.target]
    names=[name for target in targets for name in target_names(target)]
    found=categories(value)
    groups=[]
    if 'getattr' in found: groups.append(getattr_names)
    if 'vars' in found: groups.append(vars_names)
    if 'dynamic_name' in found: groups.append(dynamic_names)
    if 'dynamic_module' in found: groups.append(dynamic_modules)
    if 'dynamic_dict' in found: groups.append(dynamic_dicts)
    if 'code_exec' in found: groups.append(code_names)
    if 'setattr' in found: groups.append(setattr_names)
    for group in groups:
      before=len(group)
      group.update(names)
      if len(group) != before: changed=True
    for target in targets:
      path=expression_path(target) if isinstance(target, (ast.Attribute,ast.Subscript)) else ''
      if path:
        before=set(attribute_categories.get(path,set()))
        after=before | found
        attribute_categories[path]=after
        if after != before: changed=True
    if isinstance(value, ast.Name):
      for name in names:
        for path,stored in list(attribute_categories.items()):
          if path.startswith(value.id+'.') or path.startswith(value.id+'[]'):
            alias=name+path[len(value.id):]
            before=set(attribute_categories.get(alias,set()))
            after=before | stored
            attribute_categories[alias]=after
            if after != before: changed=True
for n in ast.walk(tree):
  if isinstance(n, ast.Import):
    for a in n.names:
      out.append({'kind':'python.import','module':a.name,'level':0,'line':n.lineno,'names':[]})
      if a.name in ('importlib','builtins'): dynamic_modules.add(a.asname or a.name)
  elif isinstance(n, ast.ImportFrom):
    names=[a.name for a in n.names]
    out.append({'kind':'python.from','module':n.module or '','level':n.level,'line':n.lineno,'names':names})
    if n.module in ('importlib','builtins'):
      for a in n.names:
        if a.name in ('import_module','__import__'): dynamic_names.add(a.asname or a.name)
  elif isinstance(n, (ast.Assign,ast.AnnAssign)):
    value=n.value
    targets=n.targets if isinstance(n,ast.Assign) else [n.target]
    for target in targets:
      if isinstance(target,ast.Subscript) and isinstance(target.value,ast.Call) and 'vars' in categories(target.value.func) and categories(value):
        out.append({'kind':'python.dynamic','line':n.lineno})
  elif isinstance(n, ast.Call):
    name=''
    if isinstance(n.func, ast.Name): name=n.func.id
    elif isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name): name=n.func.value.id+'.'+n.func.attr
    function_categories=categories(n.func)
    if 'dynamic_name' in function_categories or 'code_exec' in function_categories or name in dynamic_names or any(name == m+'.import_module' or name == m+'.__import__' for m in dynamic_modules):
      out.append({'kind':'python.dynamic','line':n.lineno})
    elif 'setattr' in function_categories and len(n.args) >= 3 and categories(n.args[2]):
      out.append({'kind':'python.dynamic','line':n.lineno})
    elif isinstance(n.func,ast.Attribute) and n.func.attr == '__setattr__' and len(n.args) >= 3 and categories(n.args[2]):
      out.append({'kind':'python.dynamic','line':n.lineno})
    elif isinstance(n.func,ast.Attribute) and n.func.attr == 'update' and isinstance(n.func.value,ast.Attribute) and n.func.value.attr == '__dict__' and any(categories(item) for item in list(n.args)+[item.value for item in n.keywords]):
      out.append({'kind':'python.dynamic','line':n.lineno})
    elif isinstance(n.func, ast.Attribute) and n.func.attr == '__getattribute__' and len(n.args) >= 1 and ('dynamic_module' in categories(n.func.value) or 'dynamic_module' in categories(n.args[0])):
      out.append({'kind':'python.dynamic','line':n.lineno})
    elif 'getattr' in function_categories and len(n.args) >= 2 and 'dynamic_module' in categories(n.args[0]):
      out.append({'kind':'python.dynamic','line':n.lineno})
  elif isinstance(n, ast.Subscript):
    if 'dynamic_dict' in categories(n.value):
      out.append({'kind':'python.dynamic','line':n.lineno})
print(json.dumps(out))
`;

export function buildProductionGraph({ repoRoot, roots, realmOverrides = {} }) {
  const absoluteRoot = realpathSync(resolve(repoRoot));
  const queue = roots.map((root) => { const path = posix(root.path); return { ...root, path,
    realm: realmOverrides[path] ?? (root.kind === 'html' ? 'browser' : root.kind) }; });
  const files = new Set();
  const parsed = new Set();
  const edges = [];

  function validatePath(candidate, source, line) {
    const absolute = resolve(absoluteRoot, candidate);
    const rel = relative(absoluteRoot, absolute);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      graphError(source, line, `outside repository: ${candidate}`);
    }
    let cursor = absoluteRoot;
    for (const part of rel.split(sep).filter(Boolean)) {
      const names = readdirSync(cursor);
      const exact = names.filter((name) => name === part);
      const folded = names.filter((name) => name.toLowerCase() === part.toLowerCase());
      if (exact.length !== 1 || folded.length !== 1) graphError(source, line, `case ambiguity: ${candidate}`);
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) graphError(source, line, `symlink: ${candidate}`);
    }
    if (realpathSync(absolute) !== absolute) graphError(source, line, `non-canonical path: ${candidate}`);
    return posix(rel);
  }

  function resolveEdge(source, value, line, kind) {
    const runtimeApi = runtimeApiTarget(value);
    if (runtimeApi) return runtimeApi;
    if (value.startsWith('external:')) return value;
    const documentRelative = kind.startsWith('html.') || kind.startsWith('css.');
    if (!localSpecifier(value) && !value.startsWith('assets/') && !documentRelative) {
      if (value === 'ws') return 'external:ws';
      graphError(source, line, `undeclared external ${kind}: ${value}`);
    }
    let candidate;
    if (value.startsWith('/assets/')) candidate = `flock-voice-engine${value}`;
    else if (value.startsWith('/')) candidate = value.slice(1);
    else if (value.startsWith('assets/') && source.startsWith('mvp/src/')) candidate = `mvp/${value}`;
    else candidate = posix(join(dirname(source), value));
    const attempts = [candidate];
    if (!extname(candidate)) attempts.push(`${candidate}.js`, `${candidate}.mjs`, `${candidate}.py`,
      `${candidate}/index.js`, `${candidate}/__init__.py`);
    for (const attempt of attempts) {
      try {
        const absolute = resolve(absoluteRoot, attempt);
        if (statSync(absolute).isFile() || statSync(absolute).isDirectory()) {
          return validatePath(attempt, source, line);
        }
      } catch { /* try next exact resolution */ }
    }
    graphError(source, line, `unresolved ${kind}: ${value}`);
  }

  function addEdge(source, value, line, kind, realm) {
    if (value.startsWith('external:')) {
      edges.push({ source, line, kind, specifier: value, resolved: value });
      return;
    }
    if (value.startsWith('node:')) return;
    const target = resolveEdge(source, value, line, kind);
    if (target === null) return;
    if (realm === 'node' && kind === 'js.url' && /\.(?:c?js|mjs)$/.test(target)
        && !Object.hasOwn(realmOverrides, target)) {
      graphError(source, line, `served JavaScript realm undeclared: ${target}`);
    }
    edges.push({ source, line, kind: target.startsWith('external:') ? 'js.external'
      : target.startsWith('runtime-api:') ? 'js.runtime-api' : kind,
      specifier: value, resolved: target });
    if (target.startsWith('external:') || target.startsWith('runtime-api:')) return;
    const inheritedRealm = realm === 'browser-library' ? 'browser' : realm;
    if (statSync(resolve(absoluteRoot, target)).isDirectory()) {
      const pending = [target];
      while (pending.length) {
        const directory = pending.pop();
        for (const name of readdirSync(resolve(absoluteRoot, directory)).sort()) {
          const child = validatePath(posix(join(directory, name)), source, line);
          if (statSync(resolve(absoluteRoot, child)).isDirectory()) pending.push(child);
          else queue.push({ kind: extname(child).slice(1), path: child,
            realm: realmOverrides[child] ?? inheritedRealm });
        }
      }
    } else queue.push({ kind: extname(target).slice(1), path: target,
      realm: realmOverrides[target] ?? inheritedRealm });
  }

  while (queue.length) {
    const next = queue.shift();
    const file = validatePath(next.path, '<root>', 1);
    const parseKey = `${next.realm}:${file}`;
    if (parsed.has(parseKey)) continue;
    parsed.add(parseKey);
    files.add(file);
    const source = readFileSync(resolve(absoluteRoot, file), 'utf8');
    const extension = extname(file).toLowerCase();
    // An HTML document is a browser execution boundary even when a Node route
    // discovers it as a static asset. Its scripts must never inherit Node's
    // provider-capability policy.
    const edgeRealm = extension === '.html' || extension === '.htm' || extension === '.css'
      ? 'browser' : next.realm;
    const emit = (value, line, kind) => addEdge(file, value, line, kind, edgeRealm);
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      parseJavaScript(source, file, emit, 0, next.realm);
    } else if (extension === '.html' || extension === '.htm') {
      walkHtml(parseHtml(source, { sourceCodeLocationInfo: true }), emit, file);
    } else if (extension === '.css') parseCss(source, file, emit);
    else if (extension === '.py') {
      let imports;
      try { imports = JSON.parse(execFileSync(selectPythonInterpreter(), ['-c', PYTHON_EXTRACTOR,
        resolve(absoluteRoot, file)], { encoding: 'utf8' })); }
      catch (error) { graphError(file, 1, `Python AST: ${error.message}`); }
      for (const item of imports) {
        if (item.kind === 'python.dynamic') graphError(file, item.line, 'Python dynamic import');
        const parts = item.module ? item.module.split('.') : [];
        let base;
        if (item.level > 0) {
          base = dirname(file);
          for (let index = 1; index < item.level; index += 1) base = dirname(base);
        } else if (parts[0] === 'server') base = 'flock-voice-engine';
        else {
          const local = posix(join(dirname(file), ...parts));
          const repo = posix(join(...parts));
          const localExists = [local, `${local}.py`, `${local}/__init__.py`].some((candidate) => {
            try { return statSync(resolve(absoluteRoot, candidate)).isFile(); } catch { return false; }
          });
          const repoExists = [repo, `${repo}.py`, `${repo}/__init__.py`].some((candidate) => {
            try { return statSync(resolve(absoluteRoot, candidate)).isFile(); } catch { return false; }
          });
          if (!localExists && !repoExists) continue;
          base = localExists ? dirname(file) : '';
        }
        const specifier = posix(join(base, ...parts));
        let target = resolveEdge(file, `/${specifier}`, item.line, item.kind);
        if (statSync(resolve(absoluteRoot, target)).isDirectory()) {
          target = validatePath(`${target}/__init__.py`, file, item.line);
        }
        edges.push({ source: file, line: item.line, kind: item.kind,
          specifier: '.'.repeat(item.level) + item.module, resolved: target });
        queue.push({ kind: 'python', path: target, realm: 'python' });
        const moduleDirectory = target.endsWith('/__init__.py') ? dirname(target) : null;
        for (const name of item.names ?? []) {
          if (!moduleDirectory || name === '*') continue;
          const childSpecifier = posix(join(moduleDirectory, name));
          const candidates = [`${childSpecifier}.py`, `${childSpecifier}/__init__.py`];
          const child = candidates.find((candidate) => {
            try { return statSync(resolve(absoluteRoot, candidate)).isFile(); } catch { return false; }
          });
          if (!child) continue;
          const resolvedChild = validatePath(child, file, item.line);
          edges.push({ source: file, line: item.line, kind: 'python.from-name',
            specifier: `${'.'.repeat(item.level)}${item.module}${item.module ? '.' : ''}${name}`,
            resolved: resolvedChild });
          queue.push({ kind: 'python', path: resolvedChild });
        }
        let packageDirectory = dirname(target);
        while (packageDirectory && packageDirectory !== '.') {
          const packageInit = posix(join(packageDirectory, '__init__.py'));
          try {
            if (statSync(resolve(absoluteRoot, packageInit)).isFile()) {
              queue.push({ kind: 'python', path: validatePath(packageInit, file, item.line) });
            }
          } catch { /* namespace package */ }
          packageDirectory = dirname(packageDirectory);
        }
      }
    } else if (!CODE_EXTENSION.test(file) && !ASSET_EXTENSION.test(file)) {
      graphError(file, 1, 'unsupported production file');
    }
  }

  const sortedFiles = [...files].sort();
  const sortedEdges = edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const fileSha256 = Object.fromEntries(sortedFiles.map((file) => [file, createHash('sha256')
    .update(readFileSync(resolve(absoluteRoot, file))).digest('hex')]));
  const canonical = JSON.stringify({ files: sortedFiles, edges: sortedEdges, fileSha256 });
  return Object.freeze({ files: Object.freeze(sortedFiles), edges: Object.freeze(sortedEdges),
    fileSha256: Object.freeze(fileSha256),
    sha256: createHash('sha256').update(canonical).digest('hex') });
}
