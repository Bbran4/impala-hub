export type PlatformCallbacks = {
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  setPage: (page: string) => void;
};
export type ReportingAccess = {
  admin: boolean;
  builder: boolean;
  catalogue: boolean;
  apps: number;
};
