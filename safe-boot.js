'use strict';

/**
 * safe-boot.js — DSH 桌面壳「安全启动」核心模块
 *
 * 职责：当 DSH 因插件/补丁配置错误无法启动时，解析启动日志、诊断出可临时禁用的
 * 插件或可移除的 bundle，并通过 safe-boot.patch.yml（--patch overlay）或直接修改
 * profile 的 package.json / cordis.patch.yml 让服务重新启动。
 *
 * 设计约束：
 * - 纯 Node CommonJS，无 Electron、无外部 npm 依赖；YAML 解析由 ctx.yaml 注入。
 * - 只操作 ctx.profileDir / ctx.stateDir 指向的目录，绝不触碰真实用户目录以外的文件。
 * - 所有状态集中在 stateDir/safe-boot.json，overlay 固定在 stateDir/safe-boot.patch.yml。
 * - 所有文件写入使用 UTF-8，备份文件名带时间戳，重复 apply 不会重复记录。
 */

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// ---------------------------------------------------------------------------
// 保护名单
// ---------------------------------------------------------------------------

/** 绝不能被自动禁用的核心入口 id（与 DSH requiredStartupEntryIds 对齐）。 */
const PROTECTED_ENTRY_IDS = Object.freeze([
  'agent-loop',
  'tool-executor-native',
  'tool-executor-ptc',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
]);

/** 绝不能被自动移除的基础 bundle。 */
const PROTECTED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]);

/** 环境类错误码：这类错误不是插件本身的问题，不能作为禁用插件的依据。 */
const ENVIRONMENT_ERROR_CODES = Object.freeze([
  'EADDRINUSE',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EMFILE',
  'EAGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

const STATE_FILENAME = 'safe-boot.json';
const OVERLAY_FILENAME = 'safe-boot.patch.yml';
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';
const PROFILE_PACKAGE_FILENAME = 'package.json';

const KIND_LABELS = {
  'startup-error': '插件启动失败',
  'patch-error': '补丁/配置解析失败',
  'manifest-error': 'profile 清单读取失败',
  'fatal-load': '致命加载错误',
  timeout: '启动等待超时',
  unknown: '未识别的启动错误',
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 判断入口 id 是否属于保护名单。 */
function isProtectedEntry(id) {
  return PROTECTED_ENTRY_IDS.includes(String(id == null ? '' : id));
}

/** 判断 bundle 包名是否属于保护名单。 */
function isProtectedBundle(name) {
  return PROTECTED_BUNDLES.includes(String(name == null ? '' : name));
}

/** 判断错误文本是否属于环境类错误（端口占用、权限等），这类错误不可禁用插件。 */
function isEnvironmentError(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  const re = new RegExp('\\b(' + ENVIRONMENT_ERROR_CODES.join('|') + ')\\b', 'i');
  return re.test(value);
}

/** 当前 ISO 时间（状态记录用）。 */
function nowIso() {
  return new Date().toISOString();
}

/** 备份文件名用的紧凑时间戳：YYYYMMDD-HHmmss-SSS（Windows 文件名安全）。 */
function fileStamp(date) {
  const d = date || new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    '-' +
    pad(d.getMilliseconds(), 3)
  );
}

/** 读取文本并去掉 BOM。 */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** 原子写文本（先写临时文件再改名，避免半截文件）。 */
function writeText(file, text) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* 目录已存在或只读场景由后续写入报错兜底 */
  }
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.writeFileSync(file, text, 'utf8');
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {
        /* 清理临时文件失败可忽略 */
      }
    }
    if (error && error.code === 'EPERM') return;
  }
}

/** 复制文件为带时间戳的备份；同毫秒冲突时追加序号。 */
function backupFile(file, prefix) {
  const dir = path.dirname(file);
  const stamp = fileStamp();
  let dest = path.join(dir, prefix + '-' + stamp);
  let index = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, prefix + '-' + stamp + '-' + index);
    index += 1;
  }
  fs.copyFileSync(file, dest);
  return dest;
}

/** 空的安全启动状态。 */
function emptyState() {
  return {
    version: 1,
    disabled: [],
    bundles: [],
    patchEdits: [],
    history: [],
  };
}

/** 把任意输入规范成合法的 SafeBootState（丢弃脏字段，保证调用方拿到稳定结构）。 */
function normalizeState(input) {
  const src = input && typeof input === 'object' ? input : {};
  const mapArray = (key, mapper) => {
    const list = Array.isArray(src[key]) ? src[key] : [];
    return list.filter((item) => item && typeof item === 'object').map(mapper);
  };
  return {
    version: 1,
    disabled: mapArray('disabled', (item) => ({
      id: String(item.id == null ? '' : item.id),
      module: String(item.module == null ? '' : item.module),
      reason: String(item.reason == null ? '' : item.reason),
      at: String(item.at == null ? '' : item.at),
    })),
    bundles: mapArray('bundles', (item) => ({
      name: String(item.name == null ? '' : item.name),
      index: Number.isInteger(item.index) ? item.index : 0,
      reason: String(item.reason == null ? '' : item.reason),
      at: String(item.at == null ? '' : item.at),
    })),
    patchEdits: mapArray('patchEdits', (item) => ({
      file: String(item.file == null ? '' : item.file),
      id: String(item.id == null ? '' : item.id),
      backup: String(item.backup == null ? '' : item.backup),
      at: String(item.at == null ? '' : item.at),
      reason: String(item.reason == null ? '' : item.reason),
    })),
    history: mapArray('history', (item) => ({
      action: String(item.action == null ? '' : item.action),
      detail: String(item.detail == null ? '' : item.detail),
      at: String(item.at == null ? '' : item.at),
    })),
  };
}

