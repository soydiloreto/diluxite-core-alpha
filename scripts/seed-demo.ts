/**
 * Diluxite — deterministic technical seed.
 *
 * Populates the default workspace with 1500 cohesive technical notes
 * (ADRs, patterns, runbooks, postmortems, cheatsheets, reading notes,
 * code reviews, tech comparisons, team rules, daily journals), spread
 * across a 3-year window, organised into a realistic folder hierarchy,
 * with tags (`#tag`), wikilinks (`[[Other Note]]`), and ~10% favourites.
 *
 * Usage:
 *   pnpm seed                 # 1500 notes with default seed (=42)
 *   COUNT=500 pnpm seed       # different total
 *   SEED=7 pnpm seed          # different RNG → different (but still
 *                             #  deterministic) corpus
 *   RESET=1 pnpm seed         # wipe folders/notes first
 *   DATABASE_URL=... pnpm seed
 *
 * Writes go through the same `setTags` / `setLinks` repositories the
 * API uses, so the resulting workspace is indistinguishable from one
 * built by hand — except that timestamps span years instead of seconds.
 */
import { createDb } from '../packages/db/src/client';
import {
  notes as notesTable,
  folders as foldersTable,
  noteTags as noteTagsTable,
  noteLinks as noteLinksTable,
  chunks as chunksTable,
  spaces as spacesTable,
  users as usersTable,
  memberships as membershipsTable,
} from '../packages/db/src/schema';
import { DrizzleNotesRepository } from '../packages/db/src/notes-repository';
import { DrizzleSearchRepository } from '../packages/db/src/search-repository';
import { SearchService, DeterministicEmbeddingProvider } from '../packages/core/src/index';
import { eq, inArray } from 'drizzle-orm';

// ───── CLI / env config ────────────────────────────────────────────────
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';
const TARGET_COUNT = Number(process.env.COUNT ?? 1500);
const RNG_SEED = Number(process.env.SEED ?? 42);
const RESET = process.env.RESET === '1' || process.env.RESET === 'true';
// Target workspace. Si se setea, el seed va EXACTAMENTE a ese space (lo elige
// el usuario desde install.sh cuando hay varios). Si no, comportamiento legacy
// (primer space, o bootstrap en DB fresca).
const SPACE_ID = process.env.DILUXITE_SEED_SPACE_ID?.trim() || '';

// ───── Deterministic RNG (mulberry32) ──────────────────────────────────
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(RNG_SEED);

function randInt(lo: number, hi: number): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function sample<T>(arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}
function chance(p: number): boolean {
  return rng() < p;
}

// ───── Folder tree ─────────────────────────────────────────────────────
interface FolderSpec {
  name: string;
  children?: FolderSpec[];
}
const FOLDER_TREE: FolderSpec[] = [
  {
    name: 'Architecture',
    children: [{ name: 'Decisions' }, { name: 'Patterns' }, { name: 'Principles' }],
  },
  {
    name: 'Backend',
    children: [{ name: 'APIs' }, { name: 'Auth' }, { name: 'Databases' }, { name: 'Performance' }],
  },
  {
    name: 'Frontend',
    children: [{ name: 'React' }, { name: 'State management' }, { name: 'A11y' }],
  },
  {
    name: 'DevOps',
    children: [
      { name: 'Docker' },
      { name: 'Kubernetes' },
      { name: 'CI-CD' },
      { name: 'Observability' },
    ],
  },
  { name: 'Cloud', children: [{ name: 'Azure' }, { name: 'AWS' }, { name: 'GCP' }] },
  { name: 'Security' },
  { name: 'Testing' },
  {
    name: 'Team',
    children: [{ name: 'Conventions' }, { name: 'Postmortems' }, { name: 'Reviews' }],
  },
  { name: 'Reading' },
  { name: 'Journal' },
];

type FolderKey =
  | 'Architecture/Decisions'
  | 'Architecture/Patterns'
  | 'Architecture/Principles'
  | 'Backend/APIs'
  | 'Backend/Auth'
  | 'Backend/Databases'
  | 'Backend/Performance'
  | 'Frontend/React'
  | 'Frontend/State management'
  | 'Frontend/A11y'
  | 'DevOps/Docker'
  | 'DevOps/Kubernetes'
  | 'DevOps/CI-CD'
  | 'DevOps/Observability'
  | 'Cloud/Azure'
  | 'Cloud/AWS'
  | 'Cloud/GCP'
  | 'Security'
  | 'Testing'
  | 'Team/Conventions'
  | 'Team/Postmortems'
  | 'Team/Reviews'
  | 'Reading'
  | 'Journal';

