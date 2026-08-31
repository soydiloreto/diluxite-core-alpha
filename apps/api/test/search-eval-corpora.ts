/**
 * The corpus and query suite the search evaluation runs on, in four languages.
 *
 * One corpus, translated — not four different corpora. Six notes about the
 * same six subjects and ten queries asking the same ten questions, so a hit
 * rate that drops in Italian says something about the PIPELINE and not about
 * a fixture that happened to be easier in Spanish.
 *
 * Every corpus is deliberately adversarial the way a real vault is: notes that
 * share vocabulary, near-synonyms, and questions phrased in words the answer
 * does not use. The queries also inflect differently from the note that
 * answers them ("versiones" vs "versión", "backups" vs "backup") — which is
 * exactly where a stemmer that speaks the wrong language stops matching.
 */

export interface EvalDoc {
  title: string;
  contentMd: string;
}

/** A query and the note a person would expect back first. */
export interface EvalQuery {
  q: string;
  expect: string;
}

export interface EvalCorpus {
  /** BCP-47 tag, as the note would carry it once content has a language. */
  lang: string;
  /** Human label for test names and console output. */
  label: string;
  /**
   * The Postgres text-search configuration this content SHOULD be indexed
   * with. Today `keywordSearch` hardcodes `'spanish'` for all of them
   * (packages/db/src/search-repository.ts), which is what the lexical-gap
   * test measures.
   */
  pgConfig: string;
  docs: EvalDoc[];
  queries: EvalQuery[];
  /**
   * Inflection probes: a fragment of the corpus and a query a person would
   * really type for it, where the query word and the indexed word are
   * different surface forms of the same lemma. Under the right configuration
   * the stemmer collapses them and the match happens; under `'spanish'`
   * applied to another language it does not.
   */
  probes: { text: string; query: string }[];
}

const SPANISH: EvalCorpus = {
  lang: 'es',
  label: 'español',
  pgConfig: 'spanish',
  docs: [
    {
      title: 'Arquitectura de búsqueda',
      contentMd:
        'La búsqueda combina BM25 con pgvector y fusiona los dos rankings con RRF. ' +
        'Después un reranker reordena los mejores por cobertura de términos.',
    },
    {
      title: 'Despliegue con Docker',
      contentMd:
        'El stack se levanta con docker compose: la API, la base Postgres con pgvector ' +
        'y el frontend. El instalador genera el compose real.',
    },
    {
      title: 'Política de contraseñas',
      contentMd:
        'Las contraseñas se guardan hasheadas con PBKDF2. El segundo factor es TOTP ' +
        'y hay códigos de respaldo de un solo uso.',
    },
    {
      title: 'Historial de versiones',
      contentMd:
        'Cada guardado que cambia el contenido deja una instantánea de lo que la nota ' +
        'decía antes. Se pueden restaurar versiones anteriores.',
    },
    {
      title: 'Colaboración en tiempo real',
      contentMd:
        'Dos personas editan la misma nota a la vez. Los cambios viajan por WebSocket ' +
        'y se fusionan con un CRDT, sin pisarse.',
    },
    {
      title: 'Copias de seguridad',
      contentMd:
        'El respaldo guarda la base, los secretos y el certificado. Restaurar en una ' +
        'máquina nueva deja el sistema igual que estaba.',
    },
  ],
  queries: [
    { q: 'cómo funciona la búsqueda híbrida', expect: 'Arquitectura de búsqueda' },
    { q: 'cómo levanto el stack', expect: 'Despliegue con Docker' },
    { q: 'segundo factor de autenticación', expect: 'Política de contraseñas' },
    { q: 'puedo volver a una versión anterior de una nota', expect: 'Historial de versiones' },
    { q: 'dos personas editando al mismo tiempo', expect: 'Colaboración en tiempo real' },
    { q: 'restaurar en una máquina nueva', expect: 'Copias de seguridad' },
    { q: 'RRF', expect: 'Arquitectura de búsqueda' },
    { q: 'TOTP', expect: 'Política de contraseñas' },
    { q: 'CRDT WebSocket', expect: 'Colaboración en tiempo real' },
    { q: 'pgvector', expect: 'Arquitectura de búsqueda' },
  ],
  probes: [
    { text: 'Se pueden restaurar versiones anteriores', query: 'versión' },
    { text: 'Las contraseñas se guardan hasheadas', query: 'contraseña' },
    { text: 'Dos personas editan la misma nota', query: 'editar' },
  ],
};