/** 深拷贝状态。 */
function cloneState(state) {
  return normalizeState(JSON.parse(JSON.stringify(normalizeState(state))));
}

/** 取状态目录（兼容 ctx.stateDir 缺失时退化为 profileDir/.safe-boot）。 */
function stateDirOf(ctx) {
  if (ctx && ctx.stateDir) return ctx.stateDir;
  if (ctx && ctx.profileDir) return path.join(ctx.profileDir, '.safe-boot');
  throw new Error('SafeBootContext 缺少 stateDir/profileDir');
}

/** 取 profileDir。 */
function profileDirOf(ctx) {
  if (ctx && ctx.profileDir) return ctx.profileDir;
  throw new Error('SafeBootContext 缺少 profileDir');
}

/** 统一路径比较格式（处理 file://、正反斜杠、Windows 大小写）。 */
function normalizeFsPath(value) {
  let text = String(value == null ? '' : value).trim();
  text = text.replace(/^["']|["']$/g, '');
  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text);
    } catch (_) {
      /* 非法 file URL 时保留原文本继续比较 */
    }
  }
  try {
    return path.resolve(text).replace(/\\/g, '/').toLowerCase();
  } catch (_) {
    return text.replace(/\\/g, '/').toLowerCase();
  }
}

/** 从补丁错误文本里提取文件路径与错误描述（Windows 盘符冒号不会误伤）。 */
function splitFileAndError(rest) {
  const text = String(rest == null ? '' : rest).trim();
  const marker = text.indexOf(': ');
  if (marker > 0) {
    return { file: text.slice(0, marker).trim(), error: text.slice(marker + 2).trim() };
  }
  return { file: text, error: '' };
}

/** 从堆栈文本中提取 node_modules 包名或 profiles/<name>/plugins/<name>。 */
function extractModuleFromStack(text) {
  const value = String(text == null ? '' : text).replace(/\\/g, '/');
  const plugin = value.match(/profiles\/[^\/]+\/plugins\/([^\/\s:]+)/i);
  if (plugin) return plugin[1];
  const re = /node_modules\/((?:@[^\/]+\/[^\/]+)|[^\/]+)\//gi;
  let match;
  let last = '';
  while ((match = re.exec(value)) !== null) last = match[1];
  return last;
}

/** 从补丁路径中提取 bundle 包名（取最后一个 node_modules/<pkg>/，兼容 pnpm 软链布局）。 */
function bundleNameFromPatchPath(file) {
  const value = String(file == null ? '' : file).replace(/\\/g, '/');
  const re = /node_modules\/((?:@[^\/]+\/[^\/]+)|[^\/]+)\//gi;
  let match;
  let last = '';
  while ((match = re.exec(value)) !== null) last = match[1];
  return last;
}

/** 读取 profile package.json 中的 dsh.profile.bundles，失败返回空数组。 */
function readProfileBundles(profileDir) {
  try {
    const pkg = JSON.parse(readText(path.join(profileDir, PROFILE_PACKAGE_FILENAME)));
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    return Array.isArray(bundles) ? bundles.filter((item) => typeof item === 'string') : [];
  } catch (_) {
    return [];
  }
}

