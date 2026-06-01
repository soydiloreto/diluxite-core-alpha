import { userColorTokens } from './userColor';

/**
 * Renders the avatars of all users currently connected to a collaborative
 * document. Drives the "who's here" indicator next to the note title.
 *
 * Each item carries an identity (id or email — anything stable per user) and
 * a display name. The color is derived deterministically from the identity
 * so it matches the caret color the user sees in the editor.
 *
 * The component is purely visual — the actual collection of users comes from
 * the Yjs awareness state, polled from `HocuspocusProvider.awareness.states`
 * in the parent.
 */

export interface PresenceUser {
  /** Stable id used for the color hash. */
  identity: string;
  /** Display name shown in the tooltip + initials. */
  name: string;
  /** Whether this entry represents the local user (rendered first + dimmer). */
  isSelf?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function PresenceAvatars({
  users,
  max = 5,
}: {
  users: PresenceUser[];
  max?: number;
}) {
  if (users.length === 0) return null;
  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;

  return (
    <div
      data-testid="presence-avatars"
      className="flex items-center -space-x-1.5"
      aria-label={`${users.length} usuarios viendo esta nota`}
    >
      {shown.map((u) => {
        const tokens = userColorTokens(u.identity);
        return (
          <span
            key={u.identity}
            title={u.isSelf ? `${u.name} (vos)` : u.name}
            data-self={u.isSelf ? 'true' : undefined}
            className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium border border-bg shadow-sm select-none"
            style={{
              backgroundColor: tokens.caret,
              color: tokens.label,
              opacity: u.isSelf ? 0.7 : 1,
            }}
          >
            {initials(u.name)}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium bg-bg-surface text-ink border border-line shadow-sm"
          title={`+${overflow} más`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