// ───── Vocabulary banks ────────────────────────────────────────────────
const TOPICS = [
  'authentication',
  'authorization',
  'rate limiting',
  'caching strategy',
  'database sharding',
  'read replicas',
  'event sourcing',
  'CQRS',
  'request throttling',
  'circuit breaker',
  'retry with backoff',
  'feature flags',
  'gradual rollout',
  'canary deployment',
  'blue-green deployment',
  'observability',
  'distributed tracing',
  'structured logging',
  'metrics aggregation',
  'service discovery',
  'API versioning',
  'pagination',
  'idempotency keys',
  'optimistic locking',
  'pessimistic locking',
  'message queues',
  'event-driven architecture',
  'webhooks',
  'background jobs',
  'cron scheduling',
  'data migrations',
  'schema evolution',
  'multi-tenancy',
  'tenant isolation',
  'soft deletes',
  'audit logs',
  'GDPR compliance',
  'secrets management',
  'PII handling',
  'encryption at rest',
  'TLS everywhere',
];
const PATTERN_NAMES = [
  'Hexagonal Architecture',
  'Ports and Adapters',
  'Repository Pattern',
  'Unit of Work',
  'Saga Pattern',
  'Outbox Pattern',
  'Circuit Breaker',
  'Bulkhead',
  'Strangler Fig',
  'Sidecar',
  'Ambassador',
  'Anti-Corruption Layer',
  'Materialized View',
  'CQRS',
  'Event Sourcing',
  'Aggregate Root',
  'Domain Events',
  'Specification Pattern',
  'Strategy Pattern',
  'Command Pattern',
  'Observer Pattern',
  'Decorator Pattern',
  'Factory Method',
  'Builder Pattern',
  'Singleton (and why we avoid it)',
  'Dependency Injection',
  'Inversion of Control',
  'Service Locator',
  'Adapter Pattern',
  'Facade Pattern',
];
const PRINCIPLES = [
  'SOLID',
  'DRY',
  'KISS',
  'YAGNI',
  'Law of Demeter',
  'Tell, Don’t Ask',
  'Composition over Inheritance',
  'Fail Fast',
  'Make Illegal States Unrepresentable',
  'Parse, Don’t Validate',
  'Boy Scout Rule',
  'Rule of Three',
];
const LANGUAGES = [
  'TypeScript',
  'JavaScript',
  'Python',
  'Go',
  'Rust',
  'Java',
  'Kotlin',
  'C#',
  'Ruby',
  'Elixir',
];
const FRAMEWORKS = [
  'Fastify',
  'Express',
  'NestJS',
  'Hono',
  'FastAPI',
  'Django',
  'Rails',
  'Spring Boot',
  'ASP.NET Core',
  'Actix',
  'Axum',
  'Gin',
  'Echo',
];
const DATABASES = [
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'DynamoDB',
  'Cassandra',
  'ClickHouse',
  'TimescaleDB',
  'pgvector',
  'Elasticsearch',
  'Kafka',
  'RabbitMQ',
];
const FRONTEND = [
  'React',
  'Vue',
  'Svelte',
  'Solid',
  'Next.js',
  'Remix',
  'Astro',
  'Vite',
  'Tailwind',
  'shadcn/ui',
  'Radix',
  'Zustand',
  'Redux Toolkit',
  'TanStack Query',
];
const CLOUD_AZ = [
  'App Service',
  'Functions',
  'Container Apps',
  'AKS',
  'Cosmos DB',
  'PostgreSQL Flexible',
  'Service Bus',
  'Event Grid',
  'Application Insights',
  'Entra ID',
  'Key Vault',
  'Storage Account',
];
const CLOUD_AWS = [
  'Lambda',
  'ECS Fargate',
  'EKS',
  'RDS',
  'DynamoDB',
  'SQS',
  'SNS',
  'CloudWatch',
  'IAM',
  'Secrets Manager',
  'S3',
  'CloudFront',
];
const CLOUD_GCP = [
  'Cloud Run',
  'GKE',
  'Cloud SQL',
  'Firestore',
  'Pub/Sub',
  'Cloud Logging',
  'IAM',
  'Secret Manager',
  'Cloud Storage',
  'Cloud CDN',
];
const TOOLS = [
  'Docker',
  'Kubernetes',
  'Helm',
  'Terraform',
  'Pulumi',
  'GitHub Actions',
  'GitLab CI',
  'ArgoCD',
  'Flux',
  'Prometheus',
  'Grafana',
  'OpenTelemetry',
  'Jaeger',
  'Sentry',
  'Datadog',
  'Loki',
  'NATS',
];
const SECURITY = [
  'OWASP A01 Broken Access Control',
  'OWASP A02 Cryptographic Failures',
  'OWASP A03 Injection',
  'OWASP A04 Insecure Design',
  'OWASP A05 Security Misconfiguration',
  'OWASP A06 Vulnerable Components',
  'OWASP A07 Identification & Auth Failures',
  'OWASP A08 Software & Data Integrity',
  'OWASP A09 Logging Failures',
  'OWASP A10 SSRF',
  'JWT pitfalls',
  'OAuth 2.1 + PKCE',
  'Session fixation',
  'CSRF defenses',
  'Content Security Policy',
  'Rate limiting strategies',
];
const BOOKS = [
  ['Designing Data-Intensive Applications', 'Martin Kleppmann'],
  ['Building Microservices', 'Sam Newman'],
  ['Domain-Driven Design', 'Eric Evans'],
  ['Clean Architecture', 'Robert C. Martin'],
  ['Site Reliability Engineering', 'Beyer et al.'],
  ['The Pragmatic Programmer', 'Hunt & Thomas'],
  ['Refactoring', 'Martin Fowler'],
  ['Continuous Delivery', 'Humble & Farley'],
  ['Release It!', 'Michael Nygard'],
  ['Accelerate', 'Forsgren, Humble, Kim'],
  ['Working Effectively with Legacy Code', 'Michael Feathers'],
  ['Patterns of Enterprise Application Architecture', 'Martin Fowler'],
] as const;
const ENGINEERS = [
  'Ana',
  'Bruno',
  'Carla',
  'Diego',
  'Eva',
  'Felipe',
  'Greta',
  'Hugo',
  'Ines',
  'Joaquin',
  'Kira',
  'Luis',
  'Mariana',
  'Nico',
  'Olga',
  'Pablo',
  'Quim',
  'Rocio',
  'Sergio',
  'Tomas',
  'Ursula',
  'Valeria',
];

const TAGS = {
  arch: ['architecture', 'design', 'ddd', 'patterns', 'principles'],
  backend: ['backend', 'api', 'rest', 'graphql', 'auth', 'performance'],
  db: ['database', 'sql', 'postgres', 'redis', 'mongodb', 'pgvector', 'migrations'],
  frontend: ['frontend', 'react', 'state', 'a11y', 'ui', 'ux'],
  devops: ['devops', 'docker', 'k8s', 'ci-cd', 'observability', 'sre'],
  cloud: ['cloud', 'azure', 'aws', 'gcp', 'iac'],
  security: ['security', 'owasp', 'auth', 'jwt', 'oauth', 'tls'],
  testing: ['testing', 'tdd', 'unit', 'integration', 'e2e'],
  team: ['team', 'conventions', 'review', 'postmortem'],
  reading: ['reading', 'books', 'notes'],
  journal: ['journal', 'daily'],
} as const;

// ───── Helpers for generation ──────────────────────────────────────────
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const tagLine = (tags: readonly string[]) => tags.map((t) => `#${t}`).join(' ');
const sentenceJoin = (...ss: string[]) => ss.filter(Boolean).join(' ');

interface NoteSpec {
  title: string;
  body: string;
  folder: FolderKey | null;
  favorite: boolean;
  createdAt: Date;
  /** Wikilinks parsed from body — resolved at insert time. */
  wikilinkTargets: string[];
  tags: string[];
  /** ms since creation when last edited (0 = never edited). */
  editedAfterMs: number;
}

function wikilink(title: string): string {
  return `[[${title}]]`;
}

// We keep generated titles unique by appending a suffix if a clash happens.
const titlePool = new Set<string>();
function uniqueTitle(base: string): string {
  let t = base;
  let n = 2;
  while (titlePool.has(t.toLowerCase())) {
    t = `${base} (${n++})`;
  }
  titlePool.add(t.toLowerCase());
  return t;
}

function dateInPastDays(maxDaysAgo: number): Date {
  const days = randInt(0, maxDaysAgo);
  const ms = days * 86_400_000 + randInt(0, 86_400_000 - 1);
  return new Date(Date.now() - ms);
}