const ENGLISH: EvalCorpus = {
  lang: 'en',
  label: 'inglés',
  pgConfig: 'english',
  docs: [
    {
      title: 'Search architecture',
      contentMd:
        'Search combines BM25 with pgvector and fuses both rankings with RRF. ' +
        'A reranker then reorders the best ones by term coverage.',
    },
    {
      title: 'Deploying with Docker',
      contentMd:
        'The stack is brought up with docker compose: the API, the Postgres database ' +
        'with pgvector and the frontend. The installer generates the real compose file.',
    },
    {
      title: 'Password policy',
      contentMd:
        'Passwords are stored hashed with PBKDF2. The second factor is TOTP and there ' +
        'are single-use recovery codes.',
    },
    {
      title: 'Version history',
      contentMd:
        'Every save that changes the content leaves a snapshot of what the note said ' +
        'before. Earlier versions can be restored.',
    },
    {
      title: 'Real-time collaboration',
      contentMd:
        'Two people edit the same note at once. Changes travel over WebSocket and are ' +
        'merged with a CRDT, without overwriting each other.',
    },
    {
      title: 'Backups',
      contentMd:
        'The backup stores the database, the secrets and the certificate. Restoring on ' +
        'a new machine leaves the system exactly as it was.',
    },
  ],
  queries: [
    { q: 'how does hybrid search work', expect: 'Search architecture' },
    { q: 'how do I bring the stack up', expect: 'Deploying with Docker' },
    { q: 'second authentication factor', expect: 'Password policy' },
    { q: 'can I go back to an earlier version of a note', expect: 'Version history' },
    { q: 'two people editing at the same time', expect: 'Real-time collaboration' },
    { q: 'restoring on a new machine', expect: 'Backups' },
    { q: 'RRF', expect: 'Search architecture' },
    { q: 'TOTP', expect: 'Password policy' },
    { q: 'CRDT WebSocket', expect: 'Real-time collaboration' },
    { q: 'pgvector', expect: 'Search architecture' },
  ],
  probes: [
    { text: 'Earlier versions can be restored', query: 'version' },
    { text: 'The backup stores the database', query: 'backups' },
    { text: 'Two people edit the same note at once', query: 'editing' },
  ],
};

const PORTUGUESE: EvalCorpus = {
  lang: 'pt-BR',
  label: 'portugués (BR)',
  pgConfig: 'portuguese',
  docs: [
    {
      title: 'Arquitetura de busca',
      contentMd:
        'A busca combina BM25 com pgvector e funde os dois rankings com RRF. ' +
        'Depois um reranker reordena os melhores por cobertura de termos.',
    },
    {
      title: 'Implantação com Docker',
      contentMd:
        'A stack sobe com docker compose: a API, o banco Postgres com pgvector e o ' +
        'frontend. O instalador gera o compose real.',
    },
    {
      title: 'Política de senhas',
      contentMd:
        'As senhas são guardadas com hash PBKDF2. O segundo fator é TOTP e existem ' +
        'códigos de recuperação de uso único.',
    },
    {
      title: 'Histórico de versões',
      contentMd:
        'Cada gravação que altera o conteúdo deixa um instantâneo do que a nota dizia ' +
        'antes. É possível restaurar versões anteriores.',
    },
    {
      title: 'Colaboração em tempo real',
      contentMd:
        'Duas pessoas editam a mesma nota ao mesmo tempo. As alterações viajam por ' +
        'WebSocket e são mescladas com um CRDT, sem se sobrescrever.',
    },
    {
      title: 'Cópias de segurança',
      contentMd:
        'O backup guarda o banco, os segredos e o certificado. Restaurar em uma máquina ' +
        'nova deixa o sistema igual ao que estava.',
    },
  ],
  queries: [
    { q: 'como funciona a busca híbrida', expect: 'Arquitetura de busca' },
    { q: 'como eu subo a stack', expect: 'Implantação com Docker' },
    { q: 'segundo fator de autenticação', expect: 'Política de senhas' },
    { q: 'posso voltar para uma versão anterior de uma nota', expect: 'Histórico de versões' },
    { q: 'duas pessoas editando ao mesmo tempo', expect: 'Colaboração em tempo real' },
    { q: 'restaurar em uma máquina nova', expect: 'Cópias de segurança' },
    { q: 'RRF', expect: 'Arquitetura de busca' },
    { q: 'TOTP', expect: 'Política de senhas' },
    { q: 'CRDT WebSocket', expect: 'Colaboração em tempo real' },
    { q: 'pgvector', expect: 'Arquitetura de busca' },
  ],
  probes: [
    { text: 'As alterações viajam por WebSocket', query: 'alteração' },
    // Not `versões` → `versão`: the Portuguese stemmer does not collapse
    // that pair either, so it would measure Snowball and not our bug.
    { text: 'É possível restaurar versões anteriores', query: 'restauração' },
    { text: 'Duas pessoas editam a mesma nota', query: 'editar' },
  ],
};