/** 读取 profile 的 cordis.patch.yml 文本，不存在返回空串。 */
function readProfilePatchText(ctx) {
  try {
    return readText(path.join(profileDirOf(ctx), PROFILE_PATCH_FILENAME));
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 启动日志解析
// ---------------------------------------------------------------------------

/** 规范化 evidence 输入。 */
function normalizeEvidence(evidence) {
  if (typeof evidence === 'string') {
    return { stderrText: evidence, stdoutText: '', startupLogText: '' };
  }
  const src = evidence && typeof evidence === 'object' ? evidence : {};
  return {
    stderrText: typeof src.stderrText === 'string' ? src.stderrText : '',
    stdoutText: typeof src.stdoutText === 'string' ? src.stdoutText : '',
    startupLogText: typeof src.startupLogText === 'string' ? src.startupLogText : '',
  };
}

/** 判断某一行是否是下一个启动诊断段落标题。 */
function isDiagnosticSection(line) {
  return /^\s*(?:Failed plugins|Plugins waiting for services)\s*\(\d+\)\s*:\s*$/.test(line);
}

/** 判断 lines[index] 是否是一个失败插件条目的开始行（下一非空行必须是 Package:）。 */
function isPluginEntryStart(lines, index) {
  const line = lines[index];
  if (!/^\s{0,4}[^\s()]+(?:\s+\(required\))?\s*$/.test(line)) return false;
  if (!line.trim() || line.trim() === 'Package:') return false;
  let next = index + 1;
  while (next < lines.length && !lines[next].trim()) next += 1;
  return next < lines.length && /^\s*Package:\s*\S/.test(lines[next]);
}

/** 解析单个失败插件的 detail 行，拆出 phase 与 error。 */
function parseFailureDetail(detailLines) {
  const meaningful = detailLines.filter((line) => line.trim() !== '');
  if (meaningful.length === 0) return { phase: '', error: '' };
  const first = meaningful[0].trim();
  let phase = '';
  let error = first;
  const withError = first.match(/^(?:(.*?):\s+)?Error:\s*(.*)$/);
  if (withError) {
    phase = (withError[1] || '').trim();
    error = (withError[2] || '').trim();
  } else {
    const phaseOnly = first.match(/^([a-z][a-z0-9 _-]{2,48}):\s+(.+)$/i);
    if (phaseOnly) {
      phase = phaseOnly[1].trim();
      error = phaseOnly[2].trim();
    }
  }
  // 追加非堆栈的后续行（例如 Caused by / 嵌套原因），让 error 尽可能完整
  for (const line of meaningful.slice(1)) {
    const trimmed = line.trim();
    if (/^(?:at\s|async\s|\/|\(|file:\/\/)/.test(trimmed)) continue;
    if (/^(?:at\s)/.test(trimmed)) continue;
    if (trimmed.startsWith('Caused by:') || trimmed.startsWith('Error:')) {
      error += '\n' + trimmed;
    }
  }
  return { phase, error };
}

/** 解析所有 "Failed plugins (N):" 段落。 */
function parseFailedPlugins(lines) {
  const result = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*Failed plugins\s*\(\d+\)\s*:\s*$/.test(lines[i])) continue;
    let cursor = i + 1;
    while (cursor < lines.length) {
      if (isDiagnosticSection(lines[cursor]) && !/^\s*Failed plugins/.test(lines[cursor])) break;
      if (!isPluginEntryStart(lines, cursor)) {
        if (lines[cursor].trim() === '') {
          cursor += 1;
          continue;
        }
        // 遇到未知段落或其它非插件文本，结束本段
        if (/^\s*\S/.test(lines[cursor]) && !/^\s{2,}/.test(lines[cursor])) break;
        cursor += 1;
        continue;
      }
      const startLine = lines[cursor];
      const idMatch = startLine.trim().match(/^([^\s()]+)(?:\s+\(required\))?$/);
      if (!idMatch) {
        cursor += 1;
        continue;
      }
      const id = idMatch[1];
      const required = /\(required\)/.test(startLine);
      let packageLineIndex = cursor + 1;
      while (packageLineIndex < lines.length && !lines[packageLineIndex].trim()) packageLineIndex += 1;
      const packageMatch = lines[packageLineIndex].match(/^\s*Package:\s*(.+?)\s*$/);
      const moduleName = packageMatch ? packageMatch[1].trim() : '';
      const detailLines = [];
      let next = packageLineIndex + 1;
      while (next < lines.length) {
        if (isPluginEntryStart(lines, next)) break;
        if (isDiagnosticSection(lines[next])) break;
        detailLines.push(lines[next]);
        next += 1;
      }
      const detail = parseFailureDetail(detailLines);
      const key = id + '\u0000' + moduleName + '\u0000' + detail.phase + '\u0000' + detail.error;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          id,
          module: moduleName,
          required,
          phase: detail.phase,
          error: detail.error,
        });
      }
      cursor = next;
    }
  }
  return result;
}

/** 解析 "Plugins waiting for services (N):" 段落。 */
function parsePendingPlugins(lines) {
  const result = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*Plugins waiting for services\s*\(\d+\)\s*:\s*$/.test(lines[i])) continue;
    let cursor = i + 1;
    // 跳过表头 "Plugin ... Missing services"
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    if (cursor < lines.length && /^\s*Plugin\s+Missing services\s*$/.test(lines[cursor])) cursor += 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!line.trim()) break;
      if (isDiagnosticSection(line)) break;
      const row = line.match(/^\s{2,}([^\s()]+)(?:\s+\(required\))?\s+([^\s].*?)\s*$/);
      if (row) {
        const id = row[1];
        const missing = row[2]
          .split(/,\s*/)
          .map((item) => item.trim())
          .filter(Boolean);
        const key = id + '\u0000' + missing.join(',');
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ id, missing: missing.length ? missing : ['unknown'] });
        }
      }
      cursor += 1;
    }
  }
  return result;
}

/** 解析跳过的坏 bundle（warning，不是 fatal）。 */
function parseSkippedBundles(lines) {
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/\bdsh:\s*skipping profile bundle\s+("([^"]+)"|'([^']+)'|(\S+))\s*:\s*(.*)$/);
    if (!match) continue;
    const name = match[2] || match[3] || match[4] || '';
    const error = (match[5] || '').trim();
    if (!name) continue;
    const key = name + '\u0000' + error;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, error });
  }
  return result;
}

/** 解析补丁/配置层解析错误（fatal）。 */
function parsePatchErrors(lines) {
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    if (/skipping profile bundle/.test(line)) continue;
    const match = line.match(/\bdsh:\s*failed to (?:parse|read) (?:overlay|patches|config)\s+(.+)$/);
    if (!match) continue;
    const split = splitFileAndError(match[1]);
    // 跳过堆栈里打印的源码模板行（如 throw new Error(`dsh: failed to parse ... ${file}`)）：
    // 真实文件路径一定含斜杠，模板占位符/纯文本不是文件。
    if (!split.file || split.file.includes('${') || !/[\\/]/.test(split.file)) continue;
    const key = split.file + '\u0000' + split.error;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ file: split.file, error: split.error });
  }
  return result;
}

/** 解析 profile 清单错误（返回内部计数 + 明细，明细仅用于 summary）。 */
function parseManifestErrors(lines) {
  const result = [];
  for (const line of lines) {
    const readMatch = line.match(/\bdsh:\s*failed to read profile (?:manifest|package)\s+(.+)$/);
    if (readMatch) {
      const split = splitFileAndError(readMatch[1]);
      if (!split.file || split.file.includes('${') || !/[\\/]/.test(split.file)) continue;
      result.push({ file: split.file, error: split.error });
      continue;
    }
    const shapeMatch = line.match(/\bdsh:\s*profile manifest\s+(.+?)\s+must hold a JSON object\s*$/);
    if (shapeMatch) {
      result.push({ file: shapeMatch[1].trim(), error: 'must hold a JSON object' });
    }
  }
  return result;
}