// ───── Generators per category ─────────────────────────────────────────
function genAdr(idx: number): NoteSpec {
  const topic = pick(TOPICS);
  const stack = pick([...LANGUAGES, ...FRAMEWORKS, ...DATABASES, ...TOOLS]);
  const alt = pick([...LANGUAGES, ...FRAMEWORKS, ...DATABASES, ...TOOLS]);
  const number = String(idx).padStart(4, '0');
  const title = uniqueTitle(`ADR-${number} Use ${stack} for ${topic}`);
  const date = dateInPastDays(randInt(0, 365 * 3));
  const tagSet = sample([...TAGS.arch, ...TAGS.backend], 4);
  const refs = sample(PATTERN_NAMES, 2);
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Status\nAccepted — ${date.toISOString().slice(0, 10)} by ${pick(ENGINEERS)} & ${pick(ENGINEERS)}.\n\n## Context\nWe need a deliberate approach to ${topic}. Today we rely on ad-hoc handling spread across the codebase. As traffic grew past ${randInt(10, 50)}k req/min the inconsistencies started biting us in production.\n\n## Decision\nWe will use **${stack}** as the canonical tool for ${topic}. ${stack} gives us the operational characteristics we want (battle-tested, observable, integrates with our existing ${pick(TOOLS)} pipeline) and the team is already familiar with it. See ${wikilink(pick(refs))} for the underlying pattern.\n\n## Alternatives considered\n- **${alt}** — rejected: ${pick(['too much glue code', 'lacks tenant-isolation guarantees', 'overkill for our throughput', 'opaque failure modes', 'licensing concerns'])}.\n- **Roll our own** — rejected: classic NIH. ${wikilink('YAGNI')}.\n\n## Consequences\n- (+) Single source of truth, easier onboarding.\n- (+) ${pick(['Reduces incident MTTR', 'Cuts P95 by ~30%', 'Removes a class of bugs at compile time'])}.\n- (−) We commit to ${stack}'s upgrade cadence.\n- (−) Team has to adopt a stricter ${pick(['naming convention', 'release process', 'review checklist'])}.\n\n## Follow-ups\n- [ ] Migrate the legacy ${pick(['v1', 'v2'])} path by Q${randInt(1, 4)}.\n- [ ] Document the runbook in ${wikilink(`How to operate ${stack}`)}.\n\nRelated: ${wikilink(pick(PATTERN_NAMES))}, ${wikilink(pick(PRINCIPLES))}.\n`;
  return {
    title,
    body,
    folder: 'Architecture/Decisions',
    favorite: chance(0.1),
    createdAt: date,
    wikilinkTargets: [...refs, 'YAGNI', `How to operate ${stack}`, pick(PATTERN_NAMES), pick(PRINCIPLES)],
    tags: tagSet,
    editedAfterMs: chance(0.2) ? randInt(86_400_000, 30 * 86_400_000) : 0,
  };
}

function genPattern(): NoteSpec {
  const name = pick(PATTERN_NAMES);
  const title = uniqueTitle(`Pattern: ${name}`);
  const tagSet = sample([...TAGS.arch, ...TAGS.backend], 3);
  const date = dateInPastDays(randInt(30, 365 * 2));
  const example = `\`\`\`${pick(['ts', 'go', 'py', 'rs']).toLowerCase()}\n// ${name} — minimal example.\nconst result = pipeline\n  .map(decode)\n  .filter(${pick(['isValid', 'isFresh', 'isAuthorised'])})\n  .reduce(${pick(['merge', 'aggregate', 'fold'])}, seed);\n\`\`\``;
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Intent\n${name} lets you ${pick([
    'separate the core logic from infrastructure concerns',
    'react to state changes without coupling producers to consumers',
    'compose behaviour at runtime instead of through inheritance',
    'route work to the right handler without a giant switch statement',
    'centralise side-effects so the domain stays pure',
  ])}.\n\n## When to reach for it\n- ${pick(['Multiple input sources', 'Multiple output sinks', 'Recurring "if X then Y" branching'])} on the same shape.\n- The decision belongs to the domain, not to the wire format.\n- You are about to introduce a fourth conditional and it feels wrong.\n\n## When NOT to reach for it\n- One caller, one callee — a function is fine.\n- The variability is in data, not in behaviour. Prefer a table or config.\n\n## Sketch\n${example}\n\n## In our codebase\nWe apply ${name} in ${pick(['the ingestion pipeline', 'the notification fanout', 'the search reranker', 'the auth flow', 'the migration runner'])}, see ${wikilink(`How we structured ${pick(['the API layer', 'the domain layer', 'the persistence layer'])}`)}.\n\n## Related\n- ${wikilink(pick(PATTERN_NAMES))}\n- ${wikilink(pick(PRINCIPLES))}\n- ${wikilink('Make Illegal States Unrepresentable')}\n`;
  return {
    title,
    body,
    folder: 'Architecture/Patterns',
    favorite: chance(0.15),
    createdAt: date,
    wikilinkTargets: [
      `How we structured ${pick(['the API layer', 'the domain layer', 'the persistence layer'])}`,
      pick(PATTERN_NAMES),
      pick(PRINCIPLES),
      'Make Illegal States Unrepresentable',
    ],
    tags: tagSet,
    editedAfterMs: chance(0.25) ? randInt(86_400_000, 60 * 86_400_000) : 0,
  };
}

function genHowTo(): NoteSpec {
  const action = pick([
    'roll back a bad release',
    'rotate the database password',
    'replay a Kafka topic from an offset',
    'debug a slow query',
    'add a new index without downtime',
    'set up a new feature flag',
    'restore from a daily backup',
    'reproduce a production crash locally',
    'shadow-traffic a new endpoint',
    'cut a hotfix release',
    'switch the embedding provider',
    'scale a stateful service',
    'profile a Node process',
    'tune a Postgres connection pool',
    'configure Application Insights from scratch',
    'wire OpenTelemetry across services',
  ]);
  const title = uniqueTitle(`How to ${action}`);
  const tagSet = sample([...TAGS.devops, ...TAGS.backend], 3);
  const folder: FolderKey = pick<FolderKey>([
    'DevOps/CI-CD',
    'DevOps/Observability',
    'DevOps/Kubernetes',
    'Backend/Databases',
    'Backend/Performance',
  ]);
  const date = dateInPastDays(randInt(0, 365 * 2));
  const steps = randInt(4, 7);
  const stepList = Array.from({ length: steps }, (_, i) => {
    const verb = pick(['Verify', 'Connect to', 'Run', 'Check', 'Confirm', 'Tag', 'Notify', 'Apply', 'Rotate', 'Drain']);
    const obj = pick(['the staging cluster', 'production replicas', 'the SRE channel', 'the latest backup', 'the canary pod', 'the WAL position']);
    return `${i + 1}. **${verb}** ${obj}. ${pick(['Pause if it looks off.', 'Capture the output in the ticket.', 'Wait 60 seconds before the next step.', 'Watch the dashboard.', 'Get a second pair of eyes.'])}`;
  }).join('\n');
  const cmd = `\`\`\`bash\n# Quick reference — see the runbook below for the full ritual.\n${pick(['kubectl', 'docker compose', 'psql', 'gh', 'az'])} ${pick(['exec', 'logs', 'get pods', 'rollout undo', 'run --rm'])}\n\`\`\``;
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n> Runbook for **${action}**. Last verified against the production stack on ${date.toISOString().slice(0, 10)}.\n\n## Pre-flight\n- You are on-call OR you have explicit hand-off from the on-call.\n- The change is announced in #releases.\n- The latest healthy build is pinned.\n\n${cmd}\n\n## Steps\n${stepList}\n\n## Verification\n- P95 latency back inside the SLO band within 5 minutes.\n- Error rate below ${pick(['0.1%', '0.5%', '1%'])} for 10 minutes straight.\n- ${pick(['No paging alerts since the change.', 'No spike in 5xx.', 'No CPU saturation on the bottleneck node.'])}\n\n## Rollback\nIf any verification fails, ${pick(['revert via', 'roll back through', 'pin to the previous image with'])} ${wikilink('How to roll back a bad release')}. Don’t try to debug forward during business hours.\n\n## Related\n- ${wikilink(pick(SECURITY))}\n- ${wikilink(pick(PATTERN_NAMES))}\n`;
  return {
    title,
    body,
    folder,
    favorite: chance(0.08),
    createdAt: date,
    wikilinkTargets: ['How to roll back a bad release', pick(SECURITY), pick(PATTERN_NAMES)],
    tags: tagSet,
    editedAfterMs: chance(0.4) ? randInt(86_400_000, 90 * 86_400_000) : 0,
  };
}

