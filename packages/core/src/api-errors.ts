/**
 * Localised API error messages.
 *
 * The web shows `body.error` to the user verbatim — on the login screen, the
 * password reset, the forgot-password flow — so a Spanish-speaking person was
 * reading English. This is not cosmetic: an error you cannot read is an error
 * you cannot act on.
 *
 * Two things ship together, and the second matters more in the long run:
 *
 *  - `message`, resolved against `Accept-Language`.
 *  - `code`, a stable machine-readable key. Without it a client that wants to
 *    react to a specific failure has to string-match the message — which
 *    breaks the moment the wording is improved, and breaks per language. The
 *    code is the contract; the message is for humans.
 *
 * ENGLISH IS THE SOURCE and every English string is byte-identical to what
 * the endpoint returned before. That is deliberate: the migration is then
 * additive for every existing client and every existing test, and a
 * translation bug cannot change behaviour for anyone reading English.
 */

export const API_LOCALES = ['en', 'es', 'pt', 'it', 'ca', 'zh'] as const;
export type ApiLocale = (typeof API_LOCALES)[number];
export const DEFAULT_API_LOCALE: ApiLocale = 'en';

/**
 * Pick a locale from an `Accept-Language` header.
 *
 * Honours quality values and falls back through the base language, so
 * `pt-BR` lands on `pt` and `es-419,es;q=0.9` on `es`. Anything unknown gets
 * English rather than a partial guess — a half-translated error is worse than
 * a consistent one.
 */
export function negotiateLocale(header: string | undefined | null): ApiLocale {
  if (!header) return DEFAULT_API_LOCALE;
  const parsed: { tag: string; q: number }[] = [];
  // Bounded split: a header is small, and this avoids any regex backtracking
  // on a value the client controls.
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.split(';');
    const tag = rawTag.trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split('=');
      if (k?.trim() === 'q') {
        const parsedQ = Number(v);
        if (Number.isFinite(parsedQ)) q = parsedQ;
      }
    }
    parsed.push({ tag, q });
  }
  parsed.sort((a, b) => b.q - a.q);
  for (const { tag, q } of parsed) {
    if (q <= 0) continue;
    const base = tag.split('-')[0];
    const hit = API_LOCALES.find((l) => l === tag || l === base);
    if (hit) return hit;
  }
  return DEFAULT_API_LOCALE;
}

type Catalog = Record<string, Record<ApiLocale, string>>;

/**
 * The catalog. Keys are the stable contract; English is what the endpoint
 * already returned.
 *
 * Placeholders are `{name}` and are substituted verbatim in every language —
 * a role name or a date is not translated.
 */
