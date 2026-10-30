export type WorkspaceProps = {
  page: string;
  token: string;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
};
