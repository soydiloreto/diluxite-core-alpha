import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';

interface PromptOpts {
  placeholder?: string;
  defaultValue?: string;
  okLabel?: string;
}
interface ConfirmOpts {
  message?: string;
  danger?: boolean;
  okLabel?: string;
}

interface DialogsApi {
  prompt(title: string, opts?: PromptOpts): Promise<string | null>;
  confirm(title: string, opts?: ConfirmOpts): Promise<boolean>;
}

const Ctx = createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDialogs must be used inside <DialogProvider>');
  return v;
}

type State =
  | {
      kind: 'prompt';
      title: string;
      placeholder?: string;
      defaultValue: string;
      okLabel: string;
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      danger: boolean;
      okLabel: string;
      resolve: (v: boolean) => void;
    }
  | null;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [value, setValue] = useState('');

  const api: DialogsApi = {
    prompt(title, opts) {
      return new Promise((resolve) => {
        setValue(opts?.defaultValue ?? '');
        setState({
          kind: 'prompt',
          title,
          placeholder: opts?.placeholder,
          defaultValue: opts?.defaultValue ?? '',
          okLabel: opts?.okLabel ?? 'OK',
          resolve,
        });
      });
    },
    confirm(title, opts) {
      return new Promise((resolve) => {
        setState({
          kind: 'confirm',
          title,
          message: opts?.message ?? '',
          danger: !!opts?.danger,
          okLabel: opts?.okLabel ?? (opts?.danger ? 'Delete' : 'OK'),
          resolve,
        });
      });
    },
  };

  const close = useCallback(
    (v: string | null | boolean) => {
      if (!state) return;
      if (state.kind === 'prompt') state.resolve(v as string | null);
      else state.resolve(v as boolean);
      setState(null);
    },
    [state],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {state?.kind === 'prompt' && (
        <Modal open onClose={() => close(null)} title={state.title} size="md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              close(value.trim() || null);
            }}
            className="p-4 flex flex-col gap-3"
            data-testid="prompt-dialog"
          >
            <Input
              autoFocus
              aria-label="dialog input"
              placeholder={state.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => close(null)}>
                Cancel
              </Button>
              <Button type="submit">{state.okLabel}</Button>
            </div>
          </form>
        </Modal>
      )}
      {state?.kind === 'confirm' && (
        <Modal open onClose={() => close(false)} title={state.title} size="md">
          <div className="p-4 flex flex-col gap-4" data-testid="confirm-dialog">
            {state.message && <p className="text-sm text-ink">{state.message}</p>}
            <div className="flex justify-end gap-2">
              {/* autoFocus pulls focus off the element that opened the dialog —
                  otherwise an Enter keypress re-triggers that button and the
                  confirm Promise is left dangling. */}
              <Button autoFocus variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant={state.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                {state.okLabel}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}