export const API_ERRORS: Catalog = {
  'space.noAccess': {
    en: 'no access to this space',
    es: 'sin acceso a este espacio',
    pt: 'sem acesso a este espaço',
    it: 'nessun accesso a questo spazio',
    ca: 'sense accés a aquest espai',
    zh: '无权访问该空间',
  },
  'space.noWriteAccess': {
    en: 'no write access to this space',
    es: 'sin permiso de escritura en este espacio',
    pt: 'sem permissão de escrita neste espaço',
    it: 'nessun permesso di scrittura in questo spazio',
    ca: 'sense permís d’escriptura en aquest espai',
    zh: '无权写入该空间',
  },
  'workspace.noAccess': {
    en: 'no access to this workspace',
    es: 'sin acceso a este espacio de trabajo',
    pt: 'sem acesso a este espaço de trabalho',
    it: 'nessun accesso a questa area di lavoro',
    ca: 'sense accés a aquest espai de treball',
    zh: '无权访问该工作区',
  },
  'workspace.requiresRole': {
    en: 'requires one of: {roles}',
    es: 'requiere uno de: {roles}',
    pt: 'requer um de: {roles}',
    it: 'richiede uno tra: {roles}',
    ca: 'requereix un de: {roles}',
    zh: '需要以下之一：{roles}',
  },
  'auth.invalidCredentials': {
    en: 'invalid credentials',
    es: 'credenciales inválidas',
    pt: 'credenciais inválidas',
    it: 'credenziali non valide',
    ca: 'credencials no vàlides',
    zh: '凭据无效',
  },
  'auth.emailAndPasswordRequired': {
    en: 'email and password required',
    es: 'se requieren email y contraseña',
    pt: 'e-mail e senha obrigatórios',
    it: 'email e password obbligatorie',
    ca: 'cal el correu i la contrasenya',
    zh: '需要邮箱和密码',
  },
  'auth.emailRequired': {
    en: 'email required',
    es: 'se requiere el email',
    pt: 'e-mail obrigatório',
    it: 'email obbligatoria',
    ca: 'cal el correu',
    zh: '需要邮箱',
  },
  'auth.currentPasswordWrong': {
    en: 'current password is wrong',
    es: 'la contraseña actual es incorrecta',
    pt: 'a senha atual está incorreta',
    it: 'la password attuale non è corretta',
    ca: 'la contrasenya actual no és correcta',
    zh: '当前密码不正确',
  },
  'auth.passwordsRequired': {
    en: 'currentPassword and newPassword required',
    es: 'se requieren currentPassword y newPassword',
    pt: 'currentPassword e newPassword obrigatórios',
    it: 'currentPassword e newPassword obbligatorie',
    ca: 'calen currentPassword i newPassword',
    zh: '需要 currentPassword 和 newPassword',
  },
  'auth.passwordMustDiffer': {
    en: 'new password must differ from the current one',
    es: 'la contraseña nueva debe ser distinta de la actual',
    pt: 'a nova senha deve ser diferente da atual',
    it: 'la nuova password deve essere diversa da quella attuale',
    ca: 'la contrasenya nova ha de ser diferent de l’actual',
    zh: '新密码必须与当前密码不同',
  },
  'auth.invalidOrExpiredToken': {
    en: 'invalid or expired token',
    es: 'token inválido o vencido',
    pt: 'token inválido ou expirado',
    it: 'token non valido o scaduto',
    ca: 'testimoni no vàlid o caducat',
    zh: '令牌无效或已过期',
  },
  'auth.invalidOrExpiredChallenge': {
    en: 'invalid or expired challenge',
    es: 'desafío inválido o vencido',
    pt: 'desafio inválido ou expirado',
    it: 'sfida non valida o scaduta',
    ca: 'repte no vàlid o caducat',
    zh: '质询无效或已过期',
  },
  'totp.invalidCode': {
    en: 'invalid code — try the next one your app shows',
    es: 'código inválido — probá con el siguiente que muestre tu app',
    pt: 'código inválido — tente o próximo que o app mostrar',
    it: 'codice non valido — prova il successivo mostrato dall’app',
    ca: 'codi no vàlid — prova el següent que mostri l’app',
    zh: '验证码无效 — 请尝试应用显示的下一个',
  },
  'totp.notConfigured': {
    en: 'TOTP not configured for this user',
    es: 'este usuario no tiene TOTP configurado',
    pt: 'este utilizador não tem TOTP configurado',
    it: 'questo utente non ha TOTP configurato',
    ca: 'aquest usuari no té TOTP configurat',
    zh: '该用户未配置 TOTP',
  },
  'totp.tooManyCodes': {
    en: 'too many invalid codes — try again later',
    es: 'demasiados códigos inválidos — probá más tarde',
    pt: 'códigos inválidos em excesso — tente mais tarde',
    it: 'troppi codici non validi — riprova più tardi',
    ca: 'massa codis no vàlids — prova-ho més tard',
    zh: '无效验证码过多 — 请稍后再试',
  },
  'mfa.tokenUsed': {
    en: 'mfa token already used — start over',
    es: 'el token de MFA ya se usó — empezá de nuevo',
    pt: 'o token de MFA já foi usado — comece de novo',
    it: 'token MFA già usato — ricomincia',
    ca: 'el testimoni MFA ja s’ha fet servir — torna a començar',
    zh: 'MFA 令牌已使用 — 请重新开始',
  },
  'mfa.tokenExpired': {
    en: 'mfa token expired or invalid — start over',
    es: 'el token de MFA venció o es inválido — empezá de nuevo',
    pt: 'o token de MFA expirou ou é inválido — comece de novo',
    it: 'token MFA scaduto o non valido — ricomincia',
    ca: 'el testimoni MFA ha caducat o no és vàlid — torna a començar',
    zh: 'MFA 令牌已过期或无效 — 请重新开始',
  },
  'note.notFound': {
    en: 'not found',
    es: 'no encontrado',
    pt: 'não encontrado',
    it: 'non trovato',
    ca: 'no s’ha trobat',
    zh: '未找到',
  },
  'note.contentRequired': {
    en: 'content required',
    es: 'se requiere contenido',
    pt: 'conteúdo obrigatório',
    it: 'contenuto obbligatorio',
    ca: 'cal contingut',
    zh: '需要内容',
  },
  'embeddings.configInvalid': {
    en: 'the embedding configuration cannot be used: {reason}',
    es: 'la configuración de embeddings no se puede usar: {reason}',
    pt: 'a configuração de embeddings não pode ser usada: {reason}',
    it: 'la configurazione degli embedding non è utilizzabile: {reason}',
    ca: 'la configuració d’embeddings no es pot fer servir: {reason}',
    zh: '无法使用该嵌入配置：{reason}',
  },
  'note.titleTaken': {
    en: 'a note with this title already exists in this workspace',
    es: 'ya existe una nota con este título en este espacio',
    pt: 'já existe uma nota com este título neste espaço',
    it: 'esiste già una nota con questo titolo in questo spazio',
    ca: 'ja existeix una nota amb aquest títol en aquest espai',
    zh: '此工作区中已存在同名笔记',
  },
  'note.deleteManyRefused': {
    en: 'none of those notes can be deleted with this account',
    es: 'ninguna de esas notas se puede borrar con esta cuenta',
    pt: 'nenhuma dessas notas pode ser excluída com esta conta',
    it: 'nessuna di quelle note è eliminabile con questo account',
    ca: 'cap d’aquestes notes es pot esborrar amb aquest compte',
    zh: '此账户无法删除这些笔记中的任何一条',
  },
  'note.notInTrash': {
    en: 'note is not in trash',
    es: 'la nota no está en la papelera',
    pt: 'a nota não está no lixo',
    it: 'la nota non è nel cestino',
    ca: 'la nota no és a la paperera',
    zh: '该笔记不在回收站中',
  },
  'note.mustBeInTrash': {
    en: 'note must be in trash before purging — delete it first',
    es: 'la nota tiene que estar en la papelera antes de purgarla — borrala primero',
    pt: 'a nota precisa estar no lixo antes de ser purgada — apague-a primeiro',
    it: 'la nota deve essere nel cestino prima di eliminarla definitivamente',
    ca: 'la nota ha de ser a la paperera abans de purgar-la — esborra-la primer',
    zh: '清除前笔记必须在回收站中 — 请先删除',
  },
  'folder.wrongSpace': {
    en: 'folder does not belong to this space',
    es: 'la carpeta no pertenece a este espacio',
    pt: 'a pasta não pertence a este espaço',
    it: 'la cartella non appartiene a questo spazio',
    ca: 'la carpeta no pertany a aquest espai',
    zh: '该文件夹不属于此空间',
  },
  'common.nameRequired': {
    en: 'name required',
    es: 'se requiere el nombre',
    pt: 'nome obrigatório',
    it: 'nome obbligatorio',
    ca: 'cal el nom',
    zh: '需要名称',
  },
  'common.invalidRequest': {
    en: 'invalid request',
    es: 'solicitud inválida',
    pt: 'pedido inválido',
    it: 'richiesta non valida',
    ca: 'sol·licitud no vàlida',
    zh: '请求无效',
  },
  'common.internalError': {
    en: 'internal server error',
    es: 'error interno del servidor',
    pt: 'erro interno do servidor',
    it: 'errore interno del server',
    ca: 'error intern del servidor',
    zh: '服务器内部错误',
  },
  'role.invalid': {
    en: 'invalid role: {role}',
    es: 'rol inválido: {role}',
    pt: 'função inválida: {role}',
    it: 'ruolo non valido: {role}',
    ca: 'rol no vàlid: {role}',
    zh: '角色无效：{role}',
  },
  'org.notFound': {
    en: 'organization not found',
    es: 'organización no encontrada',
    pt: 'organização não encontrada',
    it: 'organizzazione non trovata',
    ca: 'no s’ha trobat l’organització',
    zh: '未找到组织',
  },
  'org.noneCreateFirst': {
    en: 'no organization — create one first',
    es: 'no hay organización — creá una primero',
    pt: 'sem organização — crie uma primeiro',
    it: 'nessuna organizzazione — creane una prima',
    ca: 'no hi ha cap organització — crea’n una primer',
    zh: '没有组织 — 请先创建一个',
  },
  'org.lastSuperAdminRemove': {
    en: 'cannot remove the last super_admin',
    es: 'no se puede quitar al último super_admin',
    pt: 'não é possível remover o último super_admin',
    it: 'non si può rimuovere l’ultimo super_admin',
    ca: 'no es pot treure l’últim super_admin',
    zh: '无法移除最后一位 super_admin',
  },
  'org.lastSuperAdminDemote': {
    en: 'cannot demote the last super_admin',
    es: 'no se puede degradar al último super_admin',
    pt: 'não é possível rebaixar o último super_admin',
    it: 'non si può declassare l’ultimo super_admin',
    ca: 'no es pot degradar l’últim super_admin',
    zh: '无法降级最后一位 super_admin',
  },
  'search.invalidMode': {
    en: 'search mode must be hybrid, keyword or semantic',
    es: 'el modo de búsqueda debe ser hybrid, keyword o semantic',
    pt: 'o modo de pesquisa deve ser hybrid, keyword ou semantic',
    it: 'la modalità di ricerca deve essere hybrid, keyword o semantic',
    ca: 'el mode de cerca ha de ser hybrid, keyword o semantic',
    zh: '搜索模式必须是 hybrid、keyword 或 semantic',
  },
  'search.invalidTopK': {
    en: 'topK must be a whole number between 1 and {max}',
    es: 'topK debe ser un entero entre 1 y {max}',
    pt: 'topK deve ser um inteiro entre 1 e {max}',
    it: 'topK deve essere un intero tra 1 e {max}',
    ca: 'topK ha de ser un enter entre 1 i {max}',
    zh: 'topK 必须是介于 1 和 {max} 之间的整数',
  },
  'mode.serverOnly': {
    en: 'only available in server mode',
    es: 'solo disponible en modo servidor',
    pt: 'disponível apenas no modo servidor',
    it: 'disponibile solo in modalità server',
    ca: 'només disponible en mode servidor',
    zh: '仅在服务器模式下可用',
  },
};

/** Substitute `{name}` placeholders. Values are inserted verbatim. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/**
 * Resolve one error key into a message.
 *
 * An unknown key returns the key itself rather than throwing: a missing
 * translation must never turn a 400 into a 500. It also makes the omission
 * visible in the response instead of silently falling back to something
 * plausible.
 */
export function apiErrorMessage(
  key: string,
  locale: ApiLocale = DEFAULT_API_LOCALE,
  params?: Record<string, string | number>,
): string {
  const entry = API_ERRORS[key];
  if (!entry) return key;
  return interpolate(entry[locale] ?? entry[DEFAULT_API_LOCALE], params);
}