/** 解析致命加载错误。 */
function parseFatalLoads(lines) {
  const result = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/\bdsh:\s*fatal (?:load failure|uncaught exception):\s*(.*)$/);
    if (!match) continue;
    let message = (match[1] || '').trim();
    message = message.replace(/^Error:\s*/, '');
    const block = [lines[i]];
    let cursor = i + 1;
    while (cursor < lines.length && lines[cursor].trim() && !/^\s*dsh:\s*/.test(lines[cursor])) {
      block.push(lines[cursor]);
      cursor += 1;
    }
    const moduleName = extractModuleFromStack(block.join('\n'));
    const key = moduleName + '\u0000' + message;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ module: moduleName, message });
  }
  return result;
}

/** 判断文本是否像“启动等待超时”。 */
function looksLikeTimeout(text) {
  const value = String(text == null ? '' : text);
  return (
    /(?:startup|service|启动|等待)[^\n]{0,100}(?:timeout|timed?\s*out|超时)/i.test(value) ||
    /timed?\s*out\s+(?:waiting|after)/i.test(value) ||
    /did not become ready/i.test(value) ||
    /服务未能(?:在|及时)就绪/.test(value)
  );
}

/** 生成中文 summary。 */
function buildSummary(kind, parts, counts) {
  const label = KIND_LABELS[kind] || KIND_LABELS.unknown;
  const segments = [];
  if (counts.failedPlugins > 0) {
    const ids = parts.failedPlugins.map((item) => item.id + (item.required ? '(必需)' : '')).join('、');
    segments.push(counts.failedPlugins + ' 个插件未激活：' + ids);
  }
  if (counts.pending > 0) {
    segments.push(counts.pending + ' 个插件等待服务：' + parts.pending.map((item) => item.id).join('、'));
  }
  if (counts.skippedBundles > 0) {
    segments.push(counts.skippedBundles + ' 个 bundle 被跳过：' + parts.skippedBundles.map((item) => item.name).join('、'));
  }
  if (counts.patchErrors > 0) {
    segments.push(counts.patchErrors + ' 处补丁/配置解析错误');
  }
  if (counts.manifestErrors > 0) {
    segments.push('检测到 ' + counts.manifestErrors + ' 处清单读取或 JSON 结构错误');
  }
  if (counts.fatalLoads > 0) {
    const modules = parts.fatalLoads.map((item) => item.module || '未知模块').join('、');
    segments.push(counts.fatalLoads + ' 个致命加载错误：' + modules);
  }
  if (counts.timeout) segments.push('启动等待超时');
  const detail = segments.length ? segments.join('；') : '未识别到已知的 DSH 启动错误模式';
  return label + '：' + detail;
}

/**
 * 解析启动失败证据，产出 Diagnosis。
 * @param {{stderrText?: string, stdoutText?: string, startupLogText?: string}|string} evidence
 * @returns {{
 *   kind: string,
 *   failedPlugins: Array<{id: string, module: string, required: boolean, phase: string, error: string}>,
 *   pending: Array<{id: string, missing: string[]}>,
 *   skippedBundles: Array<{name: string, error: string}>,
 *   patchErrors: Array<{file: string, error: string}>,
 *   fatalLoads: Array<{module: string, message: string}>,
 *   summary: string,
 *   raw: {stderrText: string, stdoutText: string, startupLogText: string}
 * }}
 */
function parseStartupFailure(evidence) {
  const raw = normalizeEvidence(evidence);
  const combined = [raw.stderrText, raw.stdoutText, raw.startupLogText]
    .filter((text) => typeof text === 'string' && text !== '')
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
  const lines = combined.split(/\r?\n/);

  const failedPlugins = parseFailedPlugins(lines);
  const pending = parsePendingPlugins(lines);
  const skippedBundles = parseSkippedBundles(lines);
  const patchErrors = parsePatchErrors(lines);
  const manifestErrors = parseManifestErrors(lines);
  const fatalLoads = parseFatalLoads(lines);
  const timeout = looksLikeTimeout(combined);

  let kind = 'unknown';
  if (patchErrors.length > 0) kind = 'patch-error';
  else if (manifestErrors.length > 0) kind = 'manifest-error';
  else if (/dsh:\s*startup failed\s*:/.test(combined)) kind = 'startup-error';
  else if (fatalLoads.length > 0) kind = 'fatal-load';
  else if (timeout) kind = 'timeout';

  const summary = buildSummary(kind, { failedPlugins, pending, skippedBundles, patchErrors, fatalLoads }, {
    failedPlugins: failedPlugins.length,
    pending: pending.length,
    skippedBundles: skippedBundles.length,
    patchErrors: patchErrors.length,
    manifestErrors: manifestErrors.length,
    fatalLoads: fatalLoads.length,
    timeout,
  });

  return {
    kind,
    failedPlugins,
    pending,
    skippedBundles,
    patchErrors,
    fatalLoads,
    summary,
    raw,
  };
}

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

/** 读取 safe-boot.json；不存在或损坏时返回空状态。 */
function readSafeBootState(ctx) {
  const file = path.join(stateDirOf(ctx), STATE_FILENAME);
  try {
    return normalizeState(JSON.parse(readText(file)));
  } catch (_) {
    return emptyState();
  }
}