function genPostmortem(): NoteSpec {
  const incident = pick([
    'database connection saturation',
    'cascading 504s from auth service',
    'expired TLS certificate on the API gateway',
    'runaway retry storm hitting the payments provider',
    'memory leak in the chunking worker',
    'mis-tagged release shipped to production',
    'cache stampede after a deploy',
    'time-skew between two regions',
    'silent secret rotation that broke the workers',
    'noisy neighbour saturating shared CPU',
    'GC pauses spiking P99 on the search path',
  ]);
  const date = dateInPastDays(randInt(0, 365 * 3));
  const title = uniqueTitle(`Postmortem ${date.toISOString().slice(0, 10)} — ${incident}`);
  const tagSet = sample([...TAGS.devops, 'postmortem'], 4);
  const duration = `${randInt(15, 240)} minutes`;
  const impact = pick(['~5% of writes failed', 'Search degraded for all tenants', 'A single tenant was offline', 'Auth was unavailable for ~12% of users', 'Webhooks delayed by hours']);
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## TL;DR\nWe had an outage on ${date.toISOString().slice(0, 10)} caused by ${incident}. Duration: **${duration}**. Impact: ${impact}.\n\n## Timeline (local time)\n- **${randInt(8, 17)}:${String(randInt(0, 59)).padStart(2, '0')}** — first alert fires (${pick(['P95 latency', '5xx rate', 'error budget burn'])}).\n- **+5 min** — ${pick(ENGINEERS)} acks the page.\n- **+12 min** — Hypothesis: ${pick(['runaway retries', 'connection saturation', 'bad config push', 'DNS flap'])}.\n- **+22 min** — Mitigation applied: ${pick(['scale out', 'roll back the deploy', 'flip the feature flag', 'rotate the credential'])}.\n- **+${randInt(40, 120)} min** — Stable. Incident closed.\n\n## Root cause\n${pick([
    'A library upgrade silently changed the default timeout',
    'A migration moved a column without backfilling',
    'A circuit breaker was disabled in last week’s refactor',
    'A new caller bypassed the rate limiter',
    'A health check was too lenient and let a sick instance keep serving',
    'A queue consumer kept consuming poison messages without dead-lettering',
  ])}. See ${wikilink(pick(PATTERN_NAMES))} and ${wikilink('Circuit Breaker')}.\n\n## What went well\n- Alerting fired within ${randInt(2, 6)} minutes.\n- Runbook ${wikilink('How to roll back a bad release')} got us to mitigation quickly.\n- Comms in #incident were clean.\n\n## What didn’t\n- ${pick(['No dashboard for this failure mode', 'Runbook was out of date', 'On-call rotation was thin that night', 'Logs lacked the right correlation id'])}.\n- The post-mitigation verification was too eyeballed.\n\n## Action items\n- [ ] @${pick(ENGINEERS).toLowerCase()} — add a synthetic probe by ${dateInPastDays(-randInt(7, 30)).toISOString().slice(0, 10)}.\n- [ ] @${pick(ENGINEERS).toLowerCase()} — update the runbook with the exact \`kubectl\` invocation we used.\n- [ ] @${pick(ENGINEERS).toLowerCase()} — write an ADR on ${wikilink('Retry with backoff')}.\n\n## Related\n${wikilink('How to debug a slow query')} · ${wikilink(pick(SECURITY))}\n`;
  return {
    title,
    body,
    folder: 'Team/Postmortems',
    favorite: chance(0.05),
    createdAt: date,
    wikilinkTargets: [
      pick(PATTERN_NAMES),
      'Circuit Breaker',
      'How to roll back a bad release',
      'Retry with backoff',
      'How to debug a slow query',
      pick(SECURITY),
    ],
    tags: tagSet,
    editedAfterMs: chance(0.6) ? randInt(86_400_000, 14 * 86_400_000) : 0,
  };
}

