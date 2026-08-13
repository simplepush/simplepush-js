export class SimplepushError extends Error {
  override readonly name: string = "SimplepushError";
}

export class MissingApiTokenError extends SimplepushError {
  override readonly name = "MissingApiTokenError";
  constructor() {
    super("missing credential: pass `apiToken` (or `accessToken`), or set $SP_API_TOKEN");
  }
}

export class InvalidBaseUrlError extends SimplepushError {
  override readonly name = "InvalidBaseUrlError";
  constructor(value: string, cause: unknown) {
    super(`invalid base URL \`${value}\`: ${String(cause)}`);
  }
}

export class WebSocketClosedError extends SimplepushError {
  override readonly name = "WebSocketClosedError";
  constructor(reason: string) {
    super(`server closed the websocket: ${reason}`);
  }
}

export class DownloadError extends SimplepushError {
  override readonly name = "DownloadError";
  constructor(
    message: string,
    /** Set when an HTTP layer rejected the request (presign or S3 GET). */
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class HttpError extends SimplepushError {
  override readonly name = "HttpError";
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${method} ${path} failed with status ${status}: ${body}`);
  }
}