/** 写入 safe-boot.json（UTF-8、2 空格、带换行）。 */
function writeSafeBootState(ctx, state) {
  const normalized = normalizeState(state);
  const file = path.join(stateDirOf(ctx), STATE_FILENAME);
  writeText(file, JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

// ---------------------------------------------------------------------------
// overlay 生成
// ---------------------------------------------------------------------------

/** 生成 YAML 标量：简单标识符不加引号，含特殊字符时用单引号。 */
function yamlScalar(value) {
  const text = String(value == null ? '' : value);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) return text;
  return "'" + text.replace(/'/g, "''") + "'";
}

/**
 * 根据状态生成 --patch overlay 的 YAML 文本（顶层数组）。
 * 只包含 disabled 条目；bundle 移除直接改 package.json，不在此表达。
 */
function buildSafeBootOverlay(state) {
  const normalized = normalizeState(state);
  const lines = [
    '# DSH safe-boot 自动禁用 overlay（由 safe-boot.js 生成，请勿手动编辑）',
    '# 该文件通过 dsh web --patch <本文件> 注入，用于临时禁用启动失败的插件。',
  ];
  if (normalized.disabled.length === 0) {
    lines.push('[]');
    return lines.join('\n') + '\n';
  }
  lines.push('');
  for (const item of normalized.disabled) {
    // 只写 id + disabled：patch 层对 name 的覆盖语义在 DSH 各版本不一致，
    // 带上 name 反而可能把条目指向错误模块；禁用只需要 id。
    lines.push('- id: ' + yamlScalar(item.id));
    lines.push('  disabled: true');
  }
  return lines.join('\n') + '\n';
}

/**
 * 把 overlay 同步到 stateDir/safe-boot.patch.yml。
 * 无禁用条目时删除旧 overlay 并返回 null。
 */
function syncSafeBootOverlay(ctx, state) {
  const normalized = normalizeState(state);
  const file = path.join(stateDirOf(ctx), OVERLAY_FILENAME);
  if (normalized.disabled.length === 0) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {
      /* 删除失败不阻断主流程 */
    }
    return null;
  }
  writeText(file, buildSafeBootOverlay(normalized));
  return file;
}

// ---------------------------------------------------------------------------
// 修复计划
// ---------------------------------------------------------------------------

/** 判断补丁错误文件是否是 profile 自己的 cordis.patch.yml。 */
function isProfilePatchFile(file, ctx) {
  try {
    const target = path.join(profileDirOf(ctx), PROFILE_PATCH_FILENAME);
    return normalizeFsPath(file) === normalizeFsPath(target);
  } catch (_) {
    return false;
  }
}

/** 查找顶层 "- id: <id>" 条目块；返回 [start, end) 行下标。 */
function findTopLevelEntryBlock(text, id) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const target = String(id == null ? '' : id);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^-\s+id:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
    if (match) {
      const value = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
      if (value === target) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^-(?:\s|$)/.test(line)) break; // 下一个顶层条目
    if (line.trim() !== '' && !/^\s/.test(line)) break; // 顶格注释/文档标记结束条目块
    end += 1;
  }
  return { start, end };
}

/** 判断 cordis.patch.yml 中是否存在顶层 id 条目（含带引号写法）。 */
function hasTopLevelEntry(text, id) {
  return findTopLevelEntryBlock(text, id) !== null;
}

/** 判断某条目是否已被 safe-boot 注释过。 */
function isPatchEntryCommented(text, id) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const target = String(id == null ? '' : id);
  for (const line of lines) {
    const match = line.match(/^#\s*-\s+id:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
    if (!match) continue;
    const value = match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3];
    if (value === target) return true;
  }
  return false;
}