function genCheatsheet(): NoteSpec {
  const tool = pick([
    'git rebase',
    'kubectl debug',
    'psql diagnostics',
    'curl for HTTP/2',
    'jq pipes',
    'tmux survival',
    'Docker layer caching',
    'systemd-journalctl',
    'tcpdump basics',
    'ssh -J jump hosts',
    'pgbadger reports',
    'Drizzle migrations',
    'Vitest debug flags',
    'pnpm workspaces',
  ]);
  const title = uniqueTitle(`${tool} cheatsheet`);
  const tagSet = sample([...TAGS.devops, ...TAGS.backend, 'cheatsheet'], 4);
  const date = dateInPastDays(randInt(0, 365 * 2));
  const lines = Array.from({ length: randInt(5, 9) }, () => {
    const cmd = pick(['kubectl', 'docker', 'git', 'psql', 'pnpm', 'gh', 'curl', 'jq']);
    const subcmd = pick(['logs', 'exec', 'rebase -i', 'inspect', 'create', 'run', '-Pretty']);
    const target = pick(['$POD', 'main', 'origin/main', '@diluxite/core', 'prod-db']);
    return `\`${cmd} ${subcmd} ${target}\` — ${pick(['follow live', 'rewrite history', 'inspect layers', 'connect to', 'execute against', 'create from template'])}.`;
  });
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nReferences: ${wikilink(pick(PATTERN_NAMES))}, ${wikilink('How to debug a slow query')}.\n`;
  return {
    title,
    body,
    folder: pick<FolderKey>(['DevOps/CI-CD', 'DevOps/Observability', 'Backend/Databases']),
    favorite: chance(0.18),
    createdAt: date,
    wikilinkTargets: [pick(PATTERN_NAMES), 'How to debug a slow query'],
    tags: tagSet,
    editedAfterMs: chance(0.3) ? randInt(86_400_000, 120 * 86_400_000) : 0,
  };
}

function genReading(): NoteSpec {
  const [book, author] = pick(BOOKS);
  const chapter = randInt(1, 18);
  const title = uniqueTitle(`Reading: ${book}, ch.${chapter}`);
  const tagSet = sample([...TAGS.reading, ...TAGS.arch], 3);
  const date = dateInPastDays(randInt(0, 365 * 3));
  const quote = pick([
    'Software architecture is the stuff that’s hard to change later.',
    'The first rule of distributed systems: don’t.',
    'Make the change easy, then make the easy change.',
    'You are not paid to write code; you are paid to solve problems.',
    'Premature optimisation is the root of all evil.',
    'Loose coupling but high cohesion.',
  ]);
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n_Author: **${author}** · started ${date.toISOString().slice(0, 10)}_\n\n## Key idea\n${pick([
    'Decouple the *what* from the *how* — keep the domain free of infrastructure.',
    'Backpressure is your friend; without it, the loudest caller wins.',
    'A schema is a contract; treat changes like contract changes.',
    'Idempotency turns retries from terror to muscle memory.',
    'Boundaries should be obvious — if you can’t draw them, the seam is wrong.',
  ])}\n\n## Quote\n> ${quote}\n\n## My take\n${pick([
    'Aligns with how we structured our domain layer — see',
    'Contradicts the way we currently do',
    'Worth a focused team discussion about',
    'Pairs naturally with our recent decision about',
  ])} ${wikilink(pick(PATTERN_NAMES))}.\n\n## Open questions\n- How does this map to our ${pick(['multi-tenant', 'low-latency', 'event-driven', 'realtime'])} workload?\n- What’s the smallest change that gets us closer? See ${wikilink(pick(PRINCIPLES))}.\n\n## Related notes\n- ${wikilink(pick(PATTERN_NAMES))}\n- ${wikilink('Make Illegal States Unrepresentable')}\n`;
  return {
    title,
    body,
    folder: 'Reading',
    favorite: chance(0.12),
    createdAt: date,
    wikilinkTargets: [pick(PATTERN_NAMES), pick(PRINCIPLES), 'Make Illegal States Unrepresentable'],
    tags: tagSet,
    editedAfterMs: chance(0.2) ? randInt(86_400_000, 365 * 86_400_000) : 0,
  };
}

function genReview(): NoteSpec {
  const reviewee = pick(ENGINEERS);
  const pr = randInt(100, 9999);
  const title = uniqueTitle(`Review notes: PR #${pr} by ${reviewee}`);
  const tagSet = sample([...TAGS.team, ...TAGS.backend], 3);
  const date = dateInPastDays(randInt(0, 365));
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Verdict\n${pick(['Approve with comments', 'Request changes', 'Approve', 'Block — needs discussion'])}.\n\n## What I liked\n- ${pick(['Clear separation between domain and storage', 'Good test coverage on the unhappy paths', 'Small, focused commits', 'Explicit naming over clever naming'])}.\n- The use of ${wikilink(pick(PATTERN_NAMES))} keeps the surface area tight.\n\n## Concerns\n- ${pick([
    'The error path swallows the original cause — wrap, don’t hide.',
    'This will blow up under contention; we should hold a row-level lock.',
    'No backpressure on the consumer; we’ll re-create last quarter’s incident.',
    'Mutation in the middleware feels off — let’s push it to the boundary.',
    'I’d split this into two PRs: refactor first, behaviour second.',
  ])} See ${wikilink('Fail Fast')} and ${wikilink('Tell, Don’t Ask')}.\n\n## Suggestions\n- Add a regression test for the case from ${wikilink('Postmortem ' + date.toISOString().slice(0, 10) + ' — example')}.\n- Document the invariant in the type, not the comment.\n\n_Reviewer: ${pick(ENGINEERS)}_\n`;
  return {
    title,
    body,
    folder: 'Team/Reviews',
    favorite: chance(0.05),
    createdAt: date,
    wikilinkTargets: [pick(PATTERN_NAMES), 'Fail Fast', 'Tell, Don’t Ask'],
    tags: tagSet,
    editedAfterMs: chance(0.15) ? randInt(86_400_000, 30 * 86_400_000) : 0,
  };
}

function genComparison(): NoteSpec {
  const aOptions = [...DATABASES, ...FRAMEWORKS, ...CLOUD_AZ, ...CLOUD_AWS, ...CLOUD_GCP];
  const a = pick(aOptions);
  let b = pick(aOptions);
  while (b === a) b = pick(aOptions);
  const title = uniqueTitle(`${a} vs ${b}`);
  const tagSet = sample([...TAGS.backend, ...TAGS.cloud, ...TAGS.db], 3);
  const date = dateInPastDays(randInt(0, 365 * 2));
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Context\nFor our use case — ${pick(['low-latency, mostly reads', 'write-heavy fanout', 'event-driven, eventually consistent', 'transactional, strongly consistent', 'analytical, batch'])} workload — we compared **${a}** and **${b}**.\n\n| Aspect | ${a} | ${b} |\n|---|---|---|\n| Maturity | ${pick(['battle-tested', 'mature', 'newish but stable', 'cutting edge'])} | ${pick(['battle-tested', 'mature', 'newish but stable', 'cutting edge'])} |\n| Operability | ${pick(['low ops', 'managed services available', 'high ops cost', 'we have in-house experience'])} | ${pick(['low ops', 'managed services available', 'high ops cost', 'we have in-house experience'])} |\n| Cost (rough) | ${pick(['$', '$$', '$$$'])} | ${pick(['$', '$$', '$$$'])} |\n| Lock-in | ${pick(['low', 'medium', 'high'])} | ${pick(['low', 'medium', 'high'])} |\n\n## Why we picked **${chance(0.5) ? a : b}**\n- ${pick(['Operational fit with our existing stack', 'Lower P99 in our benchmarks', 'Smaller blast radius on failure', 'Team familiarity'])}.\n- ${pick(['Native multi-tenant primitives', 'Cleaner backup story', 'Better tooling around schema evolution'])}.\n\n## Caveats\n- ${pick(['We accept the ceiling at ~50k QPS', 'Need to revisit at ~10x scale', 'Latency tail under contention is still suspect'])}.\n\nRelated: ${wikilink(pick(PATTERN_NAMES))}, ${wikilink('ADR-XXXX')}.\n`;
  return {
    title,
    body,
    folder: pick<FolderKey>(['Backend/Databases', 'Cloud/Azure', 'Cloud/AWS', 'Cloud/GCP']),
    favorite: chance(0.1),
    createdAt: date,
    wikilinkTargets: [pick(PATTERN_NAMES), 'ADR-XXXX'],
    tags: tagSet,
    editedAfterMs: chance(0.2) ? randInt(86_400_000, 90 * 86_400_000) : 0,
  };
}

