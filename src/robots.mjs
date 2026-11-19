/**
 * Minimal but correct-enough robots.txt support: group selection (our UA token
 * first, then `*`), Allow/Disallow rules with `*` and `$` wildcards, and
 * longest-match precedence (Allow wins ties, per Google's spec).
 */

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function pathToRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split('*')
    .map(escapeRegex)
    .join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`);
}

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let expectingAgents = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    expectingAgents = false;

    if (field === 'allow' || field === 'disallow') {
      if (!value) continue;
      current.rules.push({ allow: field === 'allow', path: value, regex: pathToRegex(value) });
    }
  }

  return { groups, sitemaps };
}

const OUR_AGENT_TOKEN = 'blogpostarchiver';

function pickGroup(robots, userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  const tokens = [OUR_AGENT_TOKEN];
  const branded = /([a-z][a-z0-9_.-]*archiver[a-z0-9_.-]*)/i.exec(ua);
  if (branded) tokens.push(branded[1].toLowerCase());

  let best = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        if (!best) best = group;
        continue;
      }
      const token = agent.split('/')[0].trim();
      if (token && (tokens.includes(token) || ua.includes(token))) best = group;
    }
  }
  return best;
}

export function isAllowedByRobots(robots, pathnameWithQuery, userAgent) {
  if (!robots || !robots.groups.length) return true;
  const group = pickGroup(robots, userAgent);
  if (!group || !group.rules.length) return true;

  const path = pathnameWithQuery || '/';
  let winner = null;
  for (const rule of group.rules) {
    if (!rule.regex.test(path)) continue;
    if (!winner || rule.path.length > winner.path.length) {
      winner = rule;
    } else if (rule.path.length === winner.path.length && rule.allow) {
      winner = rule;
    }
  }
  return winner ? winner.allow : true;
}

export async function loadRobots(origin, userAgent, { timeout = 10000 } = {}) {
  const url = new URL('/robots.txt', origin).href;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    if (!response.ok) return { groups: [], sitemaps: [], origin, url, loaded: false };
    const text = await response.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      return { groups: [], sitemaps: [], origin, url, loaded: false };
    }
    return { ...parseRobots(text), origin, url, loaded: true };
  } catch {
    return { groups: [], sitemaps: [], origin, url, loaded: false };
  }
}

export function robotsAllows(robots, url, userAgent) {
  try {
    const parsed = new URL(url);
    return isAllowedByRobots(robots, `${parsed.pathname}${parsed.search}`, userAgent);
  } catch {
    return false;
  }
}
