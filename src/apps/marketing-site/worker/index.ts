const MINTLIFY_HOST = 'opensandbox-4ac929f1.mintlify.site'
const PUBLIC_HOST = 'fissionplane.dev'

function isMintlifyPath(pathname: string): boolean {
  return (
    pathname === '/docs' ||
    pathname.startsWith('/docs/') ||
    pathname.startsWith('/mintlify-assets/') ||
    pathname.startsWith('/_mintlify/')
  )
}

async function proxyMintlify(request: Request): Promise<Response> {
  const upstreamUrl = new URL(request.url)
  upstreamUrl.hostname = MINTLIFY_HOST
  upstreamUrl.protocol = 'https:'
  upstreamUrl.port = ''

  const upstreamRequest = new Request(upstreamUrl, request)
  upstreamRequest.headers.set('Host', MINTLIFY_HOST)
  upstreamRequest.headers.set('X-Forwarded-Host', PUBLIC_HOST)
  upstreamRequest.headers.set('X-Forwarded-Proto', 'https')

  return await fetch(upstreamRequest)
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (!isMintlifyPath(url.pathname)) {
      return await env.ASSETS.fetch(request)
    }

    try {
      return await proxyMintlify(request)
    } catch (error: unknown) {
      console.error('Mintlify proxy request failed', {
        error: error instanceof Error ? error.message : String(error),
        pathname: url.pathname,
      })
      return new Response('Documentation is temporarily unavailable.', {
        status: 502,
      })
    }
  },
} satisfies ExportedHandler<Env>
