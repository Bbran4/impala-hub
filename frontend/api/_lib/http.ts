export type ApiRequest = {
  method?: string;
  headers: {
    authorization?: string | string[];
    Authorization?: string | string[];
  };
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};
export type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => unknown;
  redirect: (url: string) => unknown;
};
export type ApiHandler = (
  req: ApiRequest,
  res: ApiResponse,
) => unknown | Promise<unknown>;
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
export function bearerToken(req: ApiRequest) {
  const header = req.headers.authorization ?? req.headers.Authorization;
  return typeof header === "string" && /^Bearer\s+/i.test(header)
    ? header.replace(/^Bearer\s+/i, "").trim()
    : "";
}
export function requireMethod(req: ApiRequest, methods: readonly string[]) {
  if (!req.method || !methods.includes(req.method))
    throw new HttpError(405, "Method not allowed");
}
export function withApiErrors(handler: ApiHandler): ApiHandler {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      // Do not send SDK/network exception text: it may contain provider tokens.
      const known = error instanceof HttpError;
      return res
        .status(known ? error.status : 500)
        .json({
          detail: known
            ? error.message
            : "The server request could not be completed.",
        });
    }
  };
}
