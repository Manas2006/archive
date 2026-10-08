const CODE_HOSTS = /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|huggingface\.co|codeberg\.org)\/[^\s)\]}>,"'<]+/gi;

/** Pull repository links out of free text (abstract, comments, paper body). */
export function extractCodeLinks(...texts: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(CODE_HOSTS)) {
      let url = m[0].replace(/[.;:]+$/, '');
      // keep owner/repo (or HF org/model) granularity
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) continue;
      const depth = u.hostname.includes('huggingface') && ['datasets', 'spaces'].includes(parts[0]) ? 3 : 2;
      url = `${u.protocol}//${u.hostname}/${parts.slice(0, depth).join('/')}`.replace(/\.git$/, '');
      seen.add(url);
    }
  }
  return [...seen].slice(0, 8);
}
