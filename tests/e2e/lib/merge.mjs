// The operator plays the merger: push to a fresh ref so pre-push really runs, then fast-forward main.
export function mergeToMain(sb, slug) {
  sb.git('push', 'origin', `HEAD:refs/heads/prepush-${slug}`)
  sb.git('checkout', '-q', 'main')
  sb.git('merge', '-q', '--ff-only', `sdlc/${slug}`)
}