const ITALIAN: EvalCorpus = {
  lang: 'it',
  label: 'italiano',
  pgConfig: 'italian',
  docs: [
    {
      title: 'Architettura della ricerca',
      contentMd:
        'La ricerca combina BM25 con pgvector e fonde le due classifiche con RRF. ' +
        'Poi un reranker riordina i migliori per copertura dei termini.',
    },
    {
      title: 'Distribuzione con Docker',
      contentMd:
        'Lo stack si avvia con docker compose: la API, il database Postgres con ' +
        'pgvector e il frontend. Il programma di installazione genera il compose reale.',
    },
    {
      title: 'Politica delle password',
      contentMd:
        'Le password sono salvate con hash PBKDF2. Il secondo fattore è TOTP e ci sono ' +
        'codici di recupero monouso.',
    },
    {
      title: 'Cronologia delle versioni',
      contentMd:
        'Ogni salvataggio che cambia il contenuto lascia un’istantanea di ciò che la ' +
        'nota diceva prima. Le versioni precedenti si possono ripristinare.',
    },
    {
      title: 'Collaborazione in tempo reale',
      contentMd:
        'Due persone modificano la stessa nota nello stesso momento. Le modifiche ' +
        'viaggiano su WebSocket e vengono unite con un CRDT, senza sovrascriversi.',
    },
    {
      title: 'Copie di sicurezza',
      contentMd:
        'Il backup conserva il database, i segreti e il certificato. Ripristinare su ' +
        'una macchina nuova lascia il sistema com’era.',
    },
  ],
  queries: [
    { q: 'come funziona la ricerca ibrida', expect: 'Architettura della ricerca' },
    { q: 'come avvio lo stack', expect: 'Distribuzione con Docker' },
    { q: 'secondo fattore di autenticazione', expect: 'Politica delle password' },
    { q: 'posso tornare a una versione precedente di una nota', expect: 'Cronologia delle versioni' },
    { q: 'due persone che modificano nello stesso momento', expect: 'Collaborazione in tempo reale' },
    { q: 'ripristinare su una macchina nuova', expect: 'Copie di sicurezza' },
    { q: 'RRF', expect: 'Architettura della ricerca' },
    { q: 'TOTP', expect: 'Politica delle password' },
    { q: 'CRDT WebSocket', expect: 'Collaborazione in tempo reale' },
    { q: 'pgvector', expect: 'Architettura della ricerca' },
  ],
  probes: [
    { text: 'Le modifiche viaggiano su WebSocket', query: 'modifica' },
    { text: 'Le versioni precedenti si possono ripristinare', query: 'versione' },
    { text: 'Due persone modificano la stessa nota', query: 'modificare' },
  ],
};

export const CORPORA: EvalCorpus[] = [SPANISH, ENGLISH, PORTUGUESE, ITALIAN];