/** 生成修复计划（按 priority 从高到低）。 */
function planSafeBootFixes(diagnosis, ctx) {
  const diag = diagnosis && typeof diagnosis === 'object' ? diagnosis : {};
  const profileDir = ctx && ctx.profileDir ? ctx.profileDir : '';
  const bundles = profileDir ? readProfileBundles(profileDir) : [];
  const patchText = ctx ? readProfilePatchText(ctx) : '';
  const plans = new Map();

  const add = (plan) => {
    const identity = plan.id !== undefined ? plan.id : plan.name !== undefined ? plan.name : plan.file !== undefined ? plan.file : '';
    const key = plan.action + ':' + identity;
    const existing = plans.get(key);
    if (!existing || plan.priority > existing.priority) plans.set(key, plan);
  };

  // 1) profile 自有 cordis.patch.yml 解析失败 → 从备份恢复
  for (const error of Array.isArray(diag.patchErrors) ? diag.patchErrors : []) {
    const file = error && error.file ? error.file : '';
    if (!file) continue;
    if (isProfilePatchFile(file, ctx)) {
      add({
        action: 'restore-patch-file',
        file,
        reason: 'profile 补丁文件 cordis.patch.yml 解析失败，尝试从最近的可用备份恢复',
        priority: 90,
      });
      continue;
    }
    // 2) 某个 bundle 自带的 patch 解析失败 → 移除该 bundle
    const pkg = bundleNameFromPatchPath(file);
    if (pkg && bundles.includes(pkg) && !isProtectedBundle(pkg)) {
      add({
        action: 'remove-bundle',
        name: pkg,
        reason: 'bundle ' + pkg + ' 的补丁文件解析失败：' + String((error && error.error) || '').slice(0, 160),
        priority: 80,
      });
    }
  }

  // 3/4) 失败插件：非保护条目直接禁用；保护条目只有在 patch 中存在顶层条目时注释它
  for (const plugin of Array.isArray(diag.failedPlugins) ? diag.failedPlugins : []) {
    if (!plugin || !plugin.id) continue;
    if (isEnvironmentError(plugin.error)) continue; // 环境类错误绝不能作为禁用依据
    if (isProtectedEntry(plugin.id)) {
      if (patchText && hasTopLevelEntry(patchText, plugin.id)) {
        add({
          action: 'comment-patch-entry',
          id: plugin.id,
          file: path.join(profileDir, PROFILE_PATCH_FILENAME),
          reason: '受保护插件 ' + plugin.id + ' 启动失败，且 cordis.patch.yml 中存在该条目的补丁配置，先注释该条目排除配置问题',
          priority: 50,
        });
      }
      continue;
    }
    add({
      action: 'disable-entry',
      id: plugin.id,
      module: plugin.module || '',
      reason: '插件 ' + plugin.id + ' 启动失败' + (plugin.error ? '：' + String(plugin.error).slice(0, 160) : ''),
      priority: 60,
    });
  }

  // 5) 致命加载的模块命中 profile bundle → 移除该 bundle
  for (const fatal of Array.isArray(diag.fatalLoads) ? diag.fatalLoads : []) {
    const moduleName = fatal && fatal.module ? String(fatal.module).replace(/\\/g, '/') : '';
    if (!moduleName) continue;
    if (bundles.includes(moduleName) && !isProtectedBundle(moduleName)) {
      add({
        action: 'remove-bundle',
        name: moduleName,
        reason: '模块 ' + moduleName + ' 致命加载失败，移除对应 bundle',
        priority: 55,
      });
    }
  }

  // 6) 被跳过的坏 bundle → 兜底移除（仅非保护）
  for (const skipped of Array.isArray(diag.skippedBundles) ? diag.skippedBundles : []) {
    if (!skipped || !skipped.name) continue;
    if (isProtectedBundle(skipped.name)) continue;
    add({
      action: 'remove-bundle',
      name: skipped.name,
      reason: 'bundle ' + skipped.name + ' 被跳过：' + String(skipped.error || '').slice(0, 160),
      priority: 10,
    });
  }

  // 7) 无可用动作返回空数组
  return Array.from(plans.values()).sort((left, right) => right.priority - left.priority);
}

// ---------------------------------------------------------------------------
// 修复动作
// ---------------------------------------------------------------------------

/** 读取 profile package.json，返回 {pkg, text} 或 null。 */
function readProfilePackage(profileDir) {
  const file = path.join(profileDir, PROFILE_PACKAGE_FILENAME);
  try {
    const text = readText(file);
    return { pkg: JSON.parse(text), text, file };
  } catch (_) {
    return null;
  }
}

/** 写回 profile package.json（2 空格 + 换行）。 */
function writeProfilePackage(file, pkg) {
  writeText(file, JSON.stringify(pkg, null, 2) + '\n');
}

/** 用 ctx.yaml 解析 YAML；ctx.yaml 可以是模块、对象或函数。缺少解析库时明确失败。 */
function parseYamlWith(ctx, text) {
  const yaml = ctx && ctx.yaml;
  if (yaml && typeof yaml.parse === 'function') return yaml.parse(text);
  if (typeof yaml === 'function') return yaml(text);
  throw new Error('缺少 YAML 解析库（ctx.yaml），拒绝用 JSON 规则误判 cordis.patch.yml');
}

/**
 * 执行一条修复计划。
 * @returns {{ok: boolean, state: object, detail: string}}
 */
function applySafeBootFix(ctx, state, plan) {
  const current = normalizeState(state);
  if (!plan || typeof plan !== 'object' || !plan.action) {
    return { ok: false, state: current, detail: '无效的修复计划：缺少 action' };
  }
  try {
    switch (plan.action) {
      case 'disable-entry':
        return applyDisableEntry(ctx, current, plan);
      case 'remove-bundle':
        return applyRemoveBundle(ctx, current, plan);
      case 'comment-patch-entry':
        return applyCommentPatchEntry(ctx, current, plan);
      case 'restore-patch-file':
        return applyRestorePatchFile(ctx, current, plan);
      default:
        return { ok: false, state: current, detail: '未知的修复动作：' + String(plan.action) };
    }
  } catch (error) {
    return { ok: false, state: current, detail: '修复动作执行失败：' + String((error && error.message) || error) };
  }
}

/** disable-entry：把插件加入 state.disabled 并同步 overlay。 */
function applyDisableEntry(ctx, state, plan) {
  const next = cloneState(state);
  const id = String(plan.id == null ? '' : plan.id);
  if (!id) return { ok: false, state: next, detail: 'disable-entry 缺少插件 id' };
  if (isProtectedEntry(id)) {
    return { ok: false, state: next, detail: '拒绝禁用受保护入口 ' + id };
  }
  const existing = next.disabled.find((item) => item.id === id);
  if (existing) {
    syncSafeBootOverlay(ctx, next);
    return { ok: true, state: next, detail: '插件 ' + id + ' 已在禁用列表中，跳过重复记录' };
  }
  const at = nowIso();
  const reason = String(plan.reason || '启动失败，自动禁用');
  next.disabled.push({ id, module: String(plan.module || ''), reason, at });
  const detail =
    '已禁用插件 ' + id + (plan.module ? '（' + plan.module + '）' : '') + '：' + reason;
  next.history.push({ action: 'disable-entry', detail, at });
  writeSafeBootState(ctx, next);
  const overlayPath = syncSafeBootOverlay(ctx, next);
  return {
    ok: true,
    state: next,
    detail: detail + (overlayPath ? '；overlay 已写入 ' + overlayPath : ''),
  };
}

