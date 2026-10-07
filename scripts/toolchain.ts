// The toolchain versions a repo's own build files ask for, and the host's. The build's source of truth decides pass or fail; any other
// manifest that disagrees only warns (a false failure here once stopped 13 runs before any code was written).
// Repo files are data: they are only read (size-capped), never executed. The host probes run a fixed binary with fixed arguments.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export type Tool = 'node' | 'java' | 'go' | 'python'
export type Requirement = { tool: Tool; required: string; source: string }
export type Version = { major: number; minor: number }
export type Runner = (cmd: string, args: string[]) => string | null

export function parseVersion(text: string, tool = ''): Version | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(text)
  if (!m) return null
  let major = Number(m[1])
  let minor = Number(m[2] ?? 0)
  if (tool === 'java' && major === 1 && m[2] !== undefined) { major = minor; minor = 0 }
  return { major, minor }
}

// Node and Java compare majors; Go and Python compare minors too.
export function satisfies(host: Version, required: Version, tool: string): boolean {
  if (host.major !== required.major) return host.major > required.major
  return tool === 'go' || tool === 'python' ? host.minor >= required.minor : true
}

const MAX_BYTES = 1024 * 1024
const rd = (root: string, rel: string): string => {
  try {
    const file = path.join(root, rel)
    return fs.statSync(file).size > MAX_BYTES ? '' : fs.readFileSync(file, 'utf8')
  } catch { return '' }
}
const toolVersions = (root: string, name: string): string | undefined => new RegExp(`^${name}\\s+(\\S+)`, 'm').exec(rd(root, '.tool-versions'))?.[1]
const firstLine = (text: string): string | undefined => text.trim().split('\n')[0]?.trim()

// The effective Java version of a Maven module: its own pom, else up the <parent> chain (relativePath, default ../pom.xml).
function javaFromPom(root: string): Requirement | null {
  let dir = root
  for (let depth = 0; depth < 6; depth++) {
    const xml = rd(dir, 'pom.xml')
    if (!xml) return null
    for (const tag of ['maven.compiler.release', 'java.version', 'maven.compiler.source']) {
      const t = tag.replace(/\./g, '\\.')
      const v = new RegExp(`<${t}>\\s*([^<\\s]+)\\s*</${t}>`).exec(xml)?.[1]
      if (v && !v.includes('${')) return { tool: 'java', required: v, source: path.relative(root, path.join(dir, 'pom.xml')) || 'pom.xml' }
    }
    const parent = /<parent>[\s\S]*?<\/parent>/.exec(xml)?.[0]
    if (!parent || /<relativePath\s*\/>/.test(parent)) return null
    const rel = /<relativePath>\s*([^<]*?)\s*<\/relativePath>/.exec(parent)?.[1] || '../pom.xml'
    dir = path.resolve(dir, rel.endsWith('.xml') ? path.dirname(rel) : rel)
  }
  return null
}

// Per tool, the primary requirement (the build's own source of truth) comes first.
export function requirements(root: string): Requirement[] {
  const out: Requirement[] = []
  const add = (tool: Tool, required: string | undefined, source: string): void => { if (required) out.push({ tool, required, source }) }
  add('node', firstLine(rd(root, '.nvmrc')), '.nvmrc')
  add('node', firstLine(rd(root, '.node-version')), '.node-version')
  try { add('node', (JSON.parse(rd(root, 'package.json') || '{}') as { engines?: { node?: unknown } }).engines?.node as string | undefined, 'package.json engines') } catch { /* unreadable manifest: nothing to require */ }
  add('node', toolVersions(root, 'nodejs'), '.tool-versions')
  const pom = javaFromPom(root)
  if (pom) out.push(pom)
  add('java', toolVersions(root, 'java'), '.tool-versions')
  add('go', /^go\s+(\S+)/m.exec(rd(root, 'go.mod'))?.[1], 'go.mod')
  add('go', toolVersions(root, 'golang'), '.tool-versions')
  add('python', firstLine(rd(root, '.python-version')), '.python-version')
  add('python', /requires-python\s*=\s*"([^"]+)"/.exec(rd(root, 'pyproject.toml'))?.[1], 'pyproject.toml')
  add('python', toolVersions(root, 'python'), '.tool-versions')
  return out.filter(r => typeof r.required === 'string')
}

// No shell, a timeout and an output cap. Only absolute PATH entries are searched, so a repo can never supply the binary; on Windows the
// working directory is the temp dir because the executable search there tries the current directory first.
export const realRunner: Runner = (cmd, args) => {
  const PATH = (process.env.PATH ?? '').split(path.delimiter).filter(d => path.isAbsolute(d)).join(path.delimiter)
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH }, ...(process.platform === 'win32' ? { cwd: os.tmpdir() } : {}),
  })
  return r.error ? null : `${r.stdout}${r.stderr}`
}

// The version the tool names (java -version may print "Picked up JAVA_TOOL_OPTIONS ..." first), else the first number after any prefix.
const NAMED: Record<Exclude<Tool, 'node'>, RegExp> = { java: /version "([^"]+)"/, go: /\bgo(\d+\.\d+)/, python: /Python (\d+\.\d+)/ }

export function hostVersion(tool: Tool, run: Runner): Version | null {
  if (tool === 'node') return parseVersion(process.versions.node)
  const text = tool === 'java' ? run('java', ['-version']) : tool === 'go' ? run('go', ['version']) : run('python3', ['--version'])
  if (!text) return null
  const named = NAMED[tool].exec(text)?.[1]
  return parseVersion(named ?? text.replace(/^[^\d]*/, ''), tool)
}
