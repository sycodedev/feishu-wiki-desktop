export interface TabState {
  id: number;
  title: string;
  url: string;
  kind: 'home' | 'page';
  loading: boolean;
  error: string | null;
}

export interface DesktopState {
  tabs: TabState[];
  activeId: number;
  canGoBack: boolean;
  canGoForward: boolean;
  online: boolean;
  busy: boolean;
  notice: string;
  download: string;
}

export type Action =
  | { type: 'new-tab' | 'wiki-home' | 'back' | 'forward' | 'reload' | 'copy-link' | 'open-browser' | 'logout' }
  | { type: 'open'; url: string }
  | { type: 'activate' | 'close-tab'; id: number }
  | { type: 'online'; value: boolean }
  | { type: 'layout'; x: number; y: number; width: number; height: number };

export interface DesktopBridge {
  getState(): Promise<DesktopState>;
  perform(action: Action): Promise<void>;
  onState(listener: (state: DesktopState) => void): () => void;
  onFocusAddress(listener: () => void): () => void;
}