function genRule(): NoteSpec {
  const rule = pick([
    'commit messages',
    'branch naming',
    'pull-request titles',
    'TypeScript strictness',
    'no `any` in domain code',
    'naming for repositories',
    'naming for services',
    'naming for events',
    'directory layout',
    'public vs internal types',
    'error wrapping',
    'logging conventions',
    'database migrations',
    'feature-flag naming',
  ]);
  const title = uniqueTitle(`Convention: ${rule}`);
  const tagSet = sample([...TAGS.team, 'conventions'], 3);
  const date = dateInPastDays(randInt(0, 365 * 3));
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Rule\n${pick([
    'Use the imperative mood. "Add X", not "Added X" or "Adds X".',
    'Lowercase, kebab-case, no scopes.',
    'Match the type name to the unit of meaning, not to the layer.',
    'Errors carry causes — wrap, don’t shadow.',
    'Logs include `trace_id`, `tenant_id`, and `actor`. Always.',
    'Migrations are forward-only and reviewed by two engineers.',
  ])}\n\n## Why\n${pick([
    'Future-you grepping a year from now should find it without context.',
    'Removes a class of merge conflicts that nobody enjoys.',
    'Pairs with our ${TYPE} typing strategy.',
    'Keeps the dashboard usable when something is on fire.',
  ])}\n\n## Examples\n✅ \`${pick([
    'feat(api): add idempotency key',
    'fix(db): cascade on folder delete',
    'feat: introduce search v2',
  ])}\`\n❌ \`${pick([
    'updates',
    'misc fix',
    'fixed broken thing',
  ])}\`\n\nRelated: ${wikilink('Boy Scout Rule')}, ${wikilink(pick(PRINCIPLES))}.\n`;
  return {
    title,
    body,
    folder: 'Team/Conventions',
    favorite: chance(0.2),
    createdAt: date,
    wikilinkTargets: ['Boy Scout Rule', pick(PRINCIPLES)],
    tags: tagSet,
    editedAfterMs: chance(0.1) ? randInt(86_400_000, 365 * 86_400_000) : 0,
  };
}

function genJournal(daysAgo: number): NoteSpec {
  const date = new Date(Date.now() - daysAgo * 86_400_000 - randInt(0, 86_400_000 - 1));
  const dateStr = date.toISOString().slice(0, 10);
  const title = uniqueTitle(`Daily ${dateStr}`);
  const tagSet = sample([...TAGS.journal, 'standup'], 2);
  const sprint = `S${randInt(40, 96)}`;
  const ticket = `${pick(['DLX', 'OPS', 'SEC', 'INF'])}-${randInt(100, 9999)}`;
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Standup (${sprint})\n- Y: ${pick([
    'closed ' + ticket + ' (' + pick(['retry storm', 'flaky test', 'index missing', 'mis-tagged build']) + ')',
    'shipped the spike for ' + pick(TOPICS),
    'paired with ' + pick(ENGINEERS) + ' on ' + pick(PATTERN_NAMES),
    'reviewed three PRs',
  ])}\n- T: ${pick([
    'pick up ' + ticket,
    'unblock the ' + pick(['migration', 'rollout', 'incident review']) + ' for ' + pick(ENGINEERS),
    'spike on ' + pick(TOPICS),
    'finish the draft of ' + pick(BOOKS.map(([b]) => b)),
  ])}\n- B: ${pick([
    'waiting on review',
    'staging cluster flaking again — see ' + wikilink('How to debug a slow query'),
    'blocked on access to ' + pick(['Key Vault', 'Secrets Manager', 'the prod replica']),
    'nothing 🎉',
  ])}\n\n## Notes\n${pick([
    'Tried ' + wikilink(pick(PATTERN_NAMES)) + ' against the ingestion path; promising results.',
    'Made a tiny doc on ' + wikilink('Postgres connection pooling') + '. Will polish tomorrow.',
    'Re-read ' + wikilink('Designing Data-Intensive Applications, ch.5') + ' before the spike.',
    'Wrote a one-pager on ' + wikilink('Outbox Pattern') + '. Slack it tomorrow.',
  ])}\n\n## Tomorrow\n- [ ] ${pick(['Pair on ' + ticket, 'Send the design doc', 'Write a quick ADR for ' + pick(PATTERN_NAMES), 'Review the on-call hand-off'])}\n`;
  return {
    title,
    body,
    folder: 'Journal',
    favorite: chance(0.03),
    createdAt: date,
    wikilinkTargets: ['How to debug a slow query', pick(PATTERN_NAMES), 'Postgres connection pooling', 'Designing Data-Intensive Applications, ch.5', 'Outbox Pattern'],
    tags: tagSet,
    editedAfterMs: 0,
  };
}

function genSecurity(): NoteSpec {
  const topic = pick(SECURITY);
  const title = uniqueTitle(`Security: ${topic}`);
  const tagSet = sample([...TAGS.security], 4);
  const date = dateInPastDays(randInt(0, 365 * 2));
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Risk\n${pick([
    'An attacker can exfiltrate data without authentication.',
    'A misconfigured client can hammer our service into the ground.',
    'Sensitive material may end up in logs.',
    'A poisoned dependency can ship malicious code straight to prod.',
  ])}\n\n## Mitigation\n- ${pick(['Enforce at the gateway', 'Validate at the boundary', 'Sign and verify', 'Encrypt and segregate'])} — see ${wikilink('OAuth 2.1 + PKCE')}.\n- Audit existing usage with ${pick(['Snyk', 'Dependabot', 'Trivy', 'gitleaks'])}.\n- Add a ${pick(['unit', 'integration', 'fuzz'])} test that exercises the attack path.\n\n## Verify\n- [ ] CI catches a regression of the same shape.\n- [ ] Alert in the dashboard for ${pick(['anomalous 4xx ratio', 'spike in distinct IPs', 'unexpected admin actions'])}.\n\nReferences: ${wikilink(pick(PATTERN_NAMES))}, ${wikilink('Defense in depth')}.\n`;
  return {
    title,
    body,
    folder: 'Security',
    favorite: chance(0.1),
    createdAt: date,
    wikilinkTargets: ['OAuth 2.1 + PKCE', pick(PATTERN_NAMES), 'Defense in depth'],
    tags: tagSet,
    editedAfterMs: chance(0.2) ? randInt(86_400_000, 60 * 86_400_000) : 0,
  };
}

function genTesting(): NoteSpec {
  const flavor = pick(['Unit', 'Integration', 'E2E', 'Contract', 'Property-based', 'Snapshot']);
  const subject = pick([...PATTERN_NAMES, ...TOPICS]);
  const title = uniqueTitle(`${flavor} test strategy for ${subject}`);
  const tagSet = sample([...TAGS.testing], 3);
  const date = dateInPastDays(randInt(0, 365 * 2));
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\n## Scope\n${flavor} tests cover ${pick([
    'the public surface of the unit, not its private workings',
    'cross-process behaviour with realistic IO',
    'a single happy path end-to-end',
    'contracts at the seams between services',
    'invariants across an input domain',
  ])}.\n\n## What to assert\n- ${pick(['Behaviour, not implementation', 'Observable side-effects', 'Contracts at the boundary'])}.\n- Round-trip the data — write, read, compare.\n- The unhappy paths: ${pick(['malformed input', 'auth failure', 'partial outage', 'concurrent writer'])}.\n\n## What NOT to assert\n- Private internals.\n- Stable wall-clock times (mock them).\n- Library guarantees (trust them, test our use of them).\n\nRelated: ${wikilink('TDD')}, ${wikilink(pick(PATTERN_NAMES))}.\n`;
  return {
    title,
    body,
    folder: 'Testing',
    favorite: chance(0.1),
    createdAt: date,
    wikilinkTargets: ['TDD', pick(PATTERN_NAMES)],
    tags: tagSet,
    editedAfterMs: chance(0.15) ? randInt(86_400_000, 120 * 86_400_000) : 0,
  };
}

