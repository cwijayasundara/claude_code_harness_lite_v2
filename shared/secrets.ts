export const SECRET_PATH = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/

const R = '[REDACTED]'
const TOKENS = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})|\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g
const KEYED = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi

export function redact(s: string): string {
  return s.replace(TOKENS, R).replace(KEYED, (_m, k: string) => `${k}${R}`)
}

export const hasSecret = (s: string): boolean => redact(s) !== s
