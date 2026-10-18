// A deliberately small YAML subset parser/writer.
//
// It only understands what this project's `config/config.yaml` uses:
//   - nested mappings by indentation
//   - block sequences (`- item`) and flow sequences (`[a, b]`)
//   - strings (plain / double-quoted / single-quoted), booleans, numbers, null
//   - `#` comments, either on their own line or after a value
//
// It is NOT a general YAML implementation. Keeping it dependency-free means the
// control panel runs on a stock Node.js install with no `npm install` step.

function isSpace(ch) {
  return ch === ' ' || ch === '\t';
}

export function findCommentStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || isSpace(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

function splitFlow(body) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += body[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

export function parseValue(raw) {
  const value = String(raw).trim();
  if (value === '') return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitFlow(value.slice(1, -1)).map((part) => parseValue(part));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function serializeString(value) {
  const plain = /^[A-Za-z0-9_./-]+$/.test(value);
  const reserved = /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(value);
  if (plain && !reserved) return value;
  return JSON.stringify(value);
}

export function serializeValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot serialize number: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => serializeValue(item)).join(', ')}]`;
  if (typeof value === 'object') throw new Error('cannot serialize an object as a scalar');
  return serializeString(String(value));
}

/**
 * Parse the subset into `{ data, index }`.
 *
 * `index` maps a dot path (e.g. `l2.dm_per_day`) to the line that defines it,
 * so the writer can update a value in place and keep every comment intact.
 */
export function parse(text) {
  const data = {};
  const index = new Map();
  const logical = [];
  const lines = String(text).split(/\r?\n/);

  lines.forEach((raw, lineNumber) => {
    const comment = findCommentStart(raw);
    const body = (comment === -1 ? raw : raw.slice(0, comment)).replace(/\s+$/, '');
    if (!body.trim()) return;
    const indent = body.length - body.trimStart().length;
    logical.push({ lineNumber, indent, body });
  });

  const stack = [{ indent: -1, type: 'map', path: '', obj: data }];
  for (let cursor = 0; cursor < logical.length; cursor += 1) {
    const { lineNumber, indent, body } = logical[cursor];
    const trimmed = body.trim();

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const frame = stack[stack.length - 1] ?? null;

    if (trimmed === '-' || trimmed.startsWith('- ')) {
      if (!frame || frame.type !== 'list') {
        throw new Error(`line ${lineNumber + 1}: sequence item without a parent key`);
      }
      const item = trimmed === '-' ? null : parseValue(trimmed.slice(2));
      frame.arr.push(item);
      index.set(`${frame.path}[${frame.arr.length - 1}]`, {
        line: lineNumber,
        indent,
        kind: 'item',
        path: frame.path,
      });
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(trimmed);
    if (!match) throw new Error(`line ${lineNumber + 1}: cannot parse "${trimmed}"`);
    if (!frame || frame.type !== 'map') {
      throw new Error(`line ${lineNumber + 1}: key "${match[1]}" has no mapping parent`);
    }

    const key = match[1];
    const rest = match[2].trim();
    const keyPath = frame.path ? `${frame.path}.${key}` : key;
    const parent = frame.obj;

    if (rest === '') {
      const next = logical[cursor + 1];
      const nextIsList = Boolean(
        next && next.indent > indent && (next.body.trim() === '-' || next.body.trim().startsWith('- ')),
      );
      if (nextIsList) {
        const arr = [];
        parent[key] = arr;
        stack.push({ indent, type: 'list', path: keyPath, arr });
        index.set(keyPath, { line: lineNumber, indent, kind: 'block', path: keyPath });
      } else {
        const child = {};
        parent[key] = child;
        stack.push({ indent, type: 'map', path: keyPath, obj: child });
        index.set(keyPath, { line: lineNumber, indent, kind: 'map', path: keyPath });
      }
      continue;
    }

    parent[key] = parseValue(rest);
    index.set(keyPath, { line: lineNumber, indent, kind: 'scalar', path: keyPath });
  }

  return { data, index };
}

export function getPath(data, dotPath) {
  return dotPath.split('.').reduce((node, key) => (node == null ? undefined : node[key]), data);
}

function rewriteLineWithValue(line, serialized) {
  const commentAt = findCommentStart(line);
  const head = (commentAt === -1 ? line : line.slice(0, commentAt)).replace(/\s+$/, '');
  const comment = commentAt === -1 ? '' : ` ${line.slice(commentAt)}`;
  const colon = head.indexOf(':');
  if (colon === -1) throw new Error(`line is not a key/value pair: ${line}`);
  return `${head.slice(0, colon + 1)} ${serialized}${comment}`;
}

/**
 * Replace one value, preserving indentation, key name and a trailing comment.
 * Block sequences are collapsed into flow style (`[a, b]`) when written.
 */
export function setValue(text, dotPath, value) {
  const { index } = parse(text);
  const entry = index.get(dotPath);
  if (!entry) throw new Error(`unknown config key: ${dotPath}`);
  if (entry.kind === 'map') throw new Error(`cannot assign a section: ${dotPath}`);

  const lines = String(text).split(/\r?\n/);
  const serialized = serializeValue(value);

  if (entry.kind === 'scalar') {
    lines[entry.line] = rewriteLineWithValue(lines[entry.line], serialized);
    return lines.join('\n');
  }

  if (entry.kind === 'block') {
    let end = entry.line + 1;
    while (end < lines.length) {
      const candidate = lines[end];
      if (!candidate.trim()) break;
      const indent = candidate.length - candidate.trimStart().length;
      if (indent <= entry.indent) break;
      if (!candidate.trimStart().startsWith('-')) break;
      end += 1;
    }
    lines.splice(entry.line, end - entry.line, rewriteLineWithValue(lines[entry.line], serialized));
    return lines.join('\n');
  }

  throw new Error(`cannot assign a sequence item: ${dotPath}`);
}

export function applyUpdates(text, updates) {
  let next = text;
  for (const [dotPath, value] of Object.entries(updates)) {
    next = setValue(next, dotPath, value);
  }
  return next;
}