function genFrontend(): NoteSpec {
  const fwk = pick(FRONTEND);
  const topic = pick([
    'managing form state without losing your mind',
    'optimising re-renders',
    'streaming server components',
    'colour contrast and a11y',
    'keyboard focus traps in modals',
    'incremental hydration',
    'code splitting strategies',
    'route-level data fetching',
  ]);
  const title = uniqueTitle(`${fwk}: ${topic}`);
  const tagSet = sample([...TAGS.frontend], 3);
  const date = dateInPastDays(randInt(0, 365 * 2));
  const body = `# ${title}\n\n${tagLine(tagSet)}\n\nUsing **${fwk}** for ${topic}. Things that worked, things that didn’t, and the shape of the API we landed on.\n\n## Pattern\n${pick([
    'Lift state to the smallest common ancestor — no further.',
    'Co-locate the query with the component that uses it.',
    'Memoise selectors, not components.',
    'Suspend on the boundary, not on the leaf.',
  ])}\n\n## Trap\n${pick([
    'Effects that fetch and set state without cleanup',
    'Context that re-renders the world',
    'Imperative refs that fight the framework',
    'Reading from props inside an effect without listing them',
  ])} — see ${wikilink(pick(PRINCIPLES))}.\n\nRelated: ${wikilink(pick(PATTERN_NAMES))}.\n`;
  return {
    title,
    body,
    folder: pick<FolderKey>(['Frontend/React', 'Frontend/State management', 'Frontend/A11y']),
    favorite: chance(0.1),
    createdAt: date,
    wikilinkTargets: [pick(PRINCIPLES), pick(PATTERN_NAMES)],
    tags: tagSet,
    editedAfterMs: chance(0.2) ? randInt(86_400_000, 90 * 86_400_000) : 0,
  };
}

