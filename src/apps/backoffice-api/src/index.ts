import { config } from '@fissionplane/backoffice-api/config'
import { server } from '@fissionplane/backoffice-api/server'

server.listen(config.port, () => {
  console.info(`backoffice listening on ${config.baseUrl}`)
})