/** remove-bundle：从 profile package.json 的 dsh.profile.bundles 移除 bundle。 */
function applyRemoveBundle(ctx, state, plan) {
  const next = cloneState(state);
  const name = String(plan.name == null ? '' : plan.name);
  if (!name) return { ok: false, state: next, detail: 'remove-bundle 缺少 bundle 包名' };
  if (isProtectedBundle(name)) {
    return { ok: false, state: next, detail: '拒绝移除受保护 bundle ' + name };
  }
  const pkgInfo = readProfilePackage(profileDirOf(ctx));
  if (!pkgInfo) return { ok: false, state: next, detail: '无法读取 profile package.json' };
  const bundles = pkgInfo.pkg && pkgInfo.pkg.dsh && pkgInfo.pkg.dsh.profile && pkgInfo.pkg.dsh.profile.bundles;
  if (!Array.isArray(bundles)) {
    return { ok: false, state: next, detail: 'profile package.json 缺少 dsh.profile.bundles 数组' };
  }
  const index = bundles.indexOf(name);
  if (index < 0) {
    return { ok: true, state: next, detail: 'bundle ' + name + ' 不在 profile bundles 中，跳过' };
  }
  const backup = backupFile(pkgInfo.file, PROFILE_PACKAGE_FILENAME + '.bak-safe-boot');
  bundles.splice(index, 1);
  writeProfilePackage(pkgInfo.file, pkgInfo.pkg);
  const at = nowIso();
  const reason = String(plan.reason || 'bundle 加载失败，自动移除');
  if (!next.bundles.some((item) => item.name === name)) {
    next.bundles.push({ name, index, reason, at });
  }
  const detail = '已从 profile bundles 移除 ' + name + '（原索引 ' + index + '），备份：' + backup;
  next.history.push({ action: 'remove-bundle', detail, at });
  writeSafeBootState(ctx, next);
  return { ok: true, state: next, detail };
}

/** comment-patch-entry：注释 cordis.patch.yml 中某个顶层条目块。 */
function applyCommentPatchEntry(ctx, state, plan) {
  const next = cloneState(state);
  const id = String(plan.id == null ? '' : plan.id);
  if (!id) return { ok: false, state: next, detail: 'comment-patch-entry 缺少条目 id' };
  const patchPath = path.join(profileDirOf(ctx), PROFILE_PATCH_FILENAME);
  if (!fs.existsSync(patchPath)) {
    return { ok: false, state: next, detail: 'cordis.patch.yml 不存在，无法注释条目 ' + id };
  }
  const text = readText(patchPath);
  const block = findTopLevelEntryBlock(text, id);
  if (!block) {
    if (isPatchEntryCommented(text, id)) {
      return { ok: true, state: next, detail: 'cordis.patch.yml 中条目 ' + id + ' 已被 safe-boot 注释，跳过重复操作' };
    }
    return { ok: true, state: next, detail: 'cordis.patch.yml 中未找到顶层条目 - id: ' + id + '，跳过' };
  }
  const backup = backupFile(patchPath, PROFILE_PATCH_FILENAME + '.bak-safe-boot');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = nowIso();
  const reason = String(plan.reason || '插件启动失败，临时注释补丁条目');
  const marker = '# [safe-boot ' + at + '] 自动禁用：' + reason;
  const commented = lines.slice(block.start, block.end).map((line) => (line === '' ? '#' : '# ' + line));
  const nextLines = [
    ...lines.slice(0, block.start),
    marker,
    ...commented,
    ...lines.slice(block.end),
  ];
  writeText(patchPath, nextLines.join(eol));
  const detail = '已注释 cordis.patch.yml 中顶层条目 - id: ' + id + '，备份：' + backup;
  if (!next.patchEdits.some((item) => item.file === patchPath && item.id === id)) {
    next.patchEdits.push({ file: patchPath, id, backup, at, reason });
  }
  next.history.push({ action: 'comment-patch-entry', detail, at });
  writeSafeBootState(ctx, next);
  return { ok: true, state: next, detail };
}

