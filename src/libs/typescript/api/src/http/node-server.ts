import { Blob } from 'node:buffer'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { domainErrorPayload } from '@fissionplane/api/http/error-response'
import { InternalError } from '@fissionplane/core/ddd/base-error'

const internalError = domainErrorPayload(InternalError, new InternalError({}))

export interface WebHandler {
  readonly dispose: () => Promise<void>
  readonly handler: (request: Request) => Promise<Response>
}

export interface NodeServerOptions {
  readonly api: WebHandler
  readonly auth: (request: Request) => Promise<Response>
  readonly authPath?: string
  readonly authorizeApi?: (
    request: Request,
  ) => Promise<Request | Response | undefined>
  readonly name: string
  readonly port: number
}

const toHeaders = (incoming: IncomingHttpHeaders): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (typeof value === 'string') {
      headers.set(name, value)
    } else if (value !== undefined) {
      for (const item of value) {
        headers.append(name, item)
      }
    }
  }
  return headers
}

const readBody = async (
  request: IncomingMessage,
): Promise<Blob | undefined> => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  const parts: Array<string | Uint8Array> = []
  for await (const part of request) {
    parts.push(typeof part === 'string' ? part : new Uint8Array(part))
  }
  return parts.length === 0 ? undefined : new Blob(parts)
}

const toWebRequest = async (
  request: IncomingMessage,
  port: number,
): Promise<Request> => {
  const host = request.headers.host ?? `localhost:${port}`
  return new Request(`http://${host}${request.url ?? '/'}`, {
    body: await readBody(request),
    headers: toHeaders(request.headers),
    method: request.method,
  })
}

const writeWebResponse = async (
  response: Response,
  target: ServerResponse,
): Promise<void> => {
  // `Headers.entries()` joins repeated headers with a comma, which corrupts
  // `Set-Cookie` because cookie attributes such as `Expires` contain commas.
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of response.headers.entries()) {
    if (name !== 'set-cookie') {
      headers[name] = value
    }
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies
  }

  target.writeHead(response.status, response.statusText, headers)
  target.end(Buffer.from(await response.arrayBuffer()))
}

export const createNodeServer = ({
  api,
  auth,
  authPath = '/api/auth/',
  authorizeApi,
  name,
  port,
}: NodeServerOptions): Server => {
  const server = createServer((request, response) => {
    const handle = async (): Promise<void> => {
      const webRequest = await toWebRequest(request, port)
      const isAuthRequest = new URL(webRequest.url).pathname.startsWith(
        authPath,
      )
      const authorization = isAuthRequest
        ? undefined
        : await authorizeApi?.(webRequest)
      const unauthorized =
        authorization instanceof Response ? authorization : undefined
      const apiRequest =
        authorization instanceof Request ? authorization : webRequest
      const webResponse = isAuthRequest
        ? await auth(webRequest)
        : (unauthorized ?? (await api.handler(apiRequest)))
      await writeWebResponse(webResponse, response)
    }

    handle().catch((error: unknown) => {
      console.error(`${name} request failed`, { error })
      if (!response.headersSent) {
        response.writeHead(internalError.status, {
          'content-type': 'application/json',
        })
      }
      response.end(internalError.body)
    })
  })

  server.on('close', () => {
    void api.dispose()
  })

  return server
}
