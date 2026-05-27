// Minimal ESLint flat config for Diluxite. The main job here is the
// "no Spanish identifiers" guard — typecheck + tests already cover
// the bulk of correctness, so we deliberately keep the rule list small
// to avoid lint noise during the v4.0 alpha.
//
// To extend the Spanish-identifier deny list, edit the regex below and
// add the new term. To add an exception for a legit ES word, narrow
// the regex (use `^` and `$` anchors — they're already there).

import tseslint from 'typescript-eslint';

const FORBIDDEN_SPANISH_IDENTIFIERS = [
  // DB tables / collections
  'usuarios',
  'espacios',
  'miembros',
  'notas',
  'carpetas',
  // Type names
  'Nota',
  'Carpeta',
  'Espacio',
  'Usuario',
  'Miembro',
  // Field names (camelCase)
  'espacioId',
  'carpetaId',
  'notaId',
  'usuarioId',
  'padreId',
  'duenoId',
  'contenidoMd',
  'titulo',
  'favorita',
  'proveedor',
  'creado',
  'modificado',
  'notaTags',
  'notaLinks',
  // Repository methods
  'setFavorita',
  'listCarpetas',
  'createCarpeta',
  'renameCarpeta',
  'moveCarpeta',
  'deleteCarpeta',
  'espacioDe',
  // MCP tools (legacy v3 names)
  'buscar_memoria',
  'listar_notas',
  'leer_nota',
  'escribir_nota',
  'listar_espacios',
  'listar_tags',
  'buscar_por_tag',
  'notas_recientes',
  'backlinks_de',
  'agregar_a_nota',
];

const spanishIdentifierGuard = {
  selector: `Identifier[name=/^(${FORBIDDEN_SPANISH_IDENTIFIERS.join('|')})$/]`,
  message:
    'Spanish identifier detected — use the English equivalent (see SPANISH_INVENTORY.md). ' +
    'Diluxite code is English-only from v4.0; UI strings live in apps/web/src/locales/.',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/db/migrations/**',
      'pnpm-lock.yaml',
      'SPANISH_INVENTORY.md',
      'CHANGELOG.md',
      '**/*.md',
      '**/*.json',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // Tactical: keep noise low — typecheck already covers correctness.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'prefer-const': 'off',
      // Strategic: the guard we actually care about.
      'no-restricted-syntax': ['error', spanishIdentifierGuard],
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
);