/** restore-patch-file：备份坏文件，从最近的可用 bak 备份恢复 cordis.patch.yml。 */
function applyRestorePatchFile(ctx, state, plan) {
  const next = cloneState(state);
  if (!ctx || !ctx.yaml) {
    return { ok: false, state: next, detail: '缺少 YAML 解析库，无法安全判断/恢复 cordis.patch.yml（已跳过，未改动任何文件）' };
  }
  const profileDir = profileDirOf(ctx);
  const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME);
  const at = nowIso();
  const reason = String((plan && plan.reason) || 'cordis.patch.yml 解析失败，自动恢复');

  let currentText = null;
  if (fs.existsSync(patchPath)) {
    currentText = readText(patchPath);
    try {
      const parsed = parseYamlWith(ctx, currentText);
      if (Array.isArray(parsed)) {
        return { ok: true, state: next, detail: '当前 cordis.patch.yml 可正常解析为数组，无需恢复' };
      }
    } catch (_) {
      /* 当前文件确实损坏，继续恢复流程 */
    }
  }

  let brokenBackup = '';
  if (currentText !== null) {
    brokenBackup = backupFile(patchPath, PROFILE_PATCH_FILENAME + '.broken');
  }

  let candidates = [];
  try {
    candidates = fs
      .readdirSync(profileDir)
      .filter((name) => /^cordis\.patch\.yml\.bak-/.test(name))
      .map((name) => {
        const file = path.join(profileDir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch (_) {
          /* 忽略无法 stat 的备份 */
        }
        return { name, file, mtime };
      })
      .sort((left, right) => right.mtime - left.mtime);
  } catch (_) {
    candidates = [];
  }

  let restored = null;
  for (const candidate of candidates) {
    try {
      const text = readText(candidate.file);
      const parsed = parseYamlWith(ctx, text);
      if (Array.isArray(parsed)) {
        restored = { name: candidate.name, file: candidate.file, text };
        break;
      }
    } catch (_) {
      /* 该备份也解析失败，尝试下一个 */
    }
  }

  let detail;
  if (restored) {
    writeText(patchPath, restored.text);
    detail = '已用备份 ' + restored.name + ' 恢复 cordis.patch.yml' + (brokenBackup ? '（损坏文件备份：' + brokenBackup + '）' : '');
  } else {
    writeText(patchPath, '[]');
    detail =
      '未找到可解析为数组的 cordis.patch.yml.bak-* 备份，已将 cordis.patch.yml 重置为空数组 []' +
      (brokenBackup ? '（损坏文件备份：' + brokenBackup + '）' : '');
  }
  next.history.push({ action: 'restore-patch-file', detail, at });
  writeSafeBootState(ctx, next);
  return { ok: true, state: next, detail };
}

/**
 * 清除安全启动状态：恢复被移除的 bundle，删除 overlay，重置状态（保留历史并追加清除记录）。
 */
function clearSafeBootState(ctx) {
  const current = readSafeBootState(ctx);
  const next = emptyState();
  next.history = current.history.slice();
  const at = nowIso();
  const detailParts = [];

  if (current.bundles.length > 0) {
    const pkgInfo = readProfilePackage(profileDirOf(ctx));
    const bundles = pkgInfo && pkgInfo.pkg && pkgInfo.pkg.dsh && pkgInfo.pkg.dsh.profile && pkgInfo.pkg.dsh.profile.bundles;
    if (!pkgInfo || !Array.isArray(bundles)) {
      return { ok: false, state: current, detail: '无法恢复 bundle：profile package.json 不可读或缺少 dsh.profile.bundles' };
    }
    let restoredCount = 0;
    const ordered = current.bundles
      .map((item, order) => ({ item, order }))
      .sort((left, right) => {
        const indexDiff = left.item.index - right.item.index;
        return indexDiff !== 0 ? indexDiff : left.order - right.order;
      });
    for (const { item } of ordered) {
      if (!item.name || bundles.includes(item.name)) continue;
      const target = Math.min(Math.max(Number.isInteger(item.index) ? item.index : bundles.length, 0), bundles.length);
      bundles.splice(target, 0, item.name);
      restoredCount += 1;
    }
    if (restoredCount > 0) {
      writeProfilePackage(pkgInfo.file, pkgInfo.pkg);
    }
    detailParts.push('恢复 ' + restoredCount + ' 个 bundle');
  }

  const overlayPath = path.join(stateDirOf(ctx), OVERLAY_FILENAME);
  try {
    if (fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath);
  } catch (_) {
    /* 删除失败不阻断清除流程 */
  }
  detailParts.push('删除 safe-boot.patch.yml', '清空禁用/补丁记录');

  const detail = '清除安全启动状态：' + detailParts.join('，');
  next.history.push({ action: 'clear', detail, at });
  writeSafeBootState(ctx, next);
  return { ok: true, state: next, detail };
}

/** 生成人类可读的状态描述（中文）。 */
function describeSafeBootState(state) {
  const normalized = normalizeState(state);
  const hasAny =
    normalized.disabled.length > 0 || normalized.bundles.length > 0 || normalized.patchEdits.length > 0;
  const lines = [
    hasAny
      ? '安全启动状态：禁用 ' +
        normalized.disabled.length +
        ' 个插件，移除 ' +
        normalized.bundles.length +
        ' 个 bundle，注释 ' +
        normalized.patchEdits.length +
        ' 个补丁条目'
      : '安全启动状态：干净（没有自动禁用或移除记录）',
  ];
  for (const item of normalized.disabled) {
    lines.push('  禁用：' + item.id + (item.module ? '（' + item.module + '）' : '') + ' — ' + item.reason);
  }
  for (const item of normalized.bundles) {
    lines.push('  移除 bundle：' + item.name + '（原索引 ' + item.index + '） — ' + item.reason);
  }
  for (const item of normalized.patchEdits) {
    lines.push('  注释补丁条目：' + item.id + ' in ' + item.file + ' — ' + item.reason);
  }
  if (normalized.history.length > 0) {
    lines.push('  历史记录：' + normalized.history.length + ' 条');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  PROTECTED_ENTRY_IDS,
  PROTECTED_BUNDLES,
  isProtectedEntry,
  isProtectedBundle,
  isEnvironmentError,
  parseStartupFailure,
  readSafeBootState,
  writeSafeBootState,
  buildSafeBootOverlay,
  syncSafeBootOverlay,
  planSafeBootFixes,
  applySafeBootFix,
  clearSafeBootState,
  describeSafeBootState,
};
