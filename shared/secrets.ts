export const SECRET_PATH = /(^|\/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/

const R = '[REDACTED]'
const URL_CRED = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s\/@]+@/gi
const BASIC = /(\bAuthorization:\s*)Basic\s+[A-Za-z0-9+\/]{8,}=*/gi
const TOKENS = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})|\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g
const KEYED = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|access[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:(")[^"\n]{6,}"|(')[^'\n]{6,}'|[^\s"',;]{6,})/gi

export function redact(s: string): string {
  return s
    .replace(URL_CRED, `$1${R}@`)
    .replace(BASIC, `$1${R}`)
    .replace(TOKENS, R)
    .replace(KEYED, (_m: string, k: string, dq?: string, sq?: string) =>
      k + (dq ? `"${R}"` : sq ? `'${R}'` : R))
}

export const hasSecret = (s: string): boolean => redact(s) !== s