// ───── Composition ─────────────────────────────────────────────────────
// Weighted bag: pick(category) according to the target distribution.
type Generator = () => NoteSpec;
function buildPlan(total: number): Generator[] {
  // Numbers sum to roughly `total`; we cap with the for-loop to keep it precise.
  const buckets: { gen: Generator; weight: number }[] = [
    { gen: () => genAdr(adrCounter++), weight: 200 },
    { gen: genPattern, weight: 150 },
    { gen: genHowTo, weight: 200 },
    { gen: genPostmortem, weight: 100 },
    { gen: genCheatsheet, weight: 80 },
    { gen: genReading, weight: 120 },
    { gen: genReview, weight: 100 },
    { gen: genComparison, weight: 80 },
    { gen: genRule, weight: 70 },
    { gen: genSecurity, weight: 70 },
    { gen: genTesting, weight: 60 },
    { gen: genFrontend, weight: 70 },
  ];
  const tplBased = buckets.reduce((a, b) => a + b.weight, 0); // 1300
  // Spread the remaining slots across daily journals, oldest → newest.
  const remaining = Math.max(0, total - tplBased);
  const journalDaysSpan = Math.max(remaining, 365);
  let dayCursor = 0;
  const journalGen: Generator = () => {
    // distribute across a span proportional to remaining, with bias toward
    // recent days (~70% of journals in the last quarter of the span).
    const biased = chance(0.7)
      ? randInt(0, Math.floor(journalDaysSpan / 4))
      : randInt(0, journalDaysSpan);
    dayCursor = (dayCursor + biased) % Math.max(journalDaysSpan, 1);
    return genJournal(dayCursor);
  };

  const plan: Generator[] = [];
  for (const b of buckets) for (let i = 0; i < b.weight; i++) plan.push(b.gen);
  for (let i = 0; i < remaining; i++) plan.push(journalGen);

  // Trim or pad to exactly `total`.
  while (plan.length > total) plan.pop();
  while (plan.length < total) plan.push(genHowTo);

  // Shuffle so categories aren't grouped on insert order.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}
let adrCounter = 1;

// ───── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `[seed] target=${TARGET_COUNT} rng=${RNG_SEED} reset=${RESET} db=${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`,
  );
  const { sql, db } = createDb(DATABASE_URL);
  try {
    // 1) Resolve the target workspace.
    let spaceId: string;
    if (SPACE_ID) {
      // Explicit target (install.sh lo elige cuando hay varios spaces/orgs).
      const [s] = await db
        .select({ id: spacesTable.id })
        .from(spacesTable)
        .where(eq(spacesTable.id, SPACE_ID))
        .limit(1);
      if (!s) throw new Error(`[seed] requested workspace ${SPACE_ID} not found`);
      spaceId = s.id;
      console.log(`[seed] using requested workspace ${spaceId}`);
    } else {
    const existingSpaces = await db.select().from(spacesTable).limit(1);
    if (existingSpaces.length === 0) {
      // Bootstrap minimal owner + space so the seed can run on a fresh DB.
      const [user] = await db
        .insert(usersTable)
        .values({ email: 'local@diluxite', provider: 'local' })
        .returning({ id: usersTable.id });
      const [space] = await db
        .insert(spacesTable)
        .values({ name: 'My space', ownerId: user.id })
        .returning({ id: spacesTable.id });
      await db.insert(membershipsTable).values({ spaceId: space.id, userId: user.id, role: 'owner' });
      spaceId = space.id;
      console.log(`[seed] bootstrapped workspace ${spaceId}`);
    } else {
      spaceId = existingSpaces[0].id;
      console.log(`[seed] using existing workspace ${spaceId}`);
    }
    }

    // 2) Optional wipe — leaves spaces/users/tokens, removes user content.
    if (RESET) {
      await db.delete(chunksTable).where(eq(chunksTable.spaceId, spaceId));
      await db.delete(noteLinksTable).where(eq(noteLinksTable.spaceId, spaceId));
      await db.delete(noteTagsTable).where(eq(noteTagsTable.spaceId, spaceId));
      // Deleting notes cascades to chunks; folders cascades to its notes too,
      // but we already wiped notes here so the folder delete is just cleanup.
      await db.delete(notesTable).where(eq(notesTable.spaceId, spaceId));
      await db.delete(foldersTable).where(eq(foldersTable.spaceId, spaceId));
      console.log('[seed] reset: cleared chunks/notes/folders/tags/links for space');
    }

    // 3) Insert folder tree (parent first), record id by "path".
    // Fetch the current set of folders for this space once so we can do
    // O(1) lookups by (parentId, name) and stay idempotent across re-runs.
    const folderIdByPath = new Map<string, string>();
    const existingFolders = await db
      .select({ id: foldersTable.id, name: foldersTable.name, parentId: foldersTable.parentId })
      .from(foldersTable)
      .where(eq(foldersTable.spaceId, spaceId));
    const folderKey = (parentId: string | null, name: string) => `${parentId ?? '∅'}::${name}`;
    const existingByKey = new Map(existingFolders.map((f) => [folderKey(f.parentId ?? null, f.name), f.id]));

    async function insertFolderTree(specs: FolderSpec[], parentPath = '', parentId: string | null = null) {
      for (const spec of specs) {
        const path = parentPath ? `${parentPath}/${spec.name}` : spec.name;
        const k = folderKey(parentId, spec.name);
        let id = existingByKey.get(k);
        if (!id) {
          const [row] = await db
            .insert(foldersTable)
            .values({ spaceId, name: spec.name, parentId })
            .returning({ id: foldersTable.id });
          id = row.id;
          existingByKey.set(k, id);
        }
        folderIdByPath.set(path, id);
        if (spec.children) await insertFolderTree(spec.children, path, id);
      }
    }
    await insertFolderTree(FOLDER_TREE);
    console.log(`[seed] folders: ${folderIdByPath.size}`);

    // 4) Build the corpus.
    const plan = buildPlan(TARGET_COUNT);
    const specs: NoteSpec[] = plan.map((g) => g());

    // 4b) A root-level (no folder) "hub" note wired with ~50 outlinks and ~50
    //     backlinks, so the Neighbors panel has a heavy real-world example.
    //     `Knowledge Hub` lives at the root; 50 notes link OUT from it and 50
    //     other notes link back IN to it.
    const HUB_TITLE = 'Knowledge Hub';
    const FANOUT = 50;
    const linkPool = specs.filter((s) => s.title !== HUB_TITLE);
    const outTargets = sample(linkPool, FANOUT);
    const backlinkers = sample(
      linkPool.filter((s) => !outTargets.includes(s)),
      FANOUT,
    );
    for (const s of backlinkers) {
      s.body += `\n\nIndexed in ${wikilink(HUB_TITLE)}.\n`;
      s.wikilinkTargets.push(HUB_TITLE);
    }
    const reservedTitles = new Set(
      [HUB_TITLE, ...outTargets.map((s) => s.title), ...backlinkers.map((s) => s.title)].map((t) =>
        t.toLowerCase(),
      ),
    );
    specs.push({
      title: HUB_TITLE,
      body:
        `# ${HUB_TITLE}\n\n${tagLine(['index', 'moc'])}\n\n` +
        'A map-of-content linking the most important notes — handy for seeing ' +
        'backlinks and outlinks at scale in the Neighbors panel.\n\n## Index\n' +
        outTargets.map((s) => `- ${wikilink(s.title)}`).join('\n') +
        '\n',
      folder: null,
      favorite: true,
      createdAt: new Date(),
      wikilinkTargets: outTargets.map((s) => s.title),
      tags: ['index', 'moc'],
      editedAfterMs: 0,
    });
    console.log(`[seed] hub note "${HUB_TITLE}" (root) → ${FANOUT} outlinks + ${FANOUT} backlinks`);

    // 5) Insert notes in batches with explicit timestamps.
    const BATCH = 200;
    let inserted = 0;
    const titleToId = new Map<string, string>(); // lower-case title → id
    for (let i = 0; i < specs.length; i += BATCH) {
      const slice = specs.slice(i, i + BATCH);
      const now = Date.now();
      const rows = await db
        .insert(notesTable)
        .values(
          slice.map((s) => {
            // Clamp updatedAt to "now" — never leak future timestamps into
            // the timeline view.
            const updated = new Date(Math.min(now, s.createdAt.getTime() + s.editedAfterMs));
            return {
              spaceId,
              folderId: s.folder ? folderIdByPath.get(s.folder)! : null,
              title: s.title,
              contentMd: s.body,
              favorite: s.favorite,
              createdAt: s.createdAt,
              updatedAt: updated,
            };
          }),
        )
        .returning({ id: notesTable.id, title: notesTable.title });
      for (const r of rows) titleToId.set(r.title.toLowerCase(), r.id);
      inserted += slice.length;
      process.stdout.write(`\r[seed] notes inserted: ${inserted}/${specs.length}`);
    }
    process.stdout.write('\n');

    // 6) Run the real indexer on every note — populates `chunks` (so MCP
    //    search_memory actually returns results), `note_tags` (parsed from
    //    `#hash`), and `note_links` (parsed from `[[wikilinks]]`). This
    //    matches exactly what the API does on every save.
    const notesRepo = new DrizzleNotesRepository(db);
    const searchRepo = new DrizzleSearchRepository(db);
    const embedder = new DeterministicEmbeddingProvider(1536);
    const indexer = new SearchService(searchRepo, embedder, notesRepo);
    let indexed = 0;
    for (const s of specs) {
      const id = titleToId.get(s.title.toLowerCase());
      if (!id) continue;
      await indexer.index({
        id,
        spaceId,
        folderId: s.folder ? folderIdByPath.get(s.folder)! : null,
        title: s.title,
        contentMd: s.body,
        favorite: s.favorite,
        createdAt: s.createdAt,
        updatedAt: new Date(Math.min(Date.now(), s.createdAt.getTime() + s.editedAfterMs)),
      });
      indexed++;
      if (indexed % 200 === 0) process.stdout.write(`\r[seed] indexed: ${indexed}/${specs.length}`);
    }
    process.stdout.write(`\r[seed] indexed: ${indexed}/${specs.length}\n`);

    // 6b) Soft-delete a handful of notes (excluding the hub + its linked notes)
    //     so the Trash view has examples to restore.
    const TRASH_N = 10;
    const trashableIds = [...titleToId.entries()]
      .filter(([t]) => !reservedTitles.has(t))
      .map(([, id]) => id);
    const toTrash = sample(trashableIds, TRASH_N);
    if (toTrash.length > 0) {
      await db
        .update(notesTable)
        .set({ deletedAt: new Date() })
        .where(inArray(notesTable.id, toTrash));
    }
    console.log(`[seed] trashed: ${toTrash.length}`);

    // 7) Summary.
    const [{ favCount }] = await sql<{ favCount: number }[]>`
      select count(*)::int as "favCount" from notes where space_id = ${spaceId} and favorite = true`;
    const [{ tagCount }] = await sql<{ tagCount: number }[]>`
      select count(distinct tag)::int as "tagCount" from note_tags where space_id = ${spaceId}`;
    console.log(`[seed] favorites: ${favCount} · distinct tags: ${tagCount}`);
    console.log('[seed] done.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
