import { config } from '@fissionplane/console-api/config'
import { server } from '@fissionplane/console-api/server'

server.listen(config.port, () => {
  console.info(`console-api listening on ${config.baseUrl}`)
})
